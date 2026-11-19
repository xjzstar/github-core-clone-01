// The git object engine: SHA-1 objects, trees/commits/tags, packfiles (read and write),
// pkt-line framing, reachability, shallow fetch planning and tree merges. Node stdlib only.
//
// Everything here is deterministic: object bytes are stored verbatim, traversals visit
// parents and tree entries in stored order, and packs are emitted in traversal order.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** git's object id: SHA-1 over `<type> <size>\0` followed by the raw bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** An in-memory object database for one repository. */
export class ObjectStore {
  readonly objects = new Map<string, GitObj>();

  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putKnown(oid: string, obj: GitObj): void {
    if (!this.objects.has(oid)) this.objects.set(oid, obj);
  }

  get(oid: string): GitObj | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// ---------------------------------------------------------------------------------------------
// commits, trees, tags
// ---------------------------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree order: by name, directories compared as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

/** Peel a ref target through tag objects to the commit it names (or the object itself). */
export function peelToCommit(store: ObjectStore, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const obj = store.get(current);
    if (!obj || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

export const PKT_MAX_PAYLOAD = 65520 - 4;

export function encodePkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error(`pkt-line payload too large: ${data.length}`);
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

export type Pkt = Buffer | 'flush' | 'delim' | 'end';

/** Parse pkt-lines from `buf` starting at `offset`; stops at the end of the buffer. */
export function parsePkts(buf: Buffer, offset = 0): { packets: Pkt[]; next: number } {
  const packets: Pkt[] = [];
  let at = offset;
  while (at + 4 <= buf.length) {
    const header = buf.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line header ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push('flush');
      at += 4;
      continue;
    }
    if (length === 1) {
      packets.push('delim');
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push('end');
      at += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (at + length > buf.length) throw new Error('truncated pkt-line');
    packets.push(buf.subarray(at + 4, at + length));
    at += length;
  }
  if (at !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return { packets, next: at };
}

/** Split a receive-pack body: the pkt-lines up to and including the first flush, then the raw rest (the pack). */
export function splitPktPrefix(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const header = buf.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line header ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push('flush');
      at += 4;
      return { packets, rest: buf.subarray(at) };
    }
    if (length === 1) {
      packets.push('delim');
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push('end');
      at += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (at + length > buf.length) throw new Error('truncated pkt-line');
    packets.push(buf.subarray(at + 4, at + length));
    at += length;
  }
  return { packets, rest: buf.subarray(at) };
}

/** Split a chunk of sideband data into pkt-line sized band-1 packets. */
export function sidebandPackets(pack: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  const prefix = Buffer.from([band]);
  let at = 0;
  while (at < pack.length) {
    const take = Math.min(pack.length - at, PKT_MAX_PAYLOAD - 1);
    out.push(encodePkt(Buffer.concat([prefix, pack.subarray(at, at + take)])));
    at += take;
  }
  if (out.length === 0) out.push(encodePkt(prefix));
  return out;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

function writePackHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A version-2 pack of full objects (no deltas), in the order given. */
export function writePack(objects: readonly { type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(writePackHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate the zlib stream starting at `offset` and report where it ends. Node's inflateSync
 * ignores trailing bytes but throws on a truncated stream, so the shortest prefix that
 * inflates is exactly the stream's end; an exponential probe brackets it first.
 */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const remaining = buf.length - offset;
  const inflates = (length: number): boolean => {
    try {
      inflateSync(buf.subarray(offset, offset + length));
      return true;
    } catch {
      return false;
    }
  };
  // `lo` always names a prefix that fails (0 bytes can never hold a stream); grow `hi`
  // until it names one that succeeds, then bisect for the shortest succeeding prefix.
  let lo = 0;
  let hi = Math.min(remaining, 128);
  while (!inflates(hi)) {
    lo = hi;
    if (hi >= remaining) throw new Error('corrupt deflate stream in pack');
    hi = Math.min(remaining, hi * 2);
  }
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (inflates(mid)) hi = mid;
    else lo = mid;
  }
  return { data: inflateSync(buf.subarray(offset, offset + hi)), next: offset + hi };
}

/** Apply a git delta (copy/insert program) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at];
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= delta[at] << (8 * bit);
          at += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= delta[at] << (8 * bit);
          at += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      parts.push(delta.subarray(at, at + op));
      produced += op;
      at += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

interface PackEntry {
  offset: number;
  typeCode: number;
  data: Buffer | null;
  deltaData: Buffer | null;
  baseOffset: number;
  baseOid: string;
}

/**
 * Read a whole pack: verify its trailer, inflate every entry and resolve OFS/REF deltas
 * (REF bases may come from `externalBase`, which is how a thin push pack resolves).
 * Returns the oid -> object map of everything the pack carries.
 */
export function readPack(
  pack: Buffer,
  externalBase: (oid: string) => GitObj | undefined = () => undefined,
): Map<string, GitObj> {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack signature missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack trailer checksum mismatch');

  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let at = 12;
  const dataEnd = pack.length - 20;
  for (let index = 0; index < count; index += 1) {
    const start = at;
    let byte = pack[at];
    at += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at];
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const entry: PackEntry = { offset: start, typeCode, data: null, deltaData: null, baseOffset: 0, baseOid: '' };
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base entry, in git's offset encoding.
      byte = pack[at];
      at += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[at];
        at += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      entry.baseOffset = start - back;
      const inflated = inflateAt(pack, at);
      entry.deltaData = inflated.data;
      at = inflated.next;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
      const inflated = inflateAt(pack, at);
      entry.deltaData = inflated.data;
      at = inflated.next;
    } else if (typeCode >= 1 && typeCode <= 4) {
      const inflated = inflateAt(pack, at);
      entry.data = inflated.data;
      at = inflated.next;
    } else {
      throw new Error(`pack entry type ${typeCode} is not valid`);
    }
    if (at > dataEnd) throw new Error('pack entry overruns the pack');
    entries.push(entry);
    byOffset.set(entry.offset, entry);
  }

  const resolved = new Map<number, GitObj>();
  const result = new Map<string, GitObj>();
  const fullByOid = new Map<string, PackEntry>();
  for (const entry of entries) {
    if (entry.data !== null) {
      const type = CODE_TYPE[entry.typeCode];
      if (type) fullByOid.set(hashObject(type, entry.data), entry);
    }
  }
  const resolve = (entry: PackEntry, depth: number): GitObj => {
    const memo = resolved.get(entry.offset);
    if (memo) return memo;
    if (depth > 64) throw new Error('delta chain too deep');
    let obj: GitObj;
    if (entry.data !== null) {
      const type = CODE_TYPE[entry.typeCode];
      if (!type) throw new Error(`pack entry type ${entry.typeCode} is not valid`);
      obj = { type, data: entry.data };
    } else {
      let base: GitObj | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (!baseEntry) throw new Error('ofs-delta base offset not in pack');
        base = resolve(baseEntry, depth + 1);
      } else {
        const inPack = fullByOid.get(entry.baseOid);
        if (inPack) base = resolve(inPack, depth + 1);
        else base = externalBase(entry.baseOid);
        if (!base) throw new Error(`ref-delta base ${entry.baseOid} not available`);
      }
      obj = { type: base.type, data: applyDelta(base.data, entry.deltaData ?? Buffer.alloc(0)) };
    }
    resolved.set(entry.offset, obj);
    result.set(hashObject(obj.type, obj.data), obj);
    return obj;
  };
  for (const entry of entries) resolve(entry, 0);
  if (result.size !== count && entries.length === count) {
    // Duplicate objects in one pack collapse in the map; that is fine for storage.
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// traversal, reachability, merges
// ---------------------------------------------------------------------------------------------

interface CommitInfo {
  tree: string;
  parents: string[];
}

function commitInfo(store: ObjectStore, oid: string): CommitInfo | null {
  const obj = store.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const view = parseCommit(obj.data);
  return { tree: view.tree, parents: view.parents };
}

/** Add a tree and everything under it to `into`. */
function addTreeClosure(store: ObjectStore, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const obj = store.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  into.add(treeOid);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') addTreeClosure(store, entry.oid, into);
    else if (store.has(entry.oid)) into.add(entry.oid);
  }
}

/**
 * The full object closure of `tips` (commits, their trees and blobs, tag chains).
 * Commits in `grafted` are included but their parents are not walked (shallow boundary).
 */
export function closureOf(store: ObjectStore, tips: readonly string[], grafted?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const queue: string[] = [];
  const pushObj = (oid: string): void => {
    if (!out.has(oid) && store.has(oid)) queue.push(oid);
  };
  for (const tip of tips) pushObj(tip);
  while (queue.length) {
    const oid = queue.shift() as string;
    if (out.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'tag') {
      pushObj(parseTag(obj.data).object);
    } else if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      addTreeClosure(store, info.tree, out);
      if (!grafted || !grafted.has(oid)) {
        for (const parent of info.parents) pushObj(parent);
      }
    }
  }
  return out;
}

/** Is `ancestor` reachable from `descendant` through commit parents? (Equality counts.) */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return store.has(ancestor);
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const info = commitInfo(store, oid);
    if (!info) continue;
    for (const parent of info.parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** All commits reachable from `tip`, tip first, breadth-first (for the commits list). */
export function walkCommits(store: ObjectStore, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const info = commitInfo(store, oid);
    if (!info) continue;
    seen.add(oid);
    order.push(oid);
    for (const parent of info.parents) queue.push(parent);
  }
  return order;
}

/** A common ancestor of two commits (nearest to `b` first), or null when unrelated. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const queueA = [a];
  while (queueA.length) {
    const oid = queueA.shift() as string;
    if (ancestorsOfA.has(oid)) continue;
    const info = commitInfo(store, oid);
    if (!info) continue;
    ancestorsOfA.add(oid);
    for (const parent of info.parents) queueA.push(parent);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const info = commitInfo(store, oid);
    if (!info) continue;
    for (const parent of info.parents) queue.push(parent);
  }
  return null;
}

/** path -> blob info for every file under a tree (recursive). */
export function flattenTree(store: ObjectStore, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = store.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  if (treeOid) walk(treeOid, '');
  return out;
}

/** Build (and store) nested trees from a flat path -> blob map; returns the root tree oid. */
export function buildTreeFromFiles(store: ObjectStore, files: Map<string, { oid: string; mode: string }>): string {
  interface Dir {
    entries: Map<string, TreeEntry>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { entries: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const segments = path.split('/');
    let dir = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      let next = dir.dirs.get(segments[i]);
      if (!next) {
        next = { entries: new Map(), dirs: new Map() };
        dir.dirs.set(segments[i], next);
      }
      dir = next;
    }
    dir.entries.set(segments[segments.length - 1], { mode: file.mode, name: segments[segments.length - 1], oid: file.oid });
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [...dir.entries.values()];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(sub) });
    return store.put('tree', buildTree(entries));
  };
  return emit(root);
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** The file-level difference between two trees (either may be null for "no tree"). */
export function diffTrees(store: ObjectStore, baseTree: string | null, headTree: string | null): FileChange[] {
  const base = baseTree ? flattenTree(store, baseTree) : new Map<string, { oid: string; mode: string }>();
  const head = headTree ? flattenTree(store, headTree) : new Map<string, { oid: string; mode: string }>();
  const changes: FileChange[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before && !after) changes.push({ path, status: 'removed', oldOid: before.oid, newOid: null });
    else if (!before && after) changes.push({ path, status: 'added', oldOid: null, newOid: after.oid });
    else if (before && after && before.oid !== after.oid) changes.push({ path, status: 'modified', oldOid: before.oid, newOid: after.oid });
  }
  return changes;
}

