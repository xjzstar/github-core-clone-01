// The GraphQL v4 surface: a small purpose-built parser and evaluator for the documents
// gh and github-mcp-server send — viewer, repository reads, issue/pull-request
// connections with cursor pagination, introspection (__type), node(id:), batched
// operations and the five mutations. No libraries; the schema is the tables below.
//
// Global ids are opaque and stable: base64url of `<Type>:<key>`, never the bare number.

import {
  Forge,
  HttpError,
  VIEWER,
  createIssue,
  createPull,
  lineCounts,
  mergePull,
  nowIso,
  pullChanges,
  pullMergeable,
} from './store.ts';
import type { IssueRec, PullRec, RepoRec } from './store.ts';
import type { HandlerOut } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

// ---------------------------------------------------------------------------------------------
// tokenizer and parser
// ---------------------------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (source.startsWith('...', at)) {
      tokens.push({ kind: 'spread', value: '...' });
      at += 3;
      continue;
    }
    if ('{}()[]:=@$!|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(at + 3, end) });
        at = end + 3;
        continue;
      }
      let value = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\') {
          const esc = source[at + 1];
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(at + 2, at + 6), 16));
            at += 6;
          } else {
            value += escapes[esc] ?? esc;
            at += 2;
          }
        } else {
          value += source[at];
          at += 1;
        }
      }
      if (at >= source.length) throw new Error('unterminated string');
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(at));
      if (!match) throw new Error('bad number');
      tokens.push({ kind: match[0].includes('.') || /[eE]/.test(match[0]) ? 'float' : 'int', value: match[0] });
      at += match[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(at));
      tokens.push({ kind: 'name', value: match![0] });
      at += match![0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: Value }[];
  selectionSet: Selection[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selectionSet: Selection[];
}

type Selection = FieldNode | FragmentNode;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: Selection[];
}

