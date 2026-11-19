// The forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP over one store.
//
// Routing order: /healthz (the env's boot probe, no auth), then the four surfaces, each
// behind the bearer-token check, then a JSON 404. Every REST reply is application/json
// and carries a deterministic X-GitHub-Request-Id from a per-process counter.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  Forge,
  HttpError,
  INSTALLED_VERSION,
  VIEWER,
  commentJson,
  createIssue,
  createPull,
  deleteFile,
  getPath,
  issueJson,
  labelJson,
  mergePull,
  nowIso,
  pullChanges,
  pullJson,
  putFile,
  repoJson,
  userJson,
  lineCounts,
} from './store.ts';
import * as G from './git.ts';
import type { RepoRec } from './store.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const forge = new Forge();

function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function authorized(req: IncomingMessage): boolean {
  const token = expectedToken();
  if (token === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${token}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `forge-${forge.requestSeq}`,
    ...headers,
  });
  forge.requestSeq += 1;
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': `forge-${forge.requestSeq}` });
  forge.requestSeq += 1;
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body; an empty body counts as {}, malformed JSON is a 400. */
function jsonBody(raw: Buffer): Record<string, unknown> {
  if (raw.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Problems parsing JSON');
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

interface Page {
  items: unknown[];
  link: string | null;
}

function paginate<T>(items: T[], query: URLSearchParams, makeLink: (page: number, perPage: number) => string): Page {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const link = start + perPage < items.length ? `<${makeLink(page + 1, perPage)}>; rel="next"` : null;
  return { items: slice as unknown[], link };
}

function originOf(req: IncomingMessage): string {
  return `http://${req.headers.host ?? 'localhost'}`;
}

// ---------------------------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------------------------

function requireRepo(owner: string, name: string): RepoRec {
  if (owner !== VIEWER.login) throw new HttpError(404, 'Not Found');
  const repo = forge.getRepo(owner, name);
  if (!repo) throw new HttpError(404, 'Not Found');
  return repo;
}

function commitJson(repo: RepoRec, oid: string): Record<string, unknown> {
  const obj = repo.store.get(oid);
  const view = obj && obj.type === 'commit' ? G.parseCommit(obj.data) : { tree: '', parents: [] as string[], author: '', committer: '', message: '' };
  const person = (line: string): Record<string, unknown> => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
    if (!match) return { name: line, email: '', date: nowIso() };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      author: person(view.author),
      committer: person(view.committer),
      message: view.message,
      tree: { sha: view.tree },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: view.parents.map((parent) => ({ sha: parent })),
  };
}

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer): Promise<void> {
  const segments = url.pathname.split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment));
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);
  const method = req.method ?? 'GET';
  const query = url.searchParams;

  if (rest.length === 0) {
    if (method !== 'GET') throw new HttpError(404, 'Not Found');
    sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        current_user_repositories_url: '/api/v3/user/repos',
        organization_url: '/api/v3/orgs/{org}',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        rate_limit_url: '/api/v3/rate_limit',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') throw new HttpError(404, 'Not Found');
    sendJson(res, 200, { installed_version: INSTALLED_VERSION, github_plan: 'forge', api_version: '3' });
    return;
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') throw new HttpError(404, 'Not Found');
    sendJson(res, 200, { ...userJson(VIEWER.login), name: VIEWER.name, email: VIEWER.email });
    return;
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const repos = forge.listRepos(VIEWER.login).map((repo) => repoJson(repo));
      const page = paginate(repos, query, (next, perPage) => `${originOf(req)}/api/v3/user/repos?per_page=${perPage}&page=${next}`);
      sendJson(res, 200, page.items, page.link ? { link: page.link } : {});
      return;
    }
    if (method === 'POST') {
      const body = jsonBody(raw);
      const name = str(body.name);
      if (name === '') throw new HttpError(422, 'Validation Failed: name is required');
      if (forge.repoExists(VIEWER.login, name)) {
        sendJson(res, 422, {
          message: 'Repository creation failed.',
          errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
        });
        return;
      }
      const repo = forge.createRepo(VIEWER.login, name, body.private === undefined ? false : Boolean(body.private), str(body.description));
      sendJson(res, 201, repoJson(repo));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  if (rest[0] !== 'repos' || rest.length < 3) throw new HttpError(404, 'Not Found');
  const owner = rest[1];
  const name = rest[2];
  const tail = rest.slice(3);

  if (tail.length === 0) {
    const repo = requireRepo(owner, name);
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = jsonBody(raw);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        // Renaming moves the map key; the checks never rename, but stay consistent.
        forge.repos.delete(`${repo.owner}/${repo.name}`);
        repo.name = body.name;
        forge.repos.set(`${repo.owner}/${repo.name}`, repo);
      }
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      sendJson(res, 204, undefined);
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  const repo = requireRepo(owner, name);

  // ---- branches and commits -------------------------------------------------------------
  if (tail[0] === 'branches') {
    if (method !== 'GET') throw new HttpError(404, 'Not Found');
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), oid }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    if (tail.length === 1) {
      sendJson(res, 200, branches.map((branch) => ({ name: branch.name, commit: { sha: branch.oid }, protected: false })));
      return;
    }
    const branchName = tail.slice(1).join('/');
    const found = branches.find((branch) => branch.name === branchName);
    if (!found) throw new HttpError(404, 'Not Found');
    sendJson(res, 200, { name: found.name, commit: commitJson(repo, G.peelToCommit(repo.store, found.oid)), protected: false });
    return;
  }

  if (tail[0] === 'commits' && tail.length === 1) {
    if (method !== 'GET') throw new HttpError(404, 'Not Found');
    const tip = repo.resolveCommit(query.get('sha') ?? undefined);
    if (tip === null) {
      sendJson(res, 200, []);
      return;
    }
    const all = G.walkCommits(repo.store, tip).map((oid) => commitJson(repo, oid));
    const page = paginate(all, query, (next, perPage) => `${originOf(req)}${url.pathname}?per_page=${perPage}&page=${next}`);
    sendJson(res, 200, page.items, page.link ? { link: page.link } : {});
    return;
  }

  if (tail[0] === 'commits' && tail.length === 2 && method === 'GET') {
    const obj = repo.store.get(tail[1]);
    if (!obj || obj.type !== 'commit') throw new HttpError(404, 'Not Found');
    sendJson(res, 200, commitJson(repo, tail[1]));
    return;
  }

  // ---- git data refs ----------------------------------------------------------------------
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const body = jsonBody(raw);
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/')) throw new HttpError(422, 'Validation Failed: ref must start with refs/');
      const target = repo.store.get(sha);
      if (!target) throw new HttpError(422, `Validation Failed: object ${sha} does not exist`);
      if (repo.refs.has(ref)) throw new HttpError(422, `Validation Failed: reference ${ref} already exists`);
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: `REF_${ref}`, object: { type: target.type, sha } });
      return;
    }
    if (method === 'GET' && tail.length === 2) {
      const all = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ref, oid]) => ({
        ref,
        node_id: `REF_${ref}`,
        object: { type: repo.store.get(oid)?.type ?? 'commit', sha: oid },
      }));
      sendJson(res, 200, all);
      return;
    }
    const ref = tail.slice(2).join('/');
    const fullRef = ref.startsWith('refs/') ? ref : `refs/${ref}`;
    if (method === 'GET') {
      const oid = repo.refs.get(fullRef);
      if (!oid) throw new HttpError(404, 'Not Found');
      sendJson(res, 200, { ref: fullRef, node_id: `REF_${fullRef}`, object: { type: repo.store.get(oid)?.type ?? 'commit', sha: oid } });
      return;
    }
    if (method === 'DELETE') {
      if (!repo.refs.delete(fullRef)) throw new HttpError(422, 'Validation Failed: reference does not exist');
      sendJson(res, 204, undefined);
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  // ---- contents ---------------------------------------------------------------------------
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') {
      const commit = repo.resolveCommit(query.get('ref') ?? undefined);
      if (commit === null) throw new HttpError(404, 'Not Found');
      const hit = getPath(repo, commit, path);
      if (!hit) throw new HttpError(404, 'Not Found');
      if (hit.kind === 'dir') {
        sendJson(
          res,
          200,
          (hit.entries ?? []).map((entry) => ({
            name: entry.name,
            path: entry.path,
            sha: entry.oid,
            size: entry.type === 'file' ? (repo.store.get(entry.oid)?.data.length ?? 0) : 0,
            type: entry.type,
            _links: {},
          })),
        );
        return;
      }
      const data = hit.data ?? Buffer.alloc(0);
      const base = path.split('/').pop() ?? path;
      sendJson(res, 200, {
        name: base,
        path,
        sha: hit.oid,
        size: data.length,
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        _links: {},
      });
      return;
    }
    if (method === 'PUT') {
      const body = jsonBody(raw);
      const content = Buffer.from(str(body.content), 'base64');
      const result = putFile(repo, {
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        path,
        content,
        message: str(body.message) || 'Update file',
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      sendJson(res, result.status, {
        content: { name: path.split('/').pop() ?? path, path, sha: result.blobOid, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: result.commitOid, message: str(body.message) || 'Update file' },
      });
      return;
    }
    if (method === 'DELETE') {
      const body = jsonBody(raw);
      const result = deleteFile(repo, {
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        path,
        message: str(body.message) || 'Delete file',
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      sendJson(res, 200, { content: null, commit: { sha: result.commitOid, message: str(body.message) || 'Delete file' } });
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  // ---- labels -----------------------------------------------------------------------------
  if (tail[0] === 'labels') {
    if (method === 'POST' && tail.length === 1) {
      const body = jsonBody(raw);
      const labelName = str(body.name);
      if (labelName === '') throw new HttpError(422, 'Validation Failed: name is required');
      if (repo.labels.has(labelName)) throw new HttpError(422, 'Validation Failed: label already exists');
      const label = { id: forge.entityId(), name: labelName, color: str(body.color) || 'ededed', description: str(body.description) };
      repo.labels.set(labelName, label);
      sendJson(res, 201, labelJson(label));
      return;
    }
    if (method === 'GET' && tail.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(label)));
      return;
    }
    if (method === 'GET' && tail.length === 2) {
      const label = repo.labels.get(tail[1]);
      if (!label) throw new HttpError(404, 'Not Found');
      sendJson(res, 200, labelJson(label));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  // ---- issues -----------------------------------------------------------------------------
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const body = jsonBody(raw);
        const issue = createIssue(forge, repo, { title: str(body.title), body: str(body.body), labels: strList(body.labels) });
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let issues = [...repo.issues.values()];
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        const direction = query.get('direction') ?? 'desc';
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const page = paginate(issues.map((issue) => issueJson(repo, issue)), query, (next, perPage) => `${originOf(req)}${url.pathname}?per_page=${perPage}&page=${next}`);
        sendJson(res, 200, page.items, page.link ? { link: page.link } : {});
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    const number = Number(tail[1]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (tail.length === 2) {
      if (!issue) throw new HttpError(404, 'Not Found');
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        const body = jsonBody(raw);
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (Array.isArray(body.labels)) {
          const names = strList(body.labels);
          for (const labelName of names) {
            if (!repo.labels.has(labelName)) throw new HttpError(422, `Validation Failed: label "${labelName}" does not exist`);
          }
          issue.labels = names;
        }
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (!issue) throw new HttpError(404, 'Not Found');
      if (method === 'POST') {
        const body = jsonBody(raw);
        const comment = { id: forge.entityId(), body: str(body.body), userLogin: VIEWER.login };
        issue.comments.push(comment);
        sendJson(res, 201, commentJson(comment));
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => commentJson(comment)));
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    throw new HttpError(404, 'Not Found');
  }

  // ---- pull requests ----------------------------------------------------------------------
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const body = jsonBody(raw);
        const pull = createPull(forge, repo, { title: str(body.title), body: str(body.body), head: str(body.head), base: str(body.base) });
        sendJson(res, 201, pullJson(repo, pull));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        pulls.sort((a, b) => b.number - a.number);
        const page = paginate(pulls.map((pull) => pullJson(repo, pull)), query, (next, perPage) => `${originOf(req)}${url.pathname}?per_page=${perPage}&page=${next}`);
        sendJson(res, 200, page.items, page.link ? { link: page.link } : {});
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    const number = Number(tail[1]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (tail.length === 2 && method === 'GET') {
      if (!pull) throw new HttpError(404, 'Not Found');
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      if (!pull) throw new HttpError(404, 'Not Found');
      const changes = pullChanges(repo, pull);
      const files = changes.map((change) => {
        const oldText = change.oldOid ? (repo.store.get(change.oldOid)?.data.toString('utf8') ?? '') : null;
        const newText = change.newOid ? (repo.store.get(change.newOid)?.data.toString('utf8') ?? '') : null;
        const counts = lineCounts(oldText, newText);
        return {
          sha: change.newOid ?? change.oldOid ?? '',
          filename: change.path,
          status: change.status,
          additions: counts.additions,
          deletions: counts.deletions,
          changes: counts.additions + counts.deletions,
        };
      });
      sendJson(res, 200, files);
      return;
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      if (!pull) throw new HttpError(404, 'Not Found');
      jsonBody(raw); // a malformed merge body is a 400, like every REST body
      const result = mergePull(repo, pull);
      sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  throw new HttpError(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------------------------

const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow';
const RECEIVE_CAPS_V0 = 'report-status delete-refs side-band-64k ofs-delta';

/** Sorted ref lines for an advertisement or ls-refs: [name, oid] with HEAD handled by callers. */
function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function refAdvertisement(repo: RepoRec, capabilities: string): Buffer {
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(G.encodePkt(`${G.ZERO_OID} capabilities^{}\0${capabilities}\n`));
    return Buffer.concat(parts);
  }
  const headOid = repo.refs.get(repo.headTarget());
  let first = true;
  if (headOid) {
    parts.push(G.encodePkt(`${headOid} HEAD\0${capabilities} symref=HEAD:${repo.headTarget()}\n`));
    first = false;
  }
  for (const [ref, oid] of refs) {
    const caps = first ? `\0${capabilities}` : '';
    first = false;
    parts.push(G.encodePkt(`${oid} ${ref}${caps}\n`));
    const obj = repo.store.get(oid);
    if (obj && obj.type === 'tag') {
      parts.push(G.encodePkt(`${G.parseTag(obj.data).object} ${ref}^{}\n`));
    }
  }
  return Buffer.concat(parts);
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: RepoRec, url: URL): void {
  const service = url.searchParams.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendRaw(res, 400, Buffer.from('unknown service\n'), 'text/plain');
    return;
  }
  const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (service === 'git-upload-pack' && wantsV2) {
    const body = Buffer.concat([
      G.encodePkt('version 2\n'),
      G.encodePkt('fetch=shallow\n'),
      G.encodePkt('ls-refs=unborn\n'),
      G.encodePkt('object-format=sha1\n'),
      G.PKT_FLUSH,
    ]);
    sendRaw(res, 200, body, 'application/x-git-upload-pack-advertisement');
    return;
  }
  const preamble = service === 'git-upload-pack' ? '# service=git-upload-pack\n' : '# service=git-receive-pack\n';
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const body = Buffer.concat([G.encodePkt(preamble), G.PKT_FLUSH, refAdvertisement(repo, caps)]);
  sendRaw(res, 200, body, `application/x-${service}-advertisement`);
}

/** One ls-refs answer: HEAD first (subject to prefixes), then the matching refs. */
function lsRefsBody(repo: RepoRec, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headRef = repo.headTarget();
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid) {
      parts.push(G.encodePkt(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(G.encodePkt(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let suffix = '';
    const obj = repo.store.get(oid);
    if (peel && obj && obj.type === 'tag') suffix = ` peeled:${G.parseTag(obj.data).object}`;
    parts.push(G.encodePkt(`${oid} ${ref}${suffix}\n`));
  }
  parts.push(G.PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

function fetchResponse(repo: RepoRec, args: FetchArgs, version2: boolean): Buffer {
  const plan = G.planFetch(repo.store, args.wants, args.haves, args.shallow, args.deepen);
  const pack = G.writePack(plan.objects);
  const parts: Buffer[] = [];
  if (version2) {
    const acked = args.haves.filter((have) => repo.store.has(have)).pop();
    parts.push(G.encodePkt('acknowledgments\n'));
    parts.push(G.encodePkt(acked ? `ACK ${acked}\n` : 'NAK\n'));
    parts.push(G.PKT_FLUSH);
    if (plan.shallowInfo) {
      parts.push(G.encodePkt('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(G.encodePkt(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(G.encodePkt(`unshallow ${oid}\n`));
      parts.push(G.PKT_FLUSH);
    }
    parts.push(G.encodePkt('packfile\n'));
    for (const packet of G.sidebandPackets(pack)) parts.push(packet);
    parts.push(G.PKT_FLUSH);
  } else {
    if (plan.shallowInfo) {
      for (const oid of plan.shallow) parts.push(G.encodePkt(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(G.encodePkt(`unshallow ${oid}\n`));
    }
    const acked = args.haves.filter((have) => repo.store.has(have)).pop();
    parts.push(G.encodePkt(acked ? `ACK ${acked}\n` : 'NAK\n'));
    for (const packet of G.sidebandPackets(pack)) parts.push(packet);
    parts.push(G.PKT_FLUSH);
  }
  return Buffer.concat(parts);
}

function handleUploadPack(res: ServerResponse, repo: RepoRec, raw: Buffer): void {
  let packets: G.Pkt[];
  try {
    packets = G.parsePkts(raw).packets;
  } catch {
    sendRaw(res, 400, Buffer.from('invalid pkt-line request\n'), 'text/plain');
    return;
  }
  const lines = packets.map((packet) => (Buffer.isBuffer(packet) ? packet.toString('utf8') : packet));
  const first = typeof lines[0] === 'string' ? lines[0] : '';
  if (first.startsWith('command=')) {
    const command = first.slice('command='.length).trim();
    const delimAt = lines.indexOf('delim');
    const argLines = (delimAt === -1 ? lines.slice(1) : lines.slice(delimAt + 1))
      .filter((line): line is string => typeof line === 'string')
      .map((line) => line.replace(/\n$/, ''));
    if (command === 'ls-refs') {
      sendRaw(res, 200, lsRefsBody(repo, argLines), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false };
      for (const line of argLines) {
        const text = line.replace(/\n$/, '');
        if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
        else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
        else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) args.deepen = Number(text.slice(7).trim()) || null;
        else if (text === 'done') args.done = true;
      }
      sendRaw(res, 200, fetchResponse(repo, args, true), 'application/x-git-upload-pack-result');
      return;
    }
    sendRaw(res, 400, Buffer.from('unknown command\n'), 'text/plain');
    return;
  }
  // Protocol v0: want section, flush, have section, flush.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  let section = 0;
  for (const packet of packets) {
    if (packet === 'flush') {
      section += 1;
      continue;
    }
    if (!Buffer.isBuffer(packet)) continue;
    const text = packet.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (text.startsWith('want ')) args.wants.push(text.slice(5).trim().split(' ')[0]);
      else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) args.deepen = Number(text.slice(7).trim()) || null;
    } else {
      if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
      else if (text === 'done') args.done = true;
    }
  }
  sendRaw(res, 200, fetchResponse(repo, args, false), 'application/x-git-upload-pack-result');
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(res: ServerResponse, repo: RepoRec, raw: Buffer): void {
  let packets: G.Pkt[];
  let packBytes: Buffer;
  try {
    const split = G.splitPktPrefix(raw);
    packets = split.packets;
    packBytes = split.rest;
  } catch {
    sendRaw(res, 400, Buffer.from('invalid pkt-line request\n'), 'text/plain');
    return;
  }
  const commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  packets.forEach((packet, index) => {
    if (!Buffer.isBuffer(packet)) return;
    let text = packet.toString('utf8').replace(/\n$/, '');
    if (index === 0) {
      const nul = text.indexOf('\0');
      if (nul !== -1) {
        capabilities = new Set(text.slice(nul + 1).split(' ').filter(Boolean).map((cap) => cap.split('=')[0]));
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length === 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  });

  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = G.readPack(packBytes, (oid) => repo.store.get(oid));
      for (const [oid, obj] of objects) repo.store.putKnown(oid, obj);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const report: string[] = [`unpack ${unpackError === null ? 'ok' : `error: ${unpackError}`}\n`];
  for (const command of commands) {
    const fail = (reason: string): void => {
      report.push(`ng ${command.ref} ${reason}\n`);
    };
    const current = repo.refs.get(command.ref) ?? null;
    if (unpackError !== null) {
      fail('unpack failed');
      continue;
    }
    if (!command.ref.startsWith('refs/')) {
      fail('invalid ref');
      continue;
    }
    if (command.newOid === G.ZERO_OID) {
      // delete
      if (current === null) {
        fail('reference does not exist');
        continue;
      }
      if (command.oldOid !== G.ZERO_OID && command.oldOid !== current) {
        fail('stale info');
        continue;
      }
      if (command.ref === repo.headTarget()) {
        fail('deletion of the current branch prohibited');
        continue;
      }
      repo.refs.delete(command.ref);
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    const target = repo.store.get(command.newOid);
    if (!target) {
      fail('invalid object');
      continue;
    }
    if (command.oldOid === G.ZERO_OID) {
      // create
      if (current !== null) {
        fail('reference already exists');
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    // update
    if (current === null || current !== command.oldOid) {
      fail('stale info');
      continue;
    }
    if (current !== command.newOid && !G.isAncestor(repo.store, current, command.newOid)) {
      fail('non-fast-forward');
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}\n`);
  }

  if (!capabilities.has('report-status') && !capabilities.has('report-status-v2')) {
    sendRaw(res, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
    return;
  }
  const reportBody = Buffer.concat([...report.map((line) => G.encodePkt(line)), G.PKT_FLUSH]);
  if (capabilities.has('side-band-64k')) {
    const wrapped: Buffer[] = [];
    // The whole report stream rides in band 1, itself pkt-framed inside the band.
    let at = 0;
    while (at < reportBody.length) {
      const take = Math.min(reportBody.length - at, G.PKT_MAX_PAYLOAD - 1);
      wrapped.push(G.encodePkt(Buffer.concat([Buffer.from([1]), reportBody.subarray(at, at + take)])));
      at += take;
    }
    wrapped.push(G.PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(wrapped), 'application/x-git-receive-pack-result');
    return;
  }
  sendRaw(res, 200, reportBody, 'application/x-git-receive-pack-result');
}

function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer): void {
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  // /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
  if (segments.length < 3) throw new HttpError(404, 'Not Found');
  const owner = decodeURIComponent(segments[0]);
  const repoName = decodeURIComponent(segments[1]).replace(/\.git$/, '');
  const sub = segments.slice(2).join('/');
  const repo = owner === VIEWER.login ? forge.getRepo(owner, repoName) : null;
  if (!repo) {
    sendRaw(res, 404, Buffer.from('not found\n'), 'text/plain');
    return;
  }
  const method = req.method ?? 'GET';
  if (sub === 'info/refs' && method === 'GET') {
    handleInfoRefs(req, res, repo, url);
    return;
  }
  if (sub === 'git-upload-pack' && method === 'POST') {
    handleUploadPack(res, repo, raw);
    return;
  }
  if (sub === 'git-receive-pack' && method === 'POST') {
    handleReceivePack(res, repo, raw);
    return;
  }
  throw new HttpError(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------------------------

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }

        if (path === '/mcp') {
          const out = handleMcp(forge, raw);
          sendRaw(res, out.status, Buffer.from(out.text, 'utf8'), out.contentType);
          return;
        }
        if (path === '/api/graphql') {
          if (method !== 'POST') throw new HttpError(404, 'Not Found');
          const out = handleGraphQL(forge, raw);
          sendRaw(res, out.status, Buffer.from(out.text, 'utf8'), out.contentType);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(req, res, url, raw);
          return;
        }
        if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
          handleGit(req, res, url, raw);
          return;
        }
        throw new HttpError(404, 'Not Found');
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (err instanceof HttpError) {
          sendJson(res, err.status, { message: err.message });
        } else {
          sendJson(res, 500, { message: 'Internal Server Error' });
        }
      }
    })();
  });
}
