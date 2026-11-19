// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP at /mcp.
//
// Both protocol eras are served: the 2026-07-28 revision (server/discover, no handshake)
// and the initialize handshake era (2025-11-25 and friends). Tools map onto the same
// store as REST, so an object created here is the same object there. The tools list is a
// module-level constant, so two tools/list answers are byte-identical.

import {
  Forge,
  HttpError,
  VIEWER,
  createIssue,
  createPull,
  issueJson,
  mergePull,
  pullJson,
  repoJson,
} from './store.ts';
import type { RepoRec } from './store.ts';

export interface HandlerOut {
  status: number;
  text: string;
  contentType: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: true };
}

const OWNER_PROP = { type: 'string', description: 'The repository owner login.' };
const REPO_PROP = { type: 'string', description: 'The repository name.' };

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: objectSchema(
      {
        name: { type: 'string', description: 'The repository name.' },
        owner: OWNER_PROP,
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: objectSchema({ owner: OWNER_PROP, repo: REPO_PROP, full_name: { type: 'string', description: 'The owner/name pair, as an alternative to owner and repo.' } }, ['owner', 'repo']),
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: objectSchema({ owner: OWNER_PROP }, []),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: objectSchema(
      {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to attach.' },
      },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: objectSchema(
      { owner: OWNER_PROP, repo: REPO_PROP, state: { type: 'string', description: 'open, closed or all (default open).' } },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: objectSchema({ owner: OWNER_PROP, repo: REPO_PROP, issue_number: { type: 'number', description: 'The issue number.' } }, ['owner', 'repo', 'issue_number']),
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: objectSchema(
      {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: objectSchema(
      {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        pull_number: { type: 'number', description: 'The pull request number.' },
        merge_method: { type: 'string', description: 'The merge method: squash.' },
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function requireRepo(forge: Forge, args: Record<string, unknown>): RepoRec {
  let owner = argString(args, 'owner');
  let repo = argString(args, 'repo');
  const fullName = argString(args, 'full_name');
  if ((owner === '' || repo === '') && fullName.includes('/')) {
    const [namedOwner, namedRepo] = fullName.split('/', 2);
    if (owner === '') owner = namedOwner;
    if (repo === '') repo = namedRepo;
  }
  if (owner === '') owner = VIEWER.login;
  const found = forge.getRepo(owner, repo);
  if (!found) throw new Error(`repository ${owner}/${repo} not found`);
  return found;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new RpcError(-32602, `Tool not found: ${name}`);
  const required = (tool.inputSchema.required as string[]) ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      throw new RpcError(-32602, `Missing required argument: ${key}`);
    }
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = argString(args, 'name');
        const existing = forge.getRepo(VIEWER.login, repoName);
        if (existing) return toolResult(repoJson(existing));
        const repo = forge.createRepo(
          VIEWER.login,
          repoName,
          typeof args.private === 'boolean' ? args.private : false,
          argString(args, 'description'),
        );
        return toolResult(repoJson(repo));
      }
      case 'get_repo': {
        return toolResult(repoJson(requireRepo(forge, args)));
      }
      case 'list_repos': {
        return toolResult(forge.listRepos(VIEWER.login).map((repo) => repoJson(repo)));
      }
      case 'create_issue': {
        const repo = requireRepo(forge, args);
        const labels = Array.isArray(args.labels) ? args.labels.filter((entry): entry is string => typeof entry === 'string') : [];
        const issue = createIssue(forge, repo, { title: argString(args, 'title'), body: argString(args, 'body'), labels });
        return toolResult(issueJson(repo, issue));
      }
      case 'list_issues': {
        const repo = requireRepo(forge, args);
        const state = argString(args, 'state') || 'open';
        let issues = [...repo.issues.values()];
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        issues.sort((a, b) => b.number - a.number);
        return toolResult(issues.map((issue) => issueJson(repo, issue)));
      }
      case 'get_issue': {
        const repo = requireRepo(forge, args);
        const number = typeof args.issue_number === 'number' ? args.issue_number : Number(args.issue_number);
        const issue = repo.issues.get(number);
        if (!issue) throw new Error(`issue ${number} not found in ${repo.fullName}`);
        return toolResult(issueJson(repo, issue));
      }
      case 'create_pull_request': {
        const repo = requireRepo(forge, args);
        const pull = createPull(forge, repo, {
          title: argString(args, 'title'),
          body: argString(args, 'body'),
          head: argString(args, 'head'),
          base: argString(args, 'base'),
        });
        return toolResult(pullJson(repo, pull));
      }
      case 'merge_pull_request': {
        const repo = requireRepo(forge, args);
        const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
        const pull = repo.pulls.get(number);
        if (!pull) throw new Error(`pull request ${number} not found in ${repo.fullName}`);
        mergePull(repo, pull);
        return toolResult(pullJson(repo, pull));
      }
      default:
        throw new RpcError(-32602, `Tool not found: ${name}`);
    }
  } catch (err) {
    if (err instanceof RpcError) throw err;
    if (err instanceof HttpError) return toolFailure(err.message);
    return toolFailure(err instanceof Error ? err.message : 'tool call failed');
  }
}

function handleOne(forge: Forge, request: Record<string, unknown>): Record<string, unknown> | null {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = 'id' in request ? request.id : undefined;
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined;
  const answer = (result: unknown): Record<string, unknown> | null => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const failure = (code: number, message: string): Record<string, unknown> | null =>
    isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } };

  switch (method) {
    case 'server/discover':
      return answer({
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return answer({ protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return answer({});
    case 'tools/list':
      return answer({ tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      try {
        return answer(callTool(forge, toolName, args));
      } catch (err) {
        if (err instanceof RpcError) return failure(err.code, err.message);
        return failure(-32603, err instanceof Error ? err.message : 'internal error');
      }
    }
    default:
      if (method.startsWith('notifications/')) return null;
      return failure(-32601, `Method not found: ${method}`);
  }
}

export function handleMcp(forge: Forge, raw: Buffer): HandlerOut {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return {
      status: 400,
      text: `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
      contentType: JSON_TYPE,
    };
  }
  if (Array.isArray(parsed)) {
    const answers = parsed
      .map((entry) => (entry !== null && typeof entry === 'object' ? handleOne(forge, entry as Record<string, unknown>) : null))
      .filter((entry) => entry !== null);
    return { status: 200, text: `${JSON.stringify(answers)}\n`, contentType: JSON_TYPE };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return {
      status: 400,
      text: `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } })}\n`,
      contentType: JSON_TYPE,
    };
  }
  const answer = handleOne(forge, parsed as Record<string, unknown>);
  if (answer === null) return { status: 202, text: '', contentType: JSON_TYPE };
  return { status: 200, text: `${JSON.stringify(answer)}\n`, contentType: JSON_TYPE };
}