/**
 * A three-way merge of two trees against their common base. A path changed on only one
 * side takes that side; changed identically on both takes it once; changed differently
 * on both is a conflict. Returns the merged tree oid, or the conflicted paths.
 */
export function mergeTrees(
  store: ObjectStore,
  baseTree: string | null,
  oursTree: string,
  theirsTree: string,
): { tree: string } | { conflicts: string[] } {
  const base = baseTree ? flattenTree(store, baseTree) : new Map<string, { oid: string; mode: string }>();
  const ours = flattenTree(store, oursTree);
  const theirs = flattenTree(store, theirsTree);
  const merged = new Map<string, { oid: string; mode: string }>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const sameOT = (o?.oid ?? null) === (t?.oid ?? null);
    const sameBO = (b?.oid ?? null) === (o?.oid ?? null);
    const sameBT = (b?.oid ?? null) === (t?.oid ?? null);
    if (sameOT) {
      if (o) merged.set(path, o);
    } else if (sameBO) {
      if (t) merged.set(path, t);
    } else if (sameBT) {
      if (o) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length) return { conflicts: conflicts.sort() };
  return { tree: buildTreeFromFiles(store, merged) };
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to put in the pack, in deterministic order. */
  objects: { oid: string; type: ObjType; data: Buffer }[];
  /** The new shallow boundary to report (empty when the fetch is not shallow). */
  shallow: string[];
  /** Former boundary commits whose parents are now present. */
  unshallow: string[];
  /** True when a shallow-info section should be sent at all. */
  shallowInfo: boolean;
}