class Parser {
  private at = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at];
    if (!token) throw new Error('unexpected end of document');
    this.at += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, saw ${token.value}`);
  }

  private skipDirectives(): void {
    while (this.peek()?.value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek()?.value === '(') this.parseArguments();
    }
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.at < this.tokens.length) {
      const token = this.peek();
      if (!token) break;
      if (token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = token.value;
        this.next();
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        if (this.peek()?.value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type, name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        // Named fragments are not used by the suite's documents; parse and drop.
        this.next();
        this.next();
        this.expect('on');
        this.next();
        this.skipDirectives();
        this.parseSelectionSet();
        continue;
      }
      throw new Error(`unexpected token ${token.value}`);
    }
    return operations;
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek()?.value !== ')') {
      this.expect('$');
      this.next(); // the variable name
      this.expect(':');
      this.parseType();
      if (this.peek()?.value === '=') {
        this.next();
        this.parseValue();
      }
      this.skipDirectives();
    }
    this.expect(')');
  }

  private parseType(): void {
    const token = this.next();
    if (token.value === '[') {
      this.parseType();
      this.expect(']');
    }
    if (this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek()?.value !== '}') {
      const token = this.peek();
      if (!token) throw new Error('unterminated selection set');
      if (token.kind === 'spread') {
        this.next();
        const on = this.next();
        if (on.value !== 'on') throw new Error('named fragment spreads are not supported');
        const typeCondition = this.next().value;
        this.skipDirectives();
        selections.push({ kind: 'fragment', typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      selections.push(this.parseField());
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next().value;
    let alias: string | null = null;
    if (this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args = this.peek()?.value === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selectionSet = this.peek()?.value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): { name: string; value: Value }[] {
    this.expect('(');
    const args: { name: string; value: Value }[] = [];
    while (this.peek()?.value !== ')') {
      const name = this.next().value;
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expect(')');
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.value === '$') return { kind: 'var', name: this.next().value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.value === '[') {
      const items: Value[] = [];
      while (this.peek()?.value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token.value === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (this.peek()?.value !== '}') {
        const name = this.next().value;
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------------------------------------
// schema tables (introspection + validation)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename'],
  User: ['id', 'login', 'name', 'email', 'url', '__typename'],
  Organization: ['id', 'login', 'name', '__typename'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasPullRequestsEnabled', 'isPrivate', 'description', 'issue', 'issues',
    'pullRequest', 'pullRequests', 'url', 'createdAt', 'updatedAt', 'stargazerCount', 'forkCount',
    '__typename',
  ],
  Ref: ['name', 'prefix', 'target', '__typename'],
  Commit: ['oid', 'message', 'messageHeadline', 'committedDate', 'authoredDate', '__typename'],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt',
    'updatedAt', 'closed', 'closedAt', 'url', '__typename',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'author', 'createdAt', 'updatedAt', 'closed', 'url', 'mergeCommit',
    'additions', 'deletions', 'changedFiles', '__typename',
  ],
  Label: ['id', 'name', 'color', 'description', '__typename'],
  Comment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url', '__typename'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  LabelConnection: ['nodes', 'pageInfo', 'totalCount', '__typename'],
  IssueCommentConnection: ['nodes', 'pageInfo', 'totalCount', '__typename'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType', '__typename'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename'],
  CreateIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CloseIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId', '__typename'],
  CommentEdge: ['node', 'cursor', '__typename'],
  Edge: ['node', 'cursor', '__typename'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL', '__typename'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason', '__typename'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason', '__typename'],
  __InputValue: ['name', 'description', 'type', 'defaultValue', '__typename'],
  __Schema: ['types', 'queryType', 'mutationType', 'directives', '__typename'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestChangedFileChangeType: ['ADDED', 'MODIFIED', 'DELETED'],
};

const TYPE_KIND: Record<string, string> = {
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
  RepositoryPermission: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
  PullRequestChangedFileChangeType: 'ENUM',
  Node: 'INTERFACE',
};

// ---------------------------------------------------------------------------------------------
// runtime values
// ---------------------------------------------------------------------------------------------

interface Tagged {
  __typename: string;
  data: Record<string, unknown>;
}

function tag(typename: string, data: Record<string, unknown>): Tagged {
  return { __typename: typename, data };
}

function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon === -1) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

class GqlError extends Error {}

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function resolveValue(value: Value, ctx: Ctx): unknown {
  switch (value.kind) {
    case 'var':
      return ctx.variables[value.name];
    case 'string':
    case 'enum':
      return value.value;
    case 'int':
    case 'float':
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx);
  return out;
}

function userTag(login: string): Tagged {
  return tag('User', { login });
}

function repoTag(repo: RepoRec): Tagged {
  return tag('Repository', { repo });
}

function issueTag(repo: RepoRec, issue: IssueRec): Tagged {
  return tag('Issue', { repo, issue });
}

function pullTag(repo: RepoRec, pull: PullRec): Tagged {
  return tag('PullRequest', { repo, pull });
}

/** A Relay-style window over an ordered list: applies first/after, returns nodes + pageInfo. */
function window<T>(items: T[], args: Record<string, unknown>, cursorOf: (item: T) => string): { nodes: T[]; pageInfo: Tagged } {
  let start = 0;
  const after = typeof args.after === 'string' ? args.after : null;
  if (after !== null) {
    const index = items.findIndex((item) => cursorOf(item) === after);
    if (index !== -1) start = index + 1;
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  const nodes = items.slice(start, start + first);
  const hasNextPage = start + nodes.length < items.length;
  return {
    nodes,
    pageInfo: tag('PageInfo', {
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: nodes.length ? cursorOf(nodes[0]) : null,
      endCursor: nodes.length ? cursorOf(nodes[nodes.length - 1]) : null,
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// field resolvers
// ---------------------------------------------------------------------------------------------

function resolveField(typename: string, obj: Tagged | null, field: FieldNode, ctx: Ctx): unknown {
  const args = argsOf(field, ctx);
  const forge = ctx.forge;

  if (typename === 'Query') {
    switch (field.name) {
      case 'viewer':
        return userTag(VIEWER.login);
      case 'repository': {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== VIEWER.login) return null;
        const repo = forge.getRepo(owner, name);
        return repo ? repoTag(repo) : null;
      }
      case 'node': {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.type === 'Repository') {
          const repo = forge.repoById(Number(decoded.key));
          return repo ? repoTag(repo) : null;
        }
        if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
          const [repoId, number] = decoded.key.split(':').map(Number);
          const repo = forge.repoById(repoId);
          if (!repo) return null;
          const found = decoded.type === 'Issue' ? repo.issues.get(number) : repo.pulls.get(number);
          if (!found) return null;
          return decoded.type === 'Issue' ? issueTag(repo, found as IssueRec) : pullTag(repo, found as PullRec);
        }
        if (decoded.type === 'User') return userTag(VIEWER.login);
        return null;
      }
      case '__type': {
        const name = String(args.name ?? '');
        if (TYPE_FIELDS[name] || ENUM_VALUES[name] || TYPE_KIND[name] || name === 'Node') return tag('__Type', { name });
        return null;
      }
      case '__schema':
        return tag('__Schema', {});
      default:
        return null;
    }
  }

  if (typename === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    switch (field.name) {
      case 'createIssue': {
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = decoded && decoded.type === 'Repository' ? forge.repoById(Number(decoded.key)) : null;
        if (!repo) throw new GqlError('repository not found for createIssue');
        const issue = createIssue(forge, repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
        return tag('CreateIssuePayload', { issue: issueTag(repo, issue) });
      }
      case 'closeIssue': {
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        if (!decoded || decoded.type !== 'Issue') throw new GqlError('issue not found for closeIssue');
        const [repoId, number] = decoded.key.split(':').map(Number);
        const repo = forge.repoById(repoId);
        const issue = repo?.issues.get(number);
        if (!repo || !issue) throw new GqlError('issue not found for closeIssue');
        issue.state = 'closed';
        return tag('CloseIssuePayload', { issue: issueTag(repo, issue) });
      }
      case 'createPullRequest': {
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = decoded && decoded.type === 'Repository' ? forge.repoById(Number(decoded.key)) : null;
        if (!repo) throw new GqlError('repository not found for createPullRequest');
        try {
          const pull = createPull(forge, repo, {
            title: String(input.title ?? ''),
            body: String(input.body ?? ''),
            head: String(input.headRefName ?? ''),
            base: String(input.baseRefName ?? ''),
          });
          return tag('CreatePullRequestPayload', { pullRequest: pullTag(repo, pull) });
        } catch (err) {
          throw new GqlError(err instanceof Error ? err.message : 'createPullRequest failed');
        }
      }
      case 'mergePullRequest': {
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        if (!decoded || decoded.type !== 'PullRequest') throw new GqlError('pull request not found for mergePullRequest');
        const [repoId, number] = decoded.key.split(':').map(Number);
        const repo = forge.repoById(repoId);
        const pull = repo?.pulls.get(number);
        if (!repo || !pull) throw new GqlError('pull request not found for mergePullRequest');
        try {
          mergePull(repo, pull);
        } catch (err) {
          throw new GqlError(err instanceof Error ? err.message : 'mergePullRequest failed');
        }
        return tag('MergePullRequestPayload', { pullRequest: pullTag(repo, pull) });
      }
      case 'addComment': {
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        if (!decoded || decoded.type !== 'Issue') throw new GqlError('subject not found for addComment');
        const [repoId, number] = decoded.key.split(':').map(Number);
        const repo = forge.repoById(repoId);
        const issue = repo?.issues.get(number);
        if (!repo || !issue) throw new GqlError('subject not found for addComment');
        const comment = { id: forge.entityId(), body: String(input.body ?? ''), userLogin: VIEWER.login };
        issue.comments.push(comment);
        const node = tag('Comment', { repo, issue, comment });
        return tag('AddCommentPayload', { commentEdge: tag('CommentEdge', { node, cursor: globalId('cursor', String(comment.id)) }) });
      }
      default:
        return null;
    }
  }

  if (obj === null) return null;
  const data = obj.data;

  switch (typename) {
    case 'User':
      if (field.name === 'id') return globalId('User', String(VIEWER.id));
      if (field.name === 'login') return data.login;
      if (field.name === 'name') return VIEWER.name;
      if (field.name === 'email') return VIEWER.email;
      if (field.name === 'url') return '';
      return null;
    case 'Repository': {
      const repo = data.repo as RepoRec;
      switch (field.name) {
        case 'id':
          return globalId('Repository', String(repo.id));
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'owner':
          return userTag(repo.owner);
        case 'defaultBranchRef':
          return repo.refs.has(repo.headTarget()) ? tag('Ref', { name: repo.defaultBranch }) : null;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'hasPullRequestsEnabled':
          return true;
        case 'isPrivate':
          return repo.isPrivate;
        case 'description':
          return repo.description;
        case 'url':
          return '';
        case 'createdAt':
        case 'updatedAt':
          return nowIso();
        case 'stargazerCount':
        case 'forkCount':
          return 0;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue ? issueTag(repo, issue) : null;
        }
        case 'issues': {
          let issues = [...repo.issues.values()];
          const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
          if (states) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
          const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
          const direction = String(orderBy.direction ?? 'DESC');
          issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
          const win = window(issues, args, (issue) => globalId('cursor', `issue:${repo.id}:${issue.number}`));
          return tag('IssueConnection', { win, total: issues.length, repo, kind: 'issue' });
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? pullTag(repo, pull) : null;
        }
        case 'pullRequests': {
          let pulls = [...repo.pulls.values()];
          const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
          if (states) {
            pulls = pulls.filter((pull) => {
              const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
              return states.includes(state);
            });
          }
          pulls.sort((a, b) => b.number - a.number);
          const win = window(pulls, args, (pull) => globalId('cursor', `pull:${repo.id}:${pull.number}`));
          return tag('PullRequestConnection', { win, total: pulls.length, repo, kind: 'pull' });
        }
        default:
          return null;
      }
    }
    case 'Ref':
      if (field.name === 'name') return data.name;
      if (field.name === 'prefix') return 'refs/heads/';
      if (field.name === 'target') return null;
      return null;
    case 'Issue': {
      const repo = data.repo as RepoRec;
      const issue = data.issue as IssueRec;
      switch (field.name) {
        case 'id':
          return globalId('Issue', `${repo.id}:${issue.number}`);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state.toUpperCase();
        case 'body':
          return issue.body;
        case 'author':
          return userTag(VIEWER.login);
        case 'labels':
          return tag('LabelConnection', {
            win: window(
              issue.labels.map((name) => repo.labels.get(name)).filter((label) => label !== undefined),
              args,
              (label) => globalId('cursor', `label:${label.id}`),
            ),
            total: issue.labels.length,
            repo,
            kind: 'label',
          });
        case 'comments':
          return tag('IssueCommentConnection', {
            win: window(issue.comments, args, (comment) => globalId('cursor', `comment:${comment.id}`)),
            total: issue.comments.length,
            repo,
            kind: 'comment',
            issue,
          });
        case 'createdAt':
        case 'updatedAt':
          return nowIso();
        case 'closed':
          return issue.state === 'closed';
        case 'closedAt':
          return issue.state === 'closed' ? nowIso() : null;
        case 'url':
          return '';
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const repo = data.repo as RepoRec;
      const pull = data.pull as PullRec;
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', `${repo.id}:${pull.number}`);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.mergedAt;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          if (pull.merged) return 'UNKNOWN';
          return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'files': {
          const changes = pullChanges(repo, pull);
          const win = window(changes, args, (change) => globalId('cursor', `file:${change.path}`));
          return tag('PullRequestChangedFileConnection', { win, total: changes.length, repo, kind: 'file' });
        }
        case 'author':
          return userTag(VIEWER.login);
        case 'createdAt':
        case 'updatedAt':
          return nowIso();
        case 'closed':
          return pull.state === 'closed';
        case 'url':
          return '';
        case 'mergeCommit':
          return pull.mergeCommitSha ? tag('Commit', { oid: pull.mergeCommitSha, repo }) : null;
        case 'additions':
        case 'deletions':
        case 'changedFiles': {
          const changes = pullChanges(repo, pull);
          if (field.name === 'changedFiles') return changes.length;
          let additions = 0;
          let deletions = 0;
          for (const change of changes) {
            const oldText = change.oldOid ? (repo.store.get(change.oldOid)?.data.toString('utf8') ?? '') : null;
            const newText = change.newOid ? (repo.store.get(change.newOid)?.data.toString('utf8') ?? '') : null;
            const counts = lineCounts(oldText, newText);
            additions += counts.additions;
            deletions += counts.deletions;
          }
          return field.name === 'additions' ? additions : deletions;
        }
        default:
          return null;
      }
    }
    case 'PullRequestChangedFile': {
      const repo = data.repo as RepoRec;
      const change = data.change as { path: string; status: string; oldOid: string | null; newOid: string | null };
      if (field.name === 'path') return change.path;
      if (field.name === 'changeType') return change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED';
      if (field.name === 'additions' || field.name === 'deletions') {
        const oldText = change.oldOid ? (repo.store.get(change.oldOid)?.data.toString('utf8') ?? '') : null;
        const newText = change.newOid ? (repo.store.get(change.newOid)?.data.toString('utf8') ?? '') : null;
        const counts = lineCounts(oldText, newText);
        return field.name === 'additions' ? counts.additions : counts.deletions;
      }
      return null;
    }
    case 'Label': {
      const label = data.label as { id: number; name: string; color: string; description: string };
      if (field.name === 'id') return globalId('Label', String(label.id));
      if (field.name === 'name') return label.name;
      if (field.name === 'color') return label.color;
      if (field.name === 'description') return label.description;
      return null;
    }
    case 'Comment': {
      const comment = data.comment as { id: number; body: string; userLogin: string };
      if (field.name === 'id') return globalId('Comment', String(comment.id));
      if (field.name === 'body') return comment.body;
      if (field.name === 'author') return userTag(comment.userLogin);
      if (field.name === 'createdAt' || field.name === 'updatedAt') return nowIso();
      if (field.name === 'url') return '';
      return null;
    }
    case 'Commit':
      if (field.name === 'oid') return data.oid;
      if (field.name === 'message' || field.name === 'messageHeadline') return '';
      if (field.name === 'committedDate' || field.name === 'authoredDate') return nowIso();
      return null;
    case 'PageInfo':
      return (data[field.name] as unknown) ?? null;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      return field.name === 'issue' ? (data.issue as Tagged) : null;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return field.name === 'pullRequest' ? (data.pullRequest as Tagged) : null;
    case 'AddCommentPayload':
      if (field.name === 'commentEdge') return data.commentEdge as Tagged;
      if (field.name === 'subject') return null;
      return null;
    case 'CommentEdge':
    case 'Edge':
      if (field.name === 'node') return data.node as Tagged;
      if (field.name === 'cursor') return data.cursor;
      return null;
    case '__Type': {
      const name = String(data.name);
      switch (field.name) {
        case 'name':
          return name;
        case 'kind':
          return TYPE_KIND[name] ?? 'OBJECT';
        case 'description':
          return null;
        case 'fields':
          return (TYPE_FIELDS[name] ?? []).filter((entry) => entry !== '__typename').map((entry) => tag('__Field', { name: entry }));
        case 'enumValues':
          return (ENUM_VALUES[name] ?? []).map((entry) => tag('__EnumValue', { name: entry }));
        case 'possibleTypes':
          return name === 'Node' ? ['Repository', 'Issue', 'PullRequest', 'User'].map((entry) => tag('__Type', { name: entry })) : null;
        default:
          return null;
      }
    }
    case '__Field':
      if (field.name === 'name') return data.name;
      if (field.name === 'description') return null;
      if (field.name === 'args') return [];
      if (field.name === 'type') return tag('__Type', { name: 'String' });
      if (field.name === 'isDeprecated') return false;
      if (field.name === 'deprecationReason') return null;
      return null;
    case '__EnumValue':
      if (field.name === 'name') return data.name;
      if (field.name === 'description') return null;
      if (field.name === 'isDeprecated') return false;
      if (field.name === 'deprecationReason') return null;
      return null;
    case '__Schema':
      if (field.name === 'queryType') return tag('__Type', { name: 'Query' });
      if (field.name === 'mutationType') return tag('__Type', { name: 'Mutation' });
      if (field.name === 'types') return Object.keys(TYPE_FIELDS).map((name) => tag('__Type', { name }));
      if (field.name === 'directives') return [];
      return null;
    default:
      break;
  }

  // Connection types share their shape: nodes/edges/pageInfo/totalCount over a window.
  if (typename.endsWith('Connection')) {
    const win = data.win as { nodes: unknown[]; pageInfo: Tagged };
    if (field.name === 'pageInfo') return win.pageInfo;
    if (field.name === 'totalCount') return data.total as number;
    if (field.name === 'nodes' || field.name === 'edges') {
      const repo = data.repo as RepoRec;
      const nodes = win.nodes.map((item) => {
        if (data.kind === 'issue') return issueTag(repo, item as IssueRec);
        if (data.kind === 'pull') return pullTag(repo, item as PullRec);
        if (data.kind === 'file') return tag('PullRequestChangedFile', { repo, change: item });
        if (data.kind === 'label') return tag('Label', { label: item });
        if (data.kind === 'comment') return tag('Comment', { repo, issue: data.issue, comment: item });
        return item as Tagged;
      });
      if (field.name === 'nodes') return nodes;
      return nodes.map((node) => tag('Edge', { node, cursor: '' }));
    }
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

function completeValue(value: unknown, field: FieldNode, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (!field.selectionSet) return value;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, field, ctx));
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    const tagged = value as Tagged;
    return executeSet(tagged.__typename, tagged, field.selectionSet, ctx);
  }
  return value;
}

function executeSet(typename: string, obj: Tagged | null, selections: Selection[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (obj && (selection.typeCondition === typename || selection.typeCondition === 'Node')) {
        Object.assign(out, executeSet(typename, obj, selection.selectionSet, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typename;
      continue;
    }
    const known = TYPE_FIELDS[typename];
    if (known && !known.includes(selection.name)) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typename}'` });
      out[key] = null;
      continue;
    }
    try {
      const value = resolveField(typename, obj, selection, ctx);
      out[key] = completeValue(value, selection, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : 'execution error' });
      out[key] = null;
    }
  }
  return out;
}

function executeOne(forge: Forge, body: Record<string, unknown>): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  if (operations.length === 0) return { errors: [{ message: 'no operation in document' }] };
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = (operationName ? operations.find((candidate) => candidate.name === operationName) : undefined) ?? operations[0];
  const ctx: Ctx = { forge, variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSet(rootType, null, operation.selectionSet, ctx);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length) response.errors = ctx.errors;
  return response;
}

export function handleGraphQL(forge: Forge, raw: Buffer): HandlerOut {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, text: `${JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] })}\n`, contentType: JSON_TYPE };
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) =>
      entry !== null && typeof entry === 'object' ? executeOne(forge, entry as Record<string, unknown>) : { errors: [{ message: 'invalid operation' }] },
    );
    return { status: 200, text: `${JSON.stringify(answers)}\n`, contentType: JSON_TYPE };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, text: `${JSON.stringify({ errors: [{ message: 'Invalid request' }] })}\n`, contentType: JSON_TYPE };
  }
  const answer = executeOne(forge, parsed as Record<string, unknown>);
  return { status: 200, text: `${JSON.stringify(answer)}\n`, contentType: JSON_TYPE };
}
