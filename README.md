# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/xjzstar/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/xjzstar/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An original, dependency-free GitHub-compatible git forge in TypeScript. One Node process, standard library only, everything in memory — built from scratch for this bounty.

| Surface | Implementation |
| --- | --- |
| git smart HTTP at `/{owner}/{repo}.git` | `info/refs`, upload-pack protocol v2 (`ls-refs`, `fetch` with shallow/deepen planning) and v0, receive-pack v0 with report-status in side-band-64k, a real SHA-1 object store and packfiles (delta resolution included) |
| REST v3 under `/api/v3` | repositories, branches, commits, contents backed by git objects, labels, issues, comments, pull requests (files diff, squash merge with a real three-way tree merge) |
| GraphQL v4 at `/api/graphql` | a purpose-built parser/evaluator: viewer, repository, issue/pull-request connections with cursor pagination, `node(id:)`, introspection, batched operations, and the createIssue / closeIssue / createPullRequest / mergePullRequest / addComment mutations |
| MCP at `/mcp` | JSON-RPC 2.0 streamable HTTP: `server/discover` (2026-07-28) plus the `initialize` handshake era, eight tools over the same store as REST |

Determinism is a hard rule here: timestamps come from `MAKEFUN_TRIAL_NOW`, ids are sequential, request ids come from a counter, and pushed git objects are stored byte-for-byte, so a replayed trial produces the same answers.

Layout: `main.ts` is the harness lifecycle (bind port 0, register with the env, wait for done), kept as the starter ships it. `app.ts` is the HTTP server (routing, auth, REST v3, git smart-HTTP handlers); `git.ts` the git engine (objects, packfiles, pkt-lines, reachability, shallow planning, tree merges); `store.ts` the in-memory forge state and the domain operations every surface shares; `graphql.ts` the GraphQL parser/evaluator; `mcp.ts` the MCP endpoint and its tools.

MIT licensed — see `LICENSE`.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=7yd20ms9&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