/**
 * Plan a fetch: the objects a client asking for `wants` (already holding `haves`, with a
 * shallow boundary at `shallowClient`) still needs. `deepen` counts generations from the
 * wants (deepen 1 = the tips only), matching the suite's shallow checks.
 */
export function planFetch(
  store: ObjectStore,
  wants: readonly string[],
  haves: readonly string[],
  shallowClient: readonly string[],
  deepen: number | null,
): FetchPlan {
  const grafted = new Set(shallowClient);
  const shallowMode = deepen !== null || shallowClient.length > 0;

  // Traverse from the wants, honouring the generation limit; grafted commits are not
  // expanded unless a deepen asks for generations beyond them (the limit governs then).
  const wanted = new Map<string, GitObj>();
  const commitGen = new Map<string, number>();
  const queue: { oid: string; gen: number }[] = [];
  const visit = (oid: string, gen: number): void => {
    const obj = store.get(oid);
    if (!obj) return;
    if (obj.type === 'commit') {
      const known = commitGen.get(oid);
      if (known !== undefined && known <= gen) return;
      commitGen.set(oid, gen);
      queue.push({ oid, gen });
      return;
    }
    if (!wanted.has(oid)) wanted.set(oid, obj);
    if (obj.type === 'tag') visit(parseTag(obj.data).object, gen);
  };
  for (const want of wants) visit(want, 0);
  const traversedCommits: string[] = [];
  while (queue.length) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if (wanted.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj) continue;
    wanted.set(oid, obj);
    traversedCommits.push(oid);
    const info = parseCommit(obj.data);
    const treeClosure = new Set<string>();
    addTreeClosure(store, info.tree, treeClosure);
    for (const treeOid of treeClosure) {
      const treeObj = store.get(treeOid);
      if (treeObj && !wanted.has(treeOid)) wanted.set(treeOid, treeObj);
    }
    const atLimit = deepen !== null && gen >= deepen - 1;
    const stopHere = deepen === null && grafted.has(oid);
    if (!atLimit && !stopHere) {
      for (const parent of info.parents) visit(parent, gen + 1);
    }
  }

  // What the client already holds: each have with its closure, stopping at grafted commits
  // (a shallow client's "have" is a boundary commit, not its history).
  const held = new Set<string>();
  for (const have of haves) {
    for (const oid of closureOf(store, [have], grafted)) held.add(oid);
  }
  for (const boundary of shallowClient) {
    for (const oid of closureOf(store, [boundary], grafted)) held.add(oid);
  }

  const objects: { oid: string; type: ObjType; data: Buffer }[] = [];
  for (const [oid, obj] of wanted) {
    if (!held.has(oid)) objects.push({ oid, type: obj.type, data: obj.data });
  }
  // Deterministic pack order: commits in traversal order, then trees, blobs, tags by oid.
  const rank = (type: ObjType): number => (type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'blob' ? 2 : 3);
  const commitOrder = new Map(traversedCommits.map((oid, index) => [oid, index]));
  objects.sort((a, b) => {
    const byRank = rank(a.type) - rank(b.type);
    if (byRank !== 0) return byRank;
    if (a.type === 'commit') return (commitOrder.get(a.oid) ?? 0) - (commitOrder.get(b.oid) ?? 0);
    return a.oid < b.oid ? -1 : 1;
  });

  // The boundary after this fetch: held-or-delivered commits with a parent the client
  // still does not have.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (shallowMode) {
    const clientHas = new Set<string>([...held, ...objects.map((entry) => entry.oid)]);
    const candidates = new Set<string>([...traversedCommits, ...haves, ...shallowClient]);
    const boundary = new Set<string>();
    for (const oid of candidates) {
      const info = commitInfo(store, oid);
      if (!info) continue;
      if (!clientHas.has(oid) && !objects.some((entry) => entry.oid === oid)) continue;
      const missingParent = info.parents.some((parent) => store.has(parent) && !clientHas.has(parent));
      if (missingParent) boundary.add(oid);
    }
    for (const oid of boundary) shallow.push(oid);
    for (const old of shallowClient) {
      if (boundary.has(old)) continue;
      const info = commitInfo(store, old);
      if (info && info.parents.every((parent) => clientHas.has(parent) || !store.has(parent))) unshallow.push(old);
    }
    shallow.sort();
    unshallow.sort();
  }

  return { objects, shallow, unshallow, shallowInfo: shallowMode };
}
