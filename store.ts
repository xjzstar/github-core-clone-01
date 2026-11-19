// The forge's state and domain operations, shared by REST, GraphQL, MCP and git HTTP.
// One in-memory store; contents live as real git objects so every surface agrees.
//
// Determinism: every timestamp derives from MAKEFUN_TRIAL_NOW (parsed once at boot),
// ids are sequential counters, and nothing here reads the wall clock or a random source.

import {
  ObjectStore,
  buildCommit,
  buildTreeFromFiles,
  diffTrees,
  flattenTree,
  isAncestor,
  mergeBase,
  mergeTrees,
  parseCommit,
  parseTree,
  peelToCommit,
  type FileChange,
} from './git.ts';

/** The contest's fixed scenario identities (wire.ts's seeded scenario, seed-constant). */
export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const TEAMMATE = { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' };
export const STRANGER = { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' };
export const ORG_LOGIN = 'faint-meadow-org';
export const USERS = [VIEWER, TEAMMATE, STRANGER];

export const INSTALLED_VERSION = '1.0.0';

/** MAKEFUN_TRIAL_NOW as epoch milliseconds (RFC 3339 or epoch-ms text), parsed once. */
export const TRIAL_NOW_MS: number = ((): number => {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  return 1_700_000_000_000;
})();

export function nowIso(): string {
  return new Date(TRIAL_NOW_MS).toISOString();
}

/** The `Name <email> <seconds> +0000` line server-made commits carry. */
export function forgeIdent(): string {
  return `${VIEWER.name} <${VIEWER.email}> ${Math.floor(TRIAL_NOW_MS / 1000)} +0000`;
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
  userLogin: string;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
}

export class RepoRec {
  readonly store = new ObjectStore();
  /** Full ref name (refs/heads/...) -> object id. */
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, LabelRec>();
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber = 1;
  readonly id: number;
  readonly owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  readonly defaultBranch: string;

  constructor(id: number, owner: string, name: string, isPrivate: boolean, description: string, defaultBranch = 'main') {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
    this.defaultBranch = defaultBranch;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  headTarget(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  /** The commit a ref names (branch short name, full ref, tag name or sha), or null. */
  resolveCommit(ref: string | undefined): string | null {
    if (ref === undefined || ref === '') {
      const tip = this.branchTip(this.defaultBranch);
      return tip === null ? null : peelToCommit(this.store, tip);
    }
    const candidates = [
      this.refs.get(ref),
      this.refs.get(`refs/heads/${ref}`),
      this.refs.get(`refs/tags/${ref}`),
    ];
    for (const candidate of candidates) {
      if (candidate) return peelToCommit(this.store, candidate);
    }
    const obj = this.store.get(ref);
    if (obj && obj.type === 'commit') return ref;
    if (obj && obj.type === 'tag') return peelToCommit(this.store, ref);
    return null;
  }

  treeOf(commitOid: string): string | null {
    const obj = this.store.get(commitOid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }
}

export class Forge {
  readonly repos = new Map<string, RepoRec>();
  private nextRepoId = 5000;
  private nextEntityId = 100_000;
  requestSeq = 0;

  entityId(): number {
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    return id;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): RepoRec {
    const key = `${owner}/${name}`;
    const existing = this.repos.get(key);
    if (existing) return existing;
    const repo = new RepoRec(this.nextRepoId, owner, name, isPrivate, description);
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  repoExists(owner: string, name: string): boolean {
    return this.repos.has(`${owner}/${name}`);
  }

  getRepo(owner: string, name: string): RepoRec | null {
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(owner: string): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
  }

  repoById(id: number): RepoRec | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// contents (REST files backed by git objects)
// ---------------------------------------------------------------------------------------------

export interface PathHit {
  kind: 'file' | 'dir';
  oid: string;
  /** For a file: its bytes. For a dir: the listing. */
  data?: Buffer;
  entries?: { name: string; path: string; oid: string; type: 'file' | 'dir'; mode: string }[];
}

/** Resolve `path` inside the tree of `commitOid` (empty path = the root directory). */
export function getPath(repo: RepoRec, commitOid: string, path: string): PathHit | null {
  const treeOid = repo.treeOf(commitOid);
  if (treeOid === null) return null;
  const segments = path === '' ? [] : path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let depth = 0; depth < segments.length; depth += 1) {
    const obj = repo.store.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === segments[depth]);
    if (!entry) return null;
    if (depth === segments.length - 1) {
      if (entry.mode === '40000') {
        return { kind: 'dir', oid: entry.oid, entries: listDir(repo, entry.oid, path) };
      }
      const blob = repo.store.get(entry.oid);
      if (!blob) return null;
      return { kind: 'file', oid: entry.oid, data: blob.data };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return { kind: 'dir', oid: current, entries: listDir(repo, current, '') };
}

function listDir(repo: RepoRec, treeOid: string, prefix: string): NonNullable<PathHit['entries']> {
  const obj = repo.store.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data).map((entry) => ({
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    oid: entry.oid,
    type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
    mode: entry.mode,
  }));
}

/** Commit a new tree on a branch, creating the commit with the forge identity. */
export function commitOnBranch(repo: RepoRec, branch: string, treeOid: string, message: string, parents?: string[]): string {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const parentList = parents ?? (tip ? [tip] : []);
  const ident = forgeIdent();
  const commit = buildCommit({ tree: treeOid, parents: parentList, author: ident, committer: ident, message });
  const oid = repo.store.put('commit', commit);
  repo.refs.set(ref, oid);
  return oid;
}

/**
 * Create or replace one file on a branch through the contents rules: a create is 201, an
 * update 200, a stale `sha` 409. A branch that does not exist yet starts from the default
 * branch's tip (or as a root commit in an empty repository).
 */
export function putFile(
  repo: RepoRec,
  options: { branch?: string; path: string; content: Buffer; message: string; sha?: string },
): { status: 200 | 201; blobOid: string; commitOid: string } {
  const branch = options.branch ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref) ?? null;
  if (tip === null && branch !== repo.defaultBranch) {
    tip = repo.refs.get(repo.headTarget()) ?? null;
  }
  const files = tip ? flattenTree(repo.store, repo.treeOf(peelToCommit(repo.store, tip)) ?? '') : new Map<string, { oid: string; mode: string }>();
  const existing = files.get(options.path);
  if (existing && options.sha !== undefined && options.sha !== existing.oid) {
    throw new HttpError(409, `The sha of ${options.path} does not match the current version`);
  }
  if (!existing && options.sha !== undefined) {
    throw new HttpError(404, `The file ${options.path} does not exist`);
  }
  const blobOid = repo.store.put('blob', options.content);
  files.set(options.path, { oid: blobOid, mode: existing?.mode ?? '100644' });
  const treeOid = buildTreeFromFiles(repo.store, files);
  const commitOid = commitOnBranch(repo, branch, treeOid, options.message, tip ? [peelToCommit(repo.store, tip)] : []);
  return { status: existing ? 200 : 201, blobOid, commitOid };
}

/** Remove one file on a branch with a commit; 404 when the file is not there. */
export function deleteFile(
  repo: RepoRec,
  options: { branch?: string; path: string; message: string; sha?: string },
): { commitOid: string } {
  const branch = options.branch ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  if (tip === null) throw new HttpError(404, 'Not Found');
  const commit = peelToCommit(repo.store, tip);
  const files = flattenTree(repo.store, repo.treeOf(commit) ?? '');
  const existing = files.get(options.path);
  if (!existing) throw new HttpError(404, 'Not Found');
  if (options.sha !== undefined && options.sha !== existing.oid) {
    throw new HttpError(409, `The sha of ${options.path} does not match the current version`);
  }
  files.delete(options.path);
  const treeOid = buildTreeFromFiles(repo.store, files);
  const commitOid = commitOnBranch(repo, branch, treeOid, options.message, [commit]);
  return { commitOid };
}

// ---------------------------------------------------------------------------------------------
// issues and pull requests
// ---------------------------------------------------------------------------------------------

export function createIssue(forge: Forge, repo: RepoRec, input: { title: string; body?: string; labels?: string[] }): IssueRec {
  const labelNames = input.labels ?? [];
  for (const name of labelNames) {
    if (!repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label "${name}" does not exist in ${repo.fullName}`);
  }
  const issue: IssueRec = {
    id: forge.entityId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labelNames],
    comments: [],
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

export function createPull(forge: Forge, repo: RepoRec, input: { title: string; body?: string; head: string; base: string }): PullRec {
  const head = stripOwnerPrefix(input.head);
  const base = stripOwnerPrefix(input.base);
  if (!repo.branchTip(head)) throw new HttpError(422, `Validation Failed: head branch "${head}" does not exist`);
  if (!repo.branchTip(base)) throw new HttpError(422, `Validation Failed: base branch "${base}" does not exist`);
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      throw new HttpError(422, `Validation Failed: a pull request already exists for ${head} into ${base}`);
    }
  }
  const pull: PullRec = {
    id: forge.entityId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** The merge-base commit of a pull request's current head and base tips. */
export function pullMergeBase(repo: RepoRec, pull: PullRec): string | null {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (!headTip || !baseTip) return null;
  return mergeBase(repo.store, peelToCommit(repo.store, baseTip), peelToCommit(repo.store, headTip));
}

/** File changes of a pull request: merge-base tree versus head tree. */
export function pullChanges(repo: RepoRec, pull: PullRec): FileChange[] {
  const headTip = repo.branchTip(pull.headRef);
  if (!headTip) return [];
  const base = pullMergeBase(repo, pull);
  const baseTree = base ? repo.treeOf(base) : null;
  const headTree = repo.treeOf(peelToCommit(repo.store, headTip));
  return diffTrees(repo.store, baseTree, headTree);
}

/** Would merging this pull request right now be clean? */
export function pullMergeable(repo: RepoRec, pull: PullRec): boolean {
  if (pull.merged || pull.state !== 'open') return false;
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (!headTip || !baseTip) return false;
  const baseCommit = peelToCommit(repo.store, baseTip);
  const headCommit = peelToCommit(repo.store, headTip);
  if (isAncestor(repo.store, headCommit, baseCommit)) return true; // already up to date
  const base = mergeBase(repo.store, baseCommit, headCommit);
  const result = mergeTrees(repo.store, base ? repo.treeOf(base) : null, repo.treeOf(baseCommit) ?? '', repo.treeOf(headCommit) ?? '');
  return 'tree' in result;
}

/**
 * Squash-merge a pull request onto its base branch: one commit whose tree is the
 * three-way merge and whose parent is the base tip. Throws HttpError 405 on conflict.
 */
export function mergePull(repo: RepoRec, pull: PullRec): { sha: string } {
  if (pull.merged) throw new HttpError(405, 'Pull Request is not mergeable');
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (!headTip || !baseTip) throw new HttpError(405, 'Pull Request is not mergeable');
  const baseCommit = peelToCommit(repo.store, baseTip);
  const headCommit = peelToCommit(repo.store, headTip);
  let treeOid: string;
  if (isAncestor(repo.store, headCommit, baseCommit)) {
    treeOid = repo.treeOf(baseCommit) ?? '';
  } else {
    const base = mergeBase(repo.store, baseCommit, headCommit);
    const result = mergeTrees(repo.store, base ? repo.treeOf(base) : null, repo.treeOf(baseCommit) ?? '', repo.treeOf(headCommit) ?? '');
    if ('conflicts' in result) throw new HttpError(405, 'Pull Request is not mergeable');
    treeOid = result.tree;
  }
  const message = pull.body ? `${pull.title}\n\n${pull.body}\n` : `${pull.title}\n`;
  const sha = commitOnBranch(repo, pull.baseRef, treeOid, message, [baseCommit]);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
  return { sha };
}

// ---------------------------------------------------------------------------------------------
// JSON shapes shared by REST and MCP
// ---------------------------------------------------------------------------------------------

export function userJson(login: string): Record<string, unknown> {
  const user = USERS.find((candidate) => candidate.login === login) ?? VIEWER;
  return { login: user.login, id: user.id, type: 'User', site_admin: false };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    owner: userJson(repo.owner),
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: nowIso(),
    updated_at: nowIso(),
    pushed_at: nowIso(),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

export function labelJson(label: LabelRec): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { id: 0, name, color: 'ededed', description: '', default: false };
    }),
    user: userJson(VIEWER.login),
    comments: issue.comments.length,
    created_at: nowIso(),
    updated_at: nowIso(),
    closed_at: issue.state === 'closed' ? nowIso() : null,
  };
}

export function commentJson(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: userJson(comment.userLogin),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(VIEWER.login),
    head: {
      ref: pull.headRef,
      sha: headTip ?? '',
      label: `${repo.owner}:${pull.headRef}`,
      user: userJson(repo.owner),
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: baseTip ?? '',
      label: `${repo.owner}:${pull.baseRef}`,
      user: userJson(repo.owner),
      repo: repoJson(repo),
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? pullMergeable(repo, pull) : null,
    mergeable_state: pull.state === 'open' ? (pullMergeable(repo, pull) ? 'clean' : 'dirty') : 'unknown',
    draft: false,
    created_at: nowIso(),
    updated_at: nowIso(),
    closed_at: pull.state === 'closed' ? nowIso() : null,
  };
}

/** Line counts for one changed file (LCS over lines; files in this forge are small). */
export function lineCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  const oldLines = oldText === null || oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === null || newText === '' ? [] : newText.split('\n');
  // A trailing newline terminates the last line rather than starting a new one.
  if (oldLines.length && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
  if (oldLines.length * newLines.length > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const lcs = new Array<number>(newLines.length + 1).fill(0);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    let diagonal = 0;
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      const above = lcs[j];
      if (oldLines[i] === newLines[j]) lcs[j] = diagonal + 1;
      else lcs[j] = Math.max(lcs[j], lcs[j + 1]);
      diagonal = above;
    }
  }
  const common = lcs[0];
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}
