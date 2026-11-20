// app.ts — a GitHub-compatible git forge in one Node 22 process.
//
// Surfaces, all served from memory on one HTTP server:
//   * git smart HTTP at /{owner}/{repo}.git — upload-pack protocol v2, receive-pack v0,
//     packfiles with ofs/ref-delta parsing and whole-object writing;
//   * REST v3 under /api/v3 — repositories, branches, commits, contents, labels, issues,
//     pull requests and the Git Data ref API;
//   * GraphQL v4 at /api/graphql — the documents gh and github-mcp-server send, plus
//     __type introspection, Relay global ids and operation batching;
//   * MCP at /mcp — JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
//     (server/discover) with the legacy initialize handshake as a fallback.
//
// The suite is the only client. Everything is deterministic: no wall clock and no
// unseeded randomness anywhere a response can see. Creation timestamps come from a
// fixed epoch plus a monotonic sequence, so a live trial and its replay answer
// byte-identical bytes for the same request order.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** The login the trial's bearer token names (the suite's fixed scenario viewer). */
export const VIEWER_LOGIN = 'adaiversen';
/** The viewer's numeric id, as the scenario assigns it. */
export const VIEWER_ID = 1000;
/** The viewer's display name and contact, matching the scenario's login pattern. */
export const VIEWER_NAME = 'Ada Iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';
/** The all-zero object id: an unborn ref, a create's old id, a delete's new id. */
export const ZERO_OID = '0000000000000000000000000000000000000000';
/** The empty tree's id, for a commit that removes the last file. */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Day one of the deterministic clock: 2025-01-01T00:00:00Z. */
export const CLOCK_EPOCH_SEC = 1735689600;
/** The identity every commit this forge mints carries. */
export const FORGE_IDENTITY = 'Conformance <conformance@make.fun>';
/** The bearer token the suite presents, from the process environment. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** The agent string the git advertisements carry. */
const FORGE_AGENT = 'github-core-clone/1.0.0';
/** This forge's MCP identity. */
const MCP_NAME = 'github-core-clone';
const MCP_VERSION = '1.0.0';
/** The MCP revision this server negotiates (2026-07-28). */
const MCP_REVISION = '2026-07-28';
/** The biggest request body accepted (packs stay far below this). */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

export class ForgeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ForgeError';
    this.status = status;
  }
}

function badRequest(message: string): ForgeError {
  return new ForgeError(400, message);
}

function notFound(message: string): ForgeError {
  return new ForgeError(404, message);
}

function unprocessable(message: string): ForgeError {
  return new ForgeError(422, message);
}

function conflict(message: string): ForgeError {
  return new ForgeError(409, message);
}

/** SHA-1 hex of bytes. */
export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** True for a lowercase 40-hex object id. */
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Base64url without padding, for opaque Relay global ids. */
export function toB64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function fromB64Url(value: string): string | null {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** Standard base64 of bytes. */
export function b64encode(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

/** Base64 decoding that tolerates GitHub's line wrapping. */
export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** A value that is a plain record (an object, not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

/** Split a path into its segments, decoding each percent-encoded piece. */
function splitPath(path: string): string[] {
  return path
    .split('/')
    .filter((piece) => piece !== '')
    .map((piece) => {
      try {
        return decodeURIComponent(piece);
      } catch {
        return piece;
      }
    });
}

/** The first path segment of a ref name (refs/heads/main -> heads). */
function refKind(ref: string): string {
  const rest = ref.startsWith('refs/') ? ref.slice(5) : ref;
  return rest.split('/')[0] ?? '';
}

/** A branch name from a ref or a bare name: refs/heads/x -> x, x -> x. */
function branchOf(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** The full ref name of a branch. */
function headRefOf(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
}

/** Compare two strings by UTF-8 bytes (git's tree-entry order uses this). */
function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------------------------------------------------------------------------
// git object model
// ---------------------------------------------------------------------------

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: ObjType, data: Uint8Array): string {
  const head = Buffer.from(`${type} ${data.length}\u0000`, 'utf8');
  const hash = createHash('sha1');
  hash.update(head);
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries, in stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const space = buf.indexOf(0x20, offset);
    if (space < 0) throw new ForgeError(400, 'tree entry has no mode separator');
    const nul = buf.indexOf(0x00, space + 1);
    if (nul < 0) throw new ForgeError(400, 'tree entry has no name terminator');
    if (nul + 21 > buf.length) throw new ForgeError(400, 'tree entry has a truncated object id');
    const mode = buf.subarray(offset, space).toString('ascii');
    const name = buf.subarray(space + 1, nul).toString('utf8');
    const oid = buf.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new ForgeError(400, `tree entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory as if it ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = a.mode === '40000' ? `${a.name}/` : a.name;
  const right = b.mode === '40000' ? `${b.name}/` : b.name;
  return compareBytes(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isOid(entry.oid)) throw new ForgeError(400, `tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object; refuses a malformed header layout. */
export function parseCommit(data: Uint8Array): CommitView {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headEnd = blank < 0 ? buf.length : blank;
  const headText = buf.subarray(0, headEnd).toString('utf8');
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new ForgeError(400, 'commit has no valid tree header');
  for (const parent of parents) {
    if (!isOid(parent)) throw new ForgeError(400, 'commit has a bad parent id');
  }
  return { tree, parents, author, committer, message };
}

export interface BuildCommitInput {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
  timezone?: string;
}

/** Build a commit object's bytes. */
export function buildCommit(fields: BuildCommitInput): Buffer {
  if (!isOid(fields.tree)) throw new ForgeError(400, 'buildCommit needs a valid tree id');
  const stamp = fields.timestamp ?? CLOCK_EPOCH_SEC;
  const zone = fields.timezone ?? '+0000';
  const author = `${fields.author ?? FORGE_IDENTITY} ${stamp} ${zone}`;
  const committer = `${fields.committer ?? FORGE_IDENTITY} ${stamp} ${zone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isOid(parent)) throw new ForgeError(400, 'buildCommit needs valid parent ids');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headEnd = blank < 0 ? buf.length : blank;
  const headers = new Map<string, string>();
  for (const line of buf.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new ForgeError(400, `tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new ForgeError(400, 'tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new ForgeError(400, `tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8'),
  };
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: {
  object: string;
  type: ObjType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  if (!isOid(fields.object)) throw new ForgeError(400, 'buildTag needs a valid object id');
  const stamp = fields.timestamp ?? CLOCK_EPOCH_SEC;
  const zone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? FORGE_IDENTITY} ${stamp} ${zone}`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

/** Split an ident line `Name <email> 1234567890 +0000` into its parts. */
export function parseIdent(line: string): { name: string; email: string; epoch: number; zone: string } {
  const match = /^(.*?) <([^<>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', epoch: CLOCK_EPOCH_SEC, zone: '+0000' };
  return {
    name: match[1] ?? '',
    email: match[2] ?? '',
    epoch: Number(match[3] ?? CLOCK_EPOCH_SEC),
    zone: match[4] ?? '+0000',
  };
}

// ---------------------------------------------------------------------------
// reachability, trees and diffs (all over one repo's object map)
// ---------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObj | undefined;

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree -> entries
 * (gitlinks skipped), tag -> its target, blob -> nothing. With `depth`, a commit
 * walk stops after that many generations (depth 1 is the root alone); tags are
 * followed without spending depth. `stopAt` ends a commit walk at those commits
 * without descending past them (a shallow clone's boundary). Throws on a missing
 * object unless `allowMissing` is set.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { depth?: number; stopAt?: ReadonlySet<string>; allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const root of roots) if (isOid(root)) queue.push({ oid: root, depth: 1 });
  while (queue.length > 0) {
    const item = queue.pop()!;
    if (seen.has(item.oid)) continue;
    const object = lookup(item.oid);
    if (object === undefined) {
      if (options.allowMissing === true) continue;
      throw new ForgeError(400, `object ${item.oid} is missing from the store`);
    }
    seen.add(item.oid);
    if (options.stopAt !== undefined && options.stopAt.has(item.oid)) continue;
    if (object.type === 'commit') {
      if (options.depth !== undefined && item.depth >= options.depth) continue;
      const commit = parseCommit(object.data);
      queue.push({ oid: commit.tree, depth: item.depth });
      for (const parent of commit.parents) queue.push({ oid: parent, depth: item.depth + 1 });
    } else if (object.type === 'tag') {
      queue.push({ oid: parseTag(object.data).object, depth: item.depth });
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push({ oid: entry.oid, depth: item.depth });
      }
    }
  }
  return seen;
}

/** The commits reachable from `tip`, newest first (parents after their child). */
export function walkCommits(tip: string, lookup: ObjectLookup): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || !isOid(oid)) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    const commit = parseCommit(object.data);
    for (let index = commit.parents.length - 1; index >= 0; index -= 1) {
      stack.push(commit.parents[index]!);
    }
  }
  return order;
}

/** True when `ancestor` is reachable from `tip` (or the two are the same commit). */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The merge-base of two commits: the newest commit reachable from both. */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const fromA = new Set(walkCommits(a, lookup));
  for (const oid of walkCommits(b, lookup)) {
    if (fromA.has(oid)) return oid;
  }
  return null;
}

/** A tree flattened to path -> {oid, mode}, following subtrees. */
export function flattenTree(treeOid: string, lookup: ObjectLookup): Map<string, { oid: string; mode: string }> {
  const flat = new Map<string, { oid: string; mode: string }>();
  const visit = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') visit(entry.oid, path);
      else if (entry.mode !== '160000') flat.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  visit(treeOid, '');
  return flat;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** The file-level difference between two flattened trees. */
export function diffFlat(
  before: ReadonlyMap<string, { oid: string; mode: string }>,
  after: ReadonlyMap<string, { oid: string; mode: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort(compareBytes)) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      changes.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      changes.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      changes.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  return changes;
}

/** Count the lines of a blob's text (a trailing newline does not add a line). */
export function countLines(data: Uint8Array): number {
  if (data.length === 0) return 0;
  const text = Buffer.from(data).toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/**
 * Build (and store) the tree objects for a flat path map, bottom-up.
 * Returns the root tree's object id. New tree objects are written into `store`.
 */
export function storeTreeFromFlat(
  flat: ReadonlyMap<string, { oid: string; mode: string }>,
  store: (type: ObjType, data: Buffer) => string,
): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const makeNode = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = makeNode();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = makeNode();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store('tree', buildTree(entries));
  };
  return build(root);
}

/** Peel a tag (recursively) to the object it ultimately names. */
export function peelToNonTag(oid: string, lookup: ObjectLookup): { oid: string; type: ObjType } {
  let current = oid;
  for (let hops = 0; hops < 10; hops += 1) {
    const object = lookup(current);
    if (object === undefined) return { oid: current, type: 'commit' };
    if (object.type !== 'tag') return { oid: current, type: object.type };
    current = parseTag(object.data).object;
  }
  return { oid: current, type: 'commit' };
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

const PKT_MAX = 65520;
const PKT_MAX_PAYLOAD = PKT_MAX - 4;

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function pktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > PKT_MAX_PAYLOAD) throw new ForgeError(400, `pkt-line payload is ${data.length} bytes, over the limit`);
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktKind = 'data' | 'flush' | 'delim' | 'end';

export interface PktItem {
  kind: PktKind;
  payload: Buffer;
}

/**
 * Decode a whole buffer of pkt-lines. Throws on a malformed header or a truncated
 * packet; a trailing run of raw bytes (a packfile after a flush) is returned as one
 * trailing 'end' item holding those bytes.
 */
export function decodePktLines(buffer: Uint8Array): PktItem[] {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const items: PktItem[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) {
      items.push({ kind: 'end', payload: buf.subarray(offset) });
      return items;
    }
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      items.push({ kind: 'end', payload: buf.subarray(offset) });
      return items;
    }
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      items.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      items.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      items.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_MAX) throw new ForgeError(400, `invalid pkt-line length ${head}`);
    if (offset + length > buf.length) throw new ForgeError(400, 'truncated pkt-line');
    items.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return items;
}

/** The data payloads of a decoded packet list, as UTF-8 lines without the newline. */
export function pktLinesToStrings(items: readonly PktItem[]): string[] {
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind !== 'data') continue;
    lines.push(item.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// packfile codec
// ---------------------------------------------------------------------------

/** Read a pack entry's type/size varint. */
function readPackSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new ForgeError(400, 'pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new ForgeError(400, 'pack entry size varint is truncated');
    byte = buffer[offset]!;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new ForgeError(400, 'pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

/** Read an ofs-delta entry's negative base offset. */
function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new ForgeError(400, 'ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new ForgeError(400, 'ofs-delta base offset is truncated');
    byte = buffer[offset]!;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new ForgeError(400, `zlib stream at offset ${offset} did not inflate: ${err instanceof Error ? err.message : String(err)}`);
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new ForgeError(400, `zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuf = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuf = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuf.length) throw new ForgeError(400, 'delta size varint is truncated');
      const byte = deltaBuf[offset]!;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
      if (shift > 63) throw new ForgeError(400, 'delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== baseBuf.length) {
    throw new ForgeError(400, `delta expects a ${sourceSize}-byte base, got ${baseBuf.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuf.length) {
    const op = deltaBuf[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuf.length) throw new ForgeError(400, 'delta copy offset is truncated');
          copyOffset += deltaBuf[offset]! * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuf.length) throw new ForgeError(400, 'delta copy size is truncated');
          copySize += deltaBuf[offset]! * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuf.length) throw new ForgeError(400, 'delta copy is out of the base');
      if (written + copySize > targetSize) throw new ForgeError(400, 'delta writes past its target size');
      baseBuf.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuf.length) throw new ForgeError(400, 'delta insert is truncated');
      if (written + literal > targetSize) throw new ForgeError(400, 'delta writes past its target size');
      deltaBuf.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new ForgeError(400, 'delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new ForgeError(400, `delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA
 * and REF_DELTA. `resolveBase` supplies a base a thin pack leaves out. Every
 * object's SHA-1 is recomputed and its declared size checked; the trailer
 * checksum must verify, or the pack is refused.
 */
export function readPack(
  pack: Uint8Array,
  options: { resolveBase?: ObjectLookup } = {},
): Map<string, GitObj> {
  const buf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buf.length < 32) throw new ForgeError(400, `pack is ${buf.length} bytes, too short`);
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new ForgeError(400, 'pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new ForgeError(400, `unsupported pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computed = sha1Hex(buf.subarray(0, trailerStart));
  if (trailer !== computed) throw new ForgeError(400, `pack trailer ${trailer} does not match its bytes ${computed}`);

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: ObjType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const head = readPackSize(buf, offset);
    offset = head.next;
    const typeCode = (head.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: head.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(buf, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new ForgeError(400, `ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new ForgeError(400, 'ref-delta base id is truncated');
      entry.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new ForgeError(400, `pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buf.subarray(0, trailerStart), offset);
    if (inflated.data.length !== head.size) {
      throw new ForgeError(400, `pack entry at ${entryOffset} declares ${head.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new ForgeError(400, `pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const objects = new Map<string, GitObj>();
  const byOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new ForgeError(400, `delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new ForgeError(400, `ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = byOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (external === undefined) {
          throw new ForgeError(400, `ref-delta base ${wanted} is neither in the pack nor supplied`);
        }
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    byOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

/** Encode one object's pack header: the type/size varint git's pack format uses. */
function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). The trailer is SHA-1 over all before it. */
export function writePack(objects: Iterable<GitObj>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const head = Buffer.allocUnsafe(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  parts.push(head);
  for (const object of list) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Verify a pack's trailer checksum without parsing its objects. */
export function packChecksumOk(pack: Uint8Array): boolean {
  const buf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buf.length < 20) return false;
  return sha1Hex(buf.subarray(0, buf.length - 20)) === buf.subarray(buf.length - 20).toString('hex');
}

// ---------------------------------------------------------------------------
// the store: repositories, issues, pull requests, labels, comments
// ---------------------------------------------------------------------------

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  gid: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  id: number;
  gid: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: LabelRec[];
  author: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: CommentRec[];
}

export interface PullRec {
  id: number;
  gid: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  closedAt: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoRec {
  id: number;
  gid: string;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  issues: IssueRec[];
  pulls: PullRec[];
  labels: Map<string, LabelRec>;
  nextNumber: number;
  nextLabelId: number;
}

/** The forge's whole state: one map of repositories plus the id counters. */
export class Store {
  readonly repos = new Map<string, RepoRec>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private clockSeq = 0;
  private requestSeq = 0;

  /** The deterministic clock: fixed epoch plus one second per tick, as ISO text. */
  tick(): { iso: string; epoch: number } {
    const epoch = CLOCK_EPOCH_SEC + this.clockSeq;
    this.clockSeq += 1;
    return { iso: new Date(epoch * 1000).toISOString(), epoch };
  }

  /** A unique request id for the X-GitHub-Request-Id header. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq.toString(16).padStart(8, '0')}`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  repoGid(owner: string, name: string): string {
    return toB64Url(`repo:${owner}/${name}`);
  }

  issueGid(owner: string, name: string, number: number): string {
    return toB64Url(`issue:${owner}/${name}:${number}`);
  }

  pullGid(owner: string, name: string, number: number): string {
    return toB64Url(`pull:${owner}/${name}:${number}`);
  }

  commentGid(owner: string, name: string, number: number, commentId: number): string {
    return toB64Url(`comment:${owner}/${name}:${number}:${commentId}`);
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): RepoRec {
    const now = this.tick().iso;
    const repo: RepoRec = {
      id: this.nextRepoId,
      gid: this.repoGid(owner, name),
      owner,
      name,
      private: isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
      pushedAt: null,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      nextLabelId: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** Store one object, returning its id (an existing identical object is kept). */
  putObject(repo: RepoRec, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: RepoRec): ObjectLookup {
    return (oid: string) => repo.objects.get(oid);
  }

  createIssue(repo: RepoRec, title: string, body: string, labels: LabelRec[]): IssueRec {
    const now = this.tick().iso;
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: IssueRec = {
      id: this.nextIssueId,
      gid: this.issueGid(repo.owner, repo.name, number),
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      author: VIEWER_LOGIN,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      comments: [],
    };
    this.nextIssueId += 1;
    repo.issues.push(issue);
    return issue;
  }

  createComment(repo: RepoRec, issue: IssueRec, body: string): CommentRec {
    const now = this.tick().iso;
    const comment: CommentRec = {
      id: this.nextCommentId,
      gid: this.commentGid(repo.owner, repo.name, issue.number, this.nextCommentId),
      body,
      author: VIEWER_LOGIN,
      createdAt: now,
      updatedAt: now,
    };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  createPull(
    repo: RepoRec,
    title: string,
    body: string,
    headRef: string,
    headSha: string,
    baseRef: string,
    baseSha: string,
  ): PullRec {
    const now = this.tick().iso;
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: PullRec = {
      id: this.nextPullId,
      gid: this.pullGid(repo.owner, repo.name, number),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      closedAt: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      author: VIEWER_LOGIN,
      createdAt: now,
      updatedAt: now,
    };
    this.nextPullId += 1;
    repo.pulls.push(pull);
    return pull;
  }

  findIssue(repo: RepoRec, number: number): IssueRec | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  findPull(repo: RepoRec, number: number): PullRec | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** Resolve a Relay global id to the record it names, or null. */
  resolveGlobalId(gid: string): { kind: string; repo: RepoRec; issue?: IssueRec; pull?: PullRec } | null {
    const decoded = fromB64Url(gid);
    if (decoded === null) return null;
    const parts = decoded.split(':');
    if (parts[0] === 'repo' && parts.length === 3) {
      const repo = this.getRepo(parts[1]!, parts[2]!);
      return repo === undefined ? null : { kind: 'repo', repo };
    }
    if (parts[0] === 'issue' && parts.length === 4) {
      const repo = this.getRepo(parts[1]!, parts[2]!);
      if (repo === undefined) return null;
      const issue = this.findIssue(repo, Number(parts[3]));
      return issue === undefined ? null : { kind: 'issue', repo, issue };
    }
    if (parts[0] === 'pull' && parts.length === 4) {
      const repo = this.getRepo(parts[1]!, parts[2]!);
      if (repo === undefined) return null;
      const pull = this.findPull(repo, Number(parts[3]));
      return pull === undefined ? null : { kind: 'pull', repo, pull };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON presenters (REST shapes)
// ---------------------------------------------------------------------------

function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER_LOGIN ? VIEWER_ID : 0,
    node_id: toB64Url(`user:${login}`),
    type: 'User',
    site_admin: false,
  };
}

function repoJson(repo: RepoRec, host: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.gid,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `http://${host}/${repo.owner}/${repo.name}`,
    clone_url: `http://${host}/${repo.owner}/${repo.name}.git`,
    git_url: `git://${host}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@${host}:${repo.owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    fork: false,
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    language: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: LabelRec, host: string): Record<string, unknown> {
  return {
    id: label.id,
    node_id: toB64Url(`label:${label.name}`),
    name: label.name,
    color: label.color,
    description: label.description,
    url: `http://${host}/labels/${encodeURIComponent(label.name)}`,
    default: false,
  };
}

function issueJson(issue: IssueRec, repo: RepoRec, host: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.gid,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(issue.author),
    labels: issue.labels.map((label) => labelJson(label, host)),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `http://${host}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
  };
}

function commentJson(comment: CommentRec, repo: RepoRec, issue: IssueRec, host: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.gid,
    body: comment.body,
    user: userJson(comment.author),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `http://${host}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

/** The files a pull request changes, from its merge-base to its head. */
export function pullFiles(store: Store, repo: RepoRec, pull: PullRec): Array<{
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string | null;
}> {
  const lookup = store.lookup(repo);
  const base = mergeBase(pull.headSha, pull.baseSha, lookup);
  const baseTree = base === null ? EMPTY_TREE_OID : parseCommit(lookup(base)!.data).tree;
  const headTree = parseCommit(lookup(pull.headSha)!.data).tree;
  const before = baseTree === EMPTY_TREE_OID ? new Map() : flattenTree(baseTree, lookup);
  const after = flattenTree(headTree, lookup);
  const out: Array<{
    filename: string;
    status: 'added' | 'modified' | 'removed';
    additions: number;
    deletions: number;
    changes: number;
    sha: string | null;
  }> = [];
  for (const change of diffFlat(before, after)) {
    let additions = 0;
    let deletions = 0;
    if (change.newOid !== null) {
      const object = lookup(change.newOid);
      if (object !== undefined) additions = countLines(object.data);
    }
    if (change.oldOid !== null) {
      const object = lookup(change.oldOid);
      if (object !== undefined) deletions = countLines(object.data);
    }
    if (change.status === 'modified') {
      // A rough line count: lines unique to each side, by multiset difference.
      const oldLines = change.oldOid !== null && lookup(change.oldOid) !== undefined ? Buffer.from(lookup(change.oldOid)!.data).toString('utf8').split('\n') : [];
      const newLines = change.newOid !== null && lookup(change.newOid) !== undefined ? Buffer.from(lookup(change.newOid)!.data).toString('utf8').split('\n') : [];
      const oldCounts = new Map<string, number>();
      for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
      let shared = 0;
      for (const line of newLines) {
        const left = oldCounts.get(line) ?? 0;
        if (left > 0) {
          oldCounts.set(line, left - 1);
          shared += 1;
        }
      }
      additions = newLines.length - shared;
      deletions = oldLines.length - shared;
    }
    out.push({
      filename: change.path,
      status: change.status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: change.newOid,
    });
  }
  return out;
}

function pullJson(store: Store, repo: RepoRec, pull: PullRec, host: string): Record<string, unknown> {
  const files = pullFiles(store, repo, pull);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const lookup = store.lookup(repo);
  const base = mergeBase(pull.headSha, pull.baseSha, lookup);
  let commits = 0;
  if (base !== null) {
    const headCommits = new Set(walkCommits(pull.headSha, lookup));
    const baseCommits = new Set(walkCommits(base, lookup));
    for (const oid of headCommits) if (!baseCommits.has(oid)) commits += 1;
  } else {
    commits = walkCommits(pull.headSha, lookup).length;
  }
  return {
    id: pull.id,
    node_id: pull.gid,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: userJson(pull.author),
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: userJson(repo.owner),
      repo: repoJson(repo, host),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: userJson(repo.owner),
      repo: repoJson(repo, host),
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open',
    mergeable_state: pull.state === 'open' ? 'clean' : 'unknown',
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    draft: false,
    locked: false,
    commits,
    additions,
    deletions,
    changed_files: files.length,
    html_url: `http://${host}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    diff_url: `http://${host}/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `http://${host}/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  host: string;
  requestId: string;
  query: URLSearchParams;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_BODY_BYTES) {
        reject(new ForgeError(413, 'request body is too large'));
        return;
      }
      chunks.push(bytes);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(new ForgeError(400, err.message)));
  });
}

/** Parse a JSON request body; an empty body is null, malformed JSON is a 400. */
function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw badRequest('request body is not valid JSON');
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown, ctx: Ctx, extra: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': ctx.requestId,
    'x-oauth-scopes': '',
    'content-length': payload.length,
    ...extra,
  });
  res.end(payload);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, ctx: Ctx): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': ctx.requestId,
    'x-oauth-scopes': '',
    'content-length': body.length,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string, ctx: Ctx): void {
  sendJson(res, status, { message }, ctx);
}

/** The bearer token check every API call makes first. */
function requireAuth(req: IncomingMessage, ctx: Ctx, res: ServerResponse): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^token\s+(\S+)$/.exec(header);
  const presented = match !== null ? match[1]! : '';
  if (presented === '' || presented !== SHOP_TOKEN) {
    sendJson(res, 401, { message: 'Bad credentials' }, ctx);
    return false;
  }
  return true;
}

/** A repository that must exist and belong to the viewer, else 404. */
function needRepo(store: Store, owner: string, name: string): RepoRec {
  if (owner !== VIEWER_LOGIN) throw notFound(`repository ${owner}/${name} does not exist`);
  const repo = store.getRepo(owner, name);
  if (repo === undefined) throw notFound(`repository ${owner}/${name} does not exist`);
  return repo;
}

/** Parse the page/per_page query pair, clamping to sane bounds. */
function paging(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/** Build an RFC 5988 Link header for a paginated collection (same origin, absolute). */
function linkHeader(host: string, path: string, page: number, perPage: number, total: number): string {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const url = (p: number): string => `http://${host}${path}?page=${p}&per_page=${perPage}`;
  const parts: string[] = [];
  if (page < lastPage) parts.push(`<${url(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${url(page - 1)}>; rel="prev"`);
  parts.push(`<${url(1)}>; rel="first"`);
  parts.push(`<${url(lastPage)}>; rel="last"`);
  return parts.join(', ');
}

/** Slice one page out of a list and say whether a next page exists. */
function pageSlice<T>(items: readonly T[], page: number, perPage: number): { pageItems: T[]; hasNext: boolean } {
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), hasNext: start + perPage < items.length };
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

/** A commit's ref line for a ref advertisement: `<oid> <ref>\n`. */
function refLine(oid: string, ref: string): Buffer {
  return pktLine(`${oid} ${ref}\n`);
}

/**
 * The upload-pack advertisement. Protocol v2 first (a `version 2` service line
 * plus capabilities), the v0 ref list after it. HEAD always comes first and
 * carries the v0 capabilities after a NUL byte; annotated tags add a peeled
 * `^{}` line; an empty repository advertises the capabilities pseudo-ref.
 */
function advertisement(repo: RepoRec, wantV2: boolean): Buffer {
  const chunks: Buffer[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => compareBytes(a[0], b[0]));
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (wantV2) {
    chunks.push(
      pktLine('# service=git-upload-pack\n'),
      pktFlush(),
      pktLine('version 2\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      pktLine(`agent=${FORGE_AGENT}\n`),
      pktFlush(),
    );
  }
  const capsV0 =
    ` symref=HEAD:${headRef} multi_ack side-band-64k thin-pack ofs-delta shallow agent=${FORGE_AGENT}\0`;
  if (refs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${capsV0.slice(1)}\n`), pktFlush());
  } else {
    let first = true;
    for (const [ref, oid] of refs) {
      if (ref === headRef && first) {
        chunks.push(pktLine(`${oid} HEAD\0${capsV0.slice(1)}\n`));
        first = false;
      }
      if (ref === headRef) chunks.push(refLine(oid, ref));
      else chunks.push(refLine(oid, ref));
    }
    if (first) {
      // HEAD exists but was not the first sorted ref: advertise it with the caps.
      chunks.splice(chunks.length - refs.length, 0, pktLine(`${headOid ?? ZERO_OID} HEAD\0${capsV0.slice(1)}\n`));
    }
    for (const [ref, oid] of refs) {
      const peeled = peelToNonTag(oid, repo.objects.get.bind(repo.objects));
      if (peeled.type === 'commit' && peeled.oid !== oid) {
        chunks.push(pktLine(`${peeled.oid} ${ref}^{}\n`));
      }
    }
    chunks.push(pktFlush());
  }
  return Buffer.concat(chunks);
}

/** The receive-pack advertisement (v0): service line, refs, capabilities, flush. */
function receiveAdvertisement(repo: RepoRec): Buffer {
  const chunks: Buffer[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => compareBytes(a[0], b[0]));
  const caps = ` report-status report-status-v2 delete-refs side-band-64k ofs-delta quiet atomic agent=${FORGE_AGENT}\0`;
  if (refs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps.slice(1)}\n`), pktFlush());
  } else {
    let first = true;
    for (const [ref, oid] of refs) {
      if (first) {
        chunks.push(pktLine(`${oid} ${ref}\0${caps.slice(1)}\n`));
        first = false;
      } else {
        chunks.push(refLine(oid, ref));
      }
    }
    for (const [ref, oid] of refs) {
      const peeled = peelToNonTag(oid, repo.objects.get.bind(repo.objects));
      if (peeled.type === 'commit' && peeled.oid !== oid) {
        chunks.push(pktLine(`${peeled.oid} ${ref}^{}\n`));
      }
    }
    chunks.push(pktFlush());
  }
  return Buffer.concat(chunks);
}

/** The object set a fetch must send: wanted closure minus the haves closure. */
function fetchSelection(
  repo: RepoRec,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  deepenSince: number | null,
  deepenNot: readonly string[],
  shallow: ReadonlySet<string>,
): { objects: GitObj[]; shallowInfo: string[]; unshallow: string[] } {
  const lookup = repo.objects.get.bind(repo.objects);
  const wantSet = new Set(wants.filter((oid) => repo.objects.has(oid)));
  if (wantSet.size === 0) return { objects: [], shallowInfo: [], unshallow: [] };
  const stop = new Set<string>([...shallow, ...deepenNot]);
  const included = collectReachable(wantSet, lookup, {
    depth: depth ?? undefined,
    stopAt: stop,
    allowMissing: true,
  });
  const excluded = collectReachable(haves, lookup, { stopAt: stop, allowMissing: true });
  const objects: GitObj[] = [];
  for (const oid of [...included].sort(compareBytes)) {
    if (excluded.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  const shallowInfo: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null || deepenSince !== null) {
    for (const oid of included) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0) continue;
      const parentsIncluded = parents.some((parent) => included.has(parent));
      if (!parentsIncluded) shallowInfo.push(oid);
    }
  }
  for (const oldBoundary of shallow) {
    const object = repo.objects.get(oldBoundary);
    if (object === undefined || object.type !== 'commit') continue;
    if (parseCommit(object.data).parents.some((parent) => included.has(parent))) {
      unshallow.push(oldBoundary);
    }
  }
  shallowInfo.sort(compareBytes);
  unshallow.sort(compareBytes);
  return { objects, shallowInfo, unshallow };
}

/** Wrap a packfile as sideband band-1 packets, each carrying at most 32768 bytes. */
function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < pack.length) {
    const slice = pack.subarray(offset, offset + 32768);
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    offset += slice.length;
  }
  return Buffer.concat(chunks);
}

/**
 * Handle GET /{owner}/{repo}.git/info/refs?service=git-upload-pack (v0 advertise
 * and the v2 preamble) and service=git-receive-pack. Anything else is a 400.
 */
function handleInfoRefs(req: IncomingMessage, res: ServerResponse, ctx: Ctx, owner: string, name: string): void {
  const service = ctx.query.get('service') ?? '';
  const repo = needRepo(ctx.store, owner, name);
  if (service === 'git-upload-pack') {
    const wantV2 = req.headers['git-protocol'] === 'version=2' || req.headers['git-protocol']?.includes('version=2') === true;
    sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', advertisement(repo, wantV2), ctx);
    return;
  }
  if (service === 'git-receive-pack') {
    sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', receiveAdvertisement(repo), ctx);
    return;
  }
  throw badRequest(`unsupported info/refs service ${JSON.stringify(service)}`);
}

/** The ls-refs capability lines the client asked for. */
interface LsRefsOptions {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefix: string[];
}

/** Parse a v2 ls-refs command's arguments into the options the reply needs. */
function parseLsRefsArgs(lines: readonly string[]): LsRefsOptions {
  const options: LsRefsOptions = { peel: false, symrefs: false, unborn: false, prefix: [] };
  for (const line of lines) {
    if (line === 'peel') options.peel = true;
    else if (line === 'symrefs') options.symrefs = true;
    else if (line === 'unborn') options.unborn = true;
    else if (line.startsWith('ref-prefix ')) options.prefix.push(line.slice('ref-prefix '.length));
  }
  return options;
}

/** One ls-refs reply line: `<oid> <ref> [ key:value ...]`. */
function lsRefLine(oid: string, ref: string, attrs: string[]): Buffer {
  const suffix = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
  return pktLine(`${oid} ${ref}${suffix}\n`);
}

/** Answer a v2 ls-refs command, filtering by ref-prefix server-side. */
function handleLsRefs(repo: RepoRec, lines: readonly string[]): Buffer {
  const options = parseLsRefsArgs(lines);
  const chunks: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  const prefixMatch = (ref: string): boolean =>
    options.prefix.length === 0 || options.prefix.some((prefix) => ref.startsWith(prefix));
  if (headOid !== undefined && prefixMatch('HEAD')) {
    const attrs: string[] = [];
    if (options.symrefs) attrs.push(`symref-target:${headRef}`);
    chunks.push(lsRefLine(headOid, 'HEAD', attrs));
  }
  const refs = [...repo.refs.entries()].sort((a, b) => compareBytes(a[0], b[0]));
  for (const [ref, oid] of refs) {
    if (!prefixMatch(ref)) continue;
    const attrs: string[] = [];
    if (options.peel) {
      const peeled = peelToNonTag(oid, repo.objects.get.bind(repo.objects));
      if (peeled.type === 'commit' && peeled.oid !== oid) attrs.push(`peeled:${peeled.oid}`);
    }
    chunks.push(lsRefLine(oid, ref, attrs));
  }
  if (headOid === undefined && options.unborn && prefixMatch('HEAD')) {
    chunks.push(lsRefLine(ZERO_OID, 'HEAD', [`symref-target:${headRef}`]));
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

/** The parsed arguments of a v2 fetch command. */
interface FetchArgs {
  wants: string[];
  haves: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  filter: string | null;
  shallow: string[];
}

/** Parse a v2 fetch command's arguments (after the command + delim lines). */
function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = {
    wants: [],
    haves: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
    filter: null,
    shallow: [],
  };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5));
    else if (line.startsWith('have ')) args.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n >= 0) args.depth = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = Number.parseInt(line.slice(13), 10);
      if (Number.isFinite(n) && n >= 0) args.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11));
    else if (line.startsWith('filter ')) args.filter = line.slice(7);
    else if (line === 'done') break;
  }
  return args;
}

/**
 * Answer a v2 fetch: acknowledgments (NAK, since this forge's protocol v2 fetch
 * does not negotiate a common tip), shallow-info, wanted-refs, then the packfile
 * in sideband band 1. The packfile section is omitted when nothing must be sent.
 */
function handleFetchV2(repo: RepoRec, args: FetchArgs): Buffer {
  const chunks: Buffer[] = [];
  const lookup = repo.objects.get.bind(repo.objects);
  const wantedOids = args.wants.filter((oid) => repo.objects.has(oid));
  const shallow = new Set(args.shallow);
  const selection = fetchSelection(repo, args.wants, args.haves, args.depth, args.deepenSince, args.deepenNot, shallow);
  chunks.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim());
  if (selection.shallowInfo.length > 0 || selection.unshallow.length > 0) {
    chunks.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallowInfo) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
    chunks.push(pktDelim());
  }
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const [ref, oid] of repo.refs) {
    if (args.wants.includes(oid) || wantedOids.includes(oid)) {
      if (!wantedRefs.some((entry) => entry.ref === ref && entry.oid === oid)) wantedRefs.push({ oid, ref });
    }
  }
  if (wantedRefs.length > 0) {
    chunks.push(pktLine('wanted-refs\n'));
    for (const entry of wantedRefs) chunks.push(pktLine(`${entry.oid} ${entry.ref}\n`));
    chunks.push(pktDelim());
  }
  if (selection.objects.length > 0) {
    chunks.push(pktLine('packfile\n'));
    chunks.push(sidebandPack(writePack(selection.objects)));
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

/** The parsed arguments of a v0 fetch: wants, haves, done. */
interface FetchV0Args {
  wants: string[];
  haves: string[];
  depth: number | null;
}

/** Parse a v0 fetch request: want lines, flush, have lines, done, flush. */
function parseFetchV0(items: readonly PktItem[]): FetchV0Args {
  const args: FetchV0Args = { wants: [], haves: [], depth: null };
  let seenFlush = false;
  for (const item of items) {
    if (item.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (item.kind !== 'data') continue;
    const line = item.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ') && !seenFlush) args.wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5));
    else if (line === 'done') break;
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n >= 0) args.depth = n;
    }
  }
  return args;
}

/** Answer a v0 fetch: NAK, shallow lines, the sideband pack, flush. */
function handleFetchV0(repo: RepoRec, args: FetchV0Args): Buffer {
  const selection = fetchSelection(repo, args.wants, args.haves, args.depth, null, [], new Set());
  const chunks: Buffer[] = [pktLine('NAK\n')];
  for (const oid of selection.shallowInfo) chunks.push(pktLine(`shallow ${oid}\n`));
  if (selection.objects.length > 0) chunks.push(sidebandPack(writePack(selection.objects)));
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

/**
 * Handle POST /{owner}/{repo}.git/git-upload-pack: a v2 command stream
 * (ls-refs or fetch) or a v0 fetch. A request that is not a pkt-line stream is
 * refused with 400 and the server keeps serving.
 */
function handleUploadPack(repo: RepoRec, body: Buffer): Buffer {
  if (body.length < 4 || !/^[0-9a-fA-F]{4}$/.test(body.subarray(0, 4).toString('ascii'))) {
    throw badRequest('upload-pack request is not a pkt-line stream');
  }
  let items: PktItem[];
  try {
    items = decodePktLines(body);
  } catch (err) {
    if (err instanceof ForgeError) throw err;
    throw badRequest('upload-pack request is not a valid pkt-line stream');
  }
  const first = items.find((item) => item.kind === 'data');
  if (first === undefined) throw badRequest('upload-pack request has no command');
  const firstLine = first.payload.toString('utf8').replace(/\n$/, '');
  if (firstLine === 'version 2') {
    const commandItem = items.filter((item) => item.kind === 'data')[1];
    if (commandItem === undefined) throw badRequest('protocol v2 request has no command');
    const command = commandItem.payload.toString('utf8').replace(/\n$/, '');
    const rest = pktLinesToStrings(items.filter((item) => item.kind === 'data').slice(2));
    if (command === 'command=ls-refs') return handleLsRefs(repo, rest);
    if (command === 'command=fetch') return handleFetchV2(repo, parseFetchArgs(rest));
    throw badRequest(`unsupported protocol v2 command ${JSON.stringify(command)}`);
  }
  if (firstLine.startsWith('want ') || firstLine.startsWith('deepen ')) {
    return handleFetchV0(repo, parseFetchV0(items));
  }
  throw badRequest(`unsupported upload-pack command ${JSON.stringify(firstLine)}`);
}

/** One ref update from a receive-pack command line. */
interface ReceiveCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  index: number;
}

/** Parse the pkt-framed command lines that open a receive-pack request. */
function parseReceiveCommands(items: readonly PktItem[]): ReceiveCommand[] {
  const commands: ReceiveCommand[] = [];
  for (const item of items) {
    if (item.kind === 'flush') break;
    if (item.kind !== 'data') continue;
    const line = item.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const clean = nul < 0 ? line : line.slice(0, nul);
    const parts = clean.trim().split(/\s+/);
    if (parts.length !== 3) throw badRequest(`bad receive-pack command ${JSON.stringify(line)}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid)) throw badRequest('receive-pack command has a bad object id');
    commands.push({ oldOid, newOid, ref, index: commands.length });
  }
  return commands;
}

/**
 * Apply the objects of a received pack, then validate and apply each ref update
 * in order. Fast-forwarding is checked by walking parents; a refused ref keeps
 * its old value. The report is `unpack ok` plus one `ok`/`ng` line per ref,
 * pkt-framed inside sideband band 1, and the response is HTTP 200 even when a
 * ref is refused. A delete-only push sends no pack: the raw bytes after the
 * command flush are empty.
 */
function handleReceivePack(store: Store, repo: RepoRec, body: Buffer): Buffer {
  let items: PktItem[];
  try {
    items = decodePktLines(body);
  } catch (err) {
    if (err instanceof ForgeError) throw err;
    throw badRequest('receive-pack request is not a valid pkt-line stream');
  }
  const commands = parseReceiveCommands(items);
  if (commands.length === 0) throw badRequest('receive-pack request has no commands');
  // The packfile, if any, is the raw bytes after the first flush.
  let packBytes: Buffer | null = null;
  let afterFlush = false;
  let offset = 0;
  while (offset < body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      if (afterFlush) packBytes = Buffer.from(body.subarray(offset));
      break;
    }
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      afterFlush = true;
      continue;
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_MAX || offset + length > body.length) {
      if (afterFlush) packBytes = Buffer.from(body.subarray(offset));
      break;
    }
    offset += length;
  }
  const hasPack = packBytes !== null && packBytes.length > 0;
  if (hasPack) {
    const objects = readPack(packBytes!, { resolveBase: store.lookup(repo) });
    for (const [oid, object] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  const report: string[] = ['unpack ok'];
  const lookup = store.lookup(repo);
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    const isCreate = command.oldOid === ZERO_OID;
    const isDelete = command.newOid === ZERO_OID;
    if (isCreate && current !== undefined) {
      report.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    if (!isCreate && current === undefined) {
      report.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    if (!isCreate && current !== command.oldOid) {
      report.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    if (isDelete) {
      repo.refs.delete(command.ref);
      report.push(`ok ${command.ref}`);
      continue;
    }
    const object = repo.objects.get(command.newOid);
    if (object === undefined) {
      report.push(`ng ${command.ref} missing object ${command.newOid}`);
      continue;
    }
    const kind = refKind(command.ref);
    if (kind === 'heads') {
      if (object.type !== 'commit') {
        report.push(`ng ${command.ref} not a commit`);
        continue;
      }
      if (!isCreate && !isAncestor(command.oldOid, command.newOid, lookup)) {
        report.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      const base = isCreate ? EMPTY_TREE_OID : parseCommit(lookup(command.oldOid)!.data).tree;
      const tip = parseCommit(object.data).tree;
      const before = base === EMPTY_TREE_OID ? new Map() : flattenTree(base, lookup);
      const after = flattenTree(tip, lookup);
      const missing = diffFlat(before, after).some((change) => change.newOid !== null && !repo.objects.has(change.newOid!));
      if (missing) {
        report.push(`ng ${command.ref} missing object`);
        continue;
      }
    } else if (kind === 'tags') {
      if (object.type !== 'commit' && object.type !== 'tag') {
        report.push(`ng ${command.ref} not a commit or tag`);
        continue;
      }
    } else {
      report.push(`ng ${command.ref} invalid ref`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}`);
  }
  if (repo.refs.size === 0) {
    repo.pushedAt = null;
  } else {
    repo.pushedAt = store.tick().iso;
  }
  const chunks: Buffer[] = [];
  for (const line of report) {
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(`${line}\n`, 'utf8')])));
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

/** The tip commit of a branch, or null when the branch has no commit yet. */
function branchTip(repo: RepoRec, branch: string): { oid: string; commit: CommitView } | null {
  const oid = repo.refs.get(headRefOf(branch));
  if (oid === undefined) return null;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return { oid, commit: parseCommit(object.data) };
}

/** A commit's JSON, as GET /commits and the branch view return it. */
function commitJson(store: Store, repo: RepoRec, oid: string, host: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') throw notFound(`commit ${oid} does not exist`);
  const view = parseCommit(object.data);
  const author = parseIdent(view.author);
  const committer = parseIdent(view.committer);
  return {
    sha: oid,
    node_id: toB64Url(`commit:${repo.owner}/${repo.name}:${oid}`),
    commit: {
      message: view.message,
      author: { name: author.name, email: author.email, date: new Date(author.epoch * 1000).toISOString() },
      committer: { name: committer.name, email: committer.email, date: new Date(committer.epoch * 1000).toISOString() },
      tree: { sha: view.tree, url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${view.tree}` },
      url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
    },
    parents: view.parents.map((parent) => ({ sha: parent, url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${parent}` })),
    author: userJson(author.name === 'Conformance' ? VIEWER_LOGIN : author.name),
    committer: userJson(committer.name === 'Conformance' ? VIEWER_LOGIN : committer.name),
    html_url: `http://${host}/${repo.owner}/${repo.name}/commit/${oid}`,
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
  };
}

/**
 * Write one file version: store the blob, rebuild the affected trees, mint the
 * commit on `branch` (creating the branch from the default tip when needed), and
 * advance the branch ref. Returns the new commit id. A `null` blob removes the path.
 */
function writeContentsCommit(
  store: Store,
  repo: RepoRec,
  branch: string,
  path: string,
  blob: { oid: string; mode: string } | null,
  message: string,
): string {
  const tip = branchTip(repo, branch);
  const baseTree = tip === null ? EMPTY_TREE_OID : tip.commit.tree;
  const lookup = store.lookup(repo);
  const flat = baseTree === EMPTY_TREE_OID ? new Map() : flattenTree(baseTree, lookup);
  if (blob === null) flat.delete(path);
  else flat.set(path, blob);
  const storeIntoRepo = (type: ObjType, data: Buffer): string => store.putObject(repo, type, data);
  const treeOid = storeTreeFromFlat(flat, storeIntoRepo);
  const stamp = store.tick();
  const commit = buildCommit({
    tree: treeOid,
    parents: tip === null ? [] : [tip.oid],
    message,
    timestamp: stamp.epoch,
  });
  const commitOid = store.putObject(repo, 'commit', commit);
  repo.refs.set(headRefOf(branch), commitOid);
  repo.pushedAt = stamp.iso;
  return commitOid;
}

/** The one directory entry GET /contents returns for a tree (files and dirs). */
function directoryJson(
  store: Store,
  repo: RepoRec,
  treeOid: string,
  prefix: string,
  host: string,
): Array<Record<string, unknown>> {
  const lookup = store.lookup(repo);
  const object = lookup(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  const entries = parseTree(object.data).sort(compareTreeEntries);
  const out: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const isDir = entry.mode === '40000';
    out.push({
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path,
      sha: entry.oid,
      size: isDir ? 0 : (lookup(entry.oid)?.data.length ?? 0),
      url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `http://${host}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
      download_url: isDir ? null : `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      _links: { self: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}` },
    });
  }
  return out;
}

/** Look a path up in a tree, returning its blob entry or null. */
function treeLookupPath(
  store: Store,
  repo: RepoRec,
  treeOid: string,
  path: string,
): { oid: string; mode: string } | null {
  const lookup = store.lookup(repo);
  const segments = path.split('/').filter((piece) => piece !== '');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = lookup(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  body: Buffer,
): boolean {
  const store = ctx.store;
  const host = ctx.host;
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const segments = splitPath(url.pathname);
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const rest = segments.slice(2);

  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    sendJson(res, 200, {
      current_user_url: `http://${host}/api/v3/user`,
      repository_url: `http://${host}/api/v3/repos/{owner}/{repo}`,
      user_url: `http://${host}/api/v3/users/{username}`,
    }, ctx);
    return true;
  }

  // GET /api/v3/meta — the version the suite checks for.
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' }, ctx);
    return true;
  }

  // GET /api/v3/user — the authenticated viewer.
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(res, 200, {
      ...userJson(VIEWER_LOGIN),
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      avatar_url: `http://${host}/avatars/${VIEWER_LOGIN}`,
      html_url: `http://${host}/${VIEWER_LOGIN}`,
      public_repos: store.repos.size,
      followers: 0,
      following: 0,
    }, ctx);
    return true;
  }

  // POST /api/v3/user/repos — create a repository for the viewer.
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos' && method === 'POST') {
    const payload = parseJsonBody(body);
    if (!isRecord(payload)) throw badRequest('create repository needs a JSON object body');
    const name = asString(payload.name, '').trim();
    if (name === '') throw unprocessable('repository name is required');
    if (/[/\\]/.test(name)) throw unprocessable(`repository name ${JSON.stringify(name)} is invalid`);
    const existing = store.getRepo(VIEWER_LOGIN, name);
    if (existing !== undefined) throw unprocessable(`repository ${name} already exists`);
    const repo = store.createRepo(
      VIEWER_LOGIN,
      name,
      asBoolean(payload.private, false),
      asString(payload.description, ''),
    );
    sendJson(res, 201, repoJson(repo, host), ctx);
    return true;
  }

  // GET /api/v3/user/repos — the viewer's repositories, paginated.
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos' && method === 'GET') {
    const owned = [...store.repos.values()]
      .filter((repo) => repo.owner === VIEWER_LOGIN)
      .sort((a, b) => a.id - b.id);
    const { page, perPage } = paging(ctx.query);
    const { pageItems, hasNext } = pageSlice(owned, page, perPage);
    const links = linkHeader(host, '/api/v3/user/repos', page, perPage, owned.length);
    sendJson(res, 200, pageItems.map((repo) => repoJson(repo, host)), ctx, { link: links, 'x-total-count': String(owned.length) });
    void hasNext;
    return true;
  }

  // Everything below is scoped to one repository: /api/v3/repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]!;
    const name = rest[2]!;
    const tail = rest.slice(3);
    const repo = needRepo(store, owner, name);

    // The repository itself.
    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo, host), ctx);
        return true;
      }
      if (method === 'PATCH') {
        const payload = parseJsonBody(body);
        if (!isRecord(payload)) throw badRequest('patch repository needs a JSON object body');
        if (typeof payload.description === 'string') repo.description = payload.description;
        if (typeof payload.private === 'boolean') repo.private = payload.private;
        repo.updatedAt = store.tick().iso;
        sendJson(res, 200, repoJson(repo, host), ctx);
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        res.writeHead(204, { 'x-github-request-id': ctx.requestId, 'x-oauth-scopes': '' });
        res.end();
        return true;
      }
      throw new ForgeError(405, `method ${method} is not allowed on a repository`);
    }

    // Branches: list, and one branch by name.
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => refKind(ref) === 'heads')
          .sort(compareBytes)
          .map((ref) => {
            const branch = ref.slice('refs/heads/'.length);
            return {
              name: branch,
              commit: { sha: repo.refs.get(ref), url: `http://${host}/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(ref)}` },
              protected: false,
            };
          });
        sendJson(res, 200, branches, ctx);
        return true;
      }
      if (tail.length === 2 && method === 'GET') {
        const branch = tail[1]!;
        const tip = branchTip(repo, branch);
        if (tip === null) throw notFound(`branch ${branch} does not exist`);
        sendJson(res, 200, {
          name: branch,
          commit: { sha: tip.oid, url: `http://${host}/api/v3/repos/${owner}/${name}/commits/${tip.oid}` },
          protected: false,
        }, ctx);
        return true;
      }
    }

    // Commits: list (newest first, optionally from one ref), and one by sha.
    if (tail[0] === 'commits') {
      if (tail.length === 1 && method === 'GET') {
        const sha = ctx.query.get('sha');
        const tipRef = sha === null ? headRefOf(repo.defaultBranch) : (isOid(sha) ? null : headRefOf(sha));
        const tipOid = tipRef === null ? sha : repo.refs.get(tipRef);
        if (tipOid === undefined || tipOid === null) throw notFound('no commits on that ref');
        const { page, perPage } = paging(ctx.query);
        const all = walkCommits(tipOid, store.lookup(repo));
        const { pageItems } = pageSlice(all, page, perPage);
        sendJson(res, 200, pageItems.map((oid) => commitJson(store, repo, oid, host)), ctx);
        return true;
      }
      if (tail.length === 2 && method === 'GET') {
        sendJson(res, 200, commitJson(store, repo, tail[1]!, host), ctx);
        return true;
      }
    }

    // Contents: a file or a directory, read, written and deleted.
    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      const ref = ctx.query.get('ref') ?? repo.defaultBranch;
      const tip = branchTip(repo, ref);
      if (method === 'GET') {
        if (tip === null) throw notFound(`branch ${ref} has no commits`);
        if (path === '') {
          sendJson(res, 200, directoryJson(store, repo, tip.commit.tree, '', host), ctx);
          return true;
        }
        const entry = treeLookupPath(store, repo, tip.commit.tree, path);
        if (entry === null) throw notFound(`path ${path} does not exist on ${ref}`);
        if (entry.mode === '40000') {
          sendJson(res, 200, directoryJson(store, repo, entry.oid, path, host), ctx);
          return true;
        }
        const object = repo.objects.get(entry.oid);
        if (object === undefined || object.type !== 'blob') throw notFound(`path ${path} is not a file`);
        const lastSegment = path.split('/').pop() ?? path;
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: object.data.length,
          name: lastSegment,
          path,
          content: b64encode(object.data),
          sha: entry.oid,
          url: `http://${host}/api/v3/repos/${owner}/${name}/contents/${path}`,
          html_url: `http://${host}/${owner}/${name}/blob/${ref}/${path}`,
          download_url: `http://${host}/api/v3/repos/${owner}/${name}/contents/${path}`,
          _links: { self: `http://${host}/api/v3/repos/${owner}/${name}/contents/${path}` },
        }, ctx);
        return true;
      }
      if (method === 'PUT') {
        const payload = parseJsonBody(body);
        if (!isRecord(payload)) throw badRequest('put contents needs a JSON object body');
        const message = asString(payload.message, '');
        const content = asString(payload.content, '');
        if (message === '' || content === '') throw unprocessable('message and content are required');
        const branch = asString(payload.branch, repo.defaultBranch);
        const existing = branchTip(repo, branch);
        const existingEntry = existing === null ? null : treeLookupPath(store, repo, existing.commit.tree, path);
        if (typeof payload.sha === 'string' && payload.sha !== '') {
          if (existingEntry === null || existingEntry.oid !== payload.sha) {
            throw conflict('the sha does not match the current file version');
          }
        }
        if (typeof payload.sha === 'string' && payload.sha !== '' && existingEntry === null) {
          throw conflict('the sha does not match the current file version');
        }
        const isUpdate = existingEntry !== null;
        const blobOid = store.putObject(repo, 'blob', b64decode(content));
        const commitOid = writeContentsCommit(store, repo, branch, path, { oid: blobOid, mode: '100644' }, message);
        sendJson(res, isUpdate ? 200 : 201, {
          content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: b64decode(content).length, encoding: 'base64' },
          commit: { sha: commitOid, message },
        }, ctx);
        return true;
      }
      if (method === 'DELETE') {
        const payload = parseJsonBody(body);
        if (!isRecord(payload)) throw badRequest('delete contents needs a JSON object body');
        const message = asString(payload.message, '');
        const branch = asString(payload.branch, repo.defaultBranch);
        const tipNow = branchTip(repo, branch);
        if (tipNow === null) throw notFound(`branch ${branch} has no commits`);
        const existingEntry = treeLookupPath(store, repo, tipNow.commit.tree, path);
        if (existingEntry === null) throw notFound(`path ${path} does not exist`);
        if (typeof payload.sha === 'string' && payload.sha !== '' && payload.sha !== existingEntry.oid) {
          throw conflict('the sha does not match the current file version');
        }
        const commitOid = writeContentsCommit(store, repo, branch, path, null, message === '' ? `Delete ${path}` : message);
        sendJson(res, 200, { commit: { sha: commitOid, message } }, ctx);
        return true;
      }
    }

    // Labels.
    if (tail[0] === 'labels') {
      if (tail.length === 1 && method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(label, host)), ctx);
        return true;
      }
      if (tail.length === 1 && method === 'POST') {
        const payload = parseJsonBody(body);
        if (!isRecord(payload)) throw badRequest('create label needs a JSON object body');
        const labelName = asString(payload.name, '').trim();
        if (labelName === '') throw unprocessable('label name is required');
        const existingLabel = repo.labels.get(labelName);
        if (existingLabel !== undefined) {
          sendJson(res, 200, labelJson(existingLabel, host), ctx);
          return true;
        }
        const color = asString(payload.color, '000000').replace(/^#/, '');
        const label: LabelRec = {
          id: repo.nextLabelId,
          name: labelName,
          color: /^[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : '000000',
          description: asString(payload.description, ''),
        };
        repo.nextLabelId += 1;
        repo.labels.set(labelName, label);
        sendJson(res, 201, labelJson(label, host), ctx);
        return true;
      }
    }

    // Git Data refs: create a ref, list refs, and read one ref.
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && method === 'POST') {
        const payload = parseJsonBody(body);
        if (!isRecord(payload)) throw badRequest('create ref needs a JSON object body');
        const ref = asString(payload.ref, '');
        const sha = asString(payload.sha, '');
        if (ref === '' || !isOid(sha)) throw unprocessable('ref and a valid sha are required');
        if (repo.refs.has(ref)) throw unprocessable(`ref ${ref} already exists`);
        if (repo.objects.get(sha) === undefined) throw unprocessable(`object ${sha} does not exist`);
        repo.refs.set(ref, sha);
        sendJson(res, 201, {
          ref,
          node_id: toB64Url(`ref:${owner}/${name}:${ref}`),
          url: `http://${host}/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, '')}`,
          object: { sha, type: repo.objects.get(sha)!.type, url: `http://${host}/api/v3/repos/${owner}/${name}/git/${repo.objects.get(sha)!.type}s/${sha}` },
        }, ctx);
        return true;
      }
      if (tail.length === 2 && method === 'GET') {
        const refs = [...repo.refs.entries()]
          .sort((a, b) => compareBytes(a[0], b[0]))
          .map(([ref, oid]) => ({
            ref,
            node_id: toB64Url(`ref:${owner}/${name}:${ref}`),
            url: `http://${host}/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, '')}`,
            object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' },
          }));
        sendJson(res, 200, refs, ctx);
        return true;
      }
      if (tail.length >= 3 && method === 'GET') {
        const ref = `refs/${tail.slice(2).join('/')}`;
        const oid = repo.refs.get(ref);
        if (oid === undefined) throw notFound(`ref ${ref} does not exist`);
        sendJson(res, 200, {
          ref,
          node_id: toB64Url(`ref:${owner}/${name}:${ref}`),
          url: `http://${host}/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, '')}`,
          object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' },
        }, ctx);
        return true;
      }
    }

    // Issues.
    if (tail[0] === 'issues') {
      if (tail.length === 1 && method === 'POST') {
        const payload = parseJsonBody(body);
        if (!isRecord(payload)) throw badRequest('create issue needs a JSON object body');
        const title = asString(payload.title, '').trim();
        if (title === '') throw unprocessable('issue title is required');
        const requestedLabels = Array.isArray(payload.labels) ? payload.labels : [];
        const labels: LabelRec[] = [];
        for (const raw of requestedLabels) {
          const labelName = typeof raw === 'string' ? raw : isRecord(raw) ? asString(raw.name, '') : '';
          if (labelName === '') continue;
          const label = repo.labels.get(labelName);
          if (label === undefined) throw unprocessable(`label ${labelName} does not exist`);
          labels.push(label);
        }
        const issue = store.createIssue(repo, title, asString(payload.body, ''), labels);
        sendJson(res, 201, issueJson(issue, repo, host), ctx);
        return true;
      }
      if (tail.length === 1 && method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const direction = ctx.query.get('direction') ?? 'desc';
        const sort = ctx.query.get('sort') ?? 'created';
        let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        issues = [...issues].sort((a, b) => {
          if (sort === 'created') return direction === 'asc' ? a.number - b.number : b.number - a.number;
          return direction === 'asc' ? a.number - b.number : b.number - a.number;
        });
        const { page, perPage } = paging(ctx.query);
        const { pageItems } = pageSlice(issues, page, perPage);
        sendJson(res, 200, pageItems.map((issue) => issueJson(issue, repo, host)), ctx);
        return true;
      }
      if (tail.length === 2) {
        const number = Number(tail[1]);
        const issue = repo.issues.find((candidate) => candidate.number === number);
        if (issue === undefined) throw notFound(`issue ${tail[1]} does not exist`);
        if (method === 'GET') {
          sendJson(res, 200, issueJson(issue, repo, host), ctx);
          return true;
        }
        if (method === 'PATCH') {
          const payload = parseJsonBody(body);
          if (!isRecord(payload)) throw badRequest('update issue needs a JSON object body');
          if (typeof payload.title === 'string') issue.title = payload.title;
          if (typeof payload.body === 'string') issue.body = payload.body;
          if (typeof payload.state === 'string' && (payload.state === 'open' || payload.state === 'closed')) {
            issue.state = payload.state;
            issue.closedAt = payload.state === 'closed' ? store.tick().iso : null;
          }
          issue.updatedAt = store.tick().iso;
          sendJson(res, 200, issueJson(issue, repo, host), ctx);
          return true;
        }
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        const number = Number(tail[1]);
        const issue = repo.issues.find((candidate) => candidate.number === number);
        if (issue === undefined) throw notFound(`issue ${tail[1]} does not exist`);
        if (method === 'POST') {
          const payload = parseJsonBody(body);
          if (!isRecord(payload)) throw badRequest('create comment needs a JSON object body');
          const commentBody = asString(payload.body, '').trim();
          if (commentBody === '') throw unprocessable('comment body is required');
          const comment = store.createComment(repo, issue, commentBody);
          sendJson(res, 201, commentJson(comment, repo, issue, host), ctx);
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((comment) => commentJson(comment, repo, issue, host)), ctx);
          return true;
        }
      }
    }

    // Pull requests.
    if (tail[0] === 'pulls') {
      if (tail.length === 1 && method === 'POST') {
        const payload = parseJsonBody(body);
        if (!isRecord(payload)) throw badRequest('create pull request needs a JSON object body');
        const title = asString(payload.title, '').trim();
        const head = asString(payload.head, '');
        const base = asString(payload.base, repo.defaultBranch);
        if (title === '' || head === '') throw unprocessable('title and head are required');
        const headTip = branchTip(repo, head);
        const baseTip = branchTip(repo, base);
        if (headTip === null) throw unprocessable(`head branch ${head} does not exist`);
        if (baseTip === null) throw unprocessable(`base branch ${base} does not exist`);
        const duplicate = repo.pulls.find(
          (candidate) => candidate.state === 'open' && candidate.headRef === branchOf(head) && candidate.baseRef === branchOf(base),
        );
        if (duplicate !== undefined) {
          throw unprocessable(`a pull request from ${head} to ${base} is already open`);
        }
        const pull = store.createPull(
          repo, title, asString(payload.body, ''),
          branchOf(head), headTip.oid, branchOf(base), baseTip.oid,
        );
        sendJson(res, 201, pullJson(store, repo, pull, host), ctx);
        return true;
      }
      if (tail.length === 1 && method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
        pulls = [...pulls].sort((a, b) => b.number - a.number);
        const { page, perPage } = paging(ctx.query);
        const { pageItems } = pageSlice(pulls, page, perPage);
        sendJson(res, 200, pageItems.map((pull) => pullJson(store, repo, pull, host)), ctx);
        return true;
      }
      if (tail.length === 2) {
        const number = Number(tail[1]);
        const pull = repo.pulls.find((candidate) => candidate.number === number);
        if (pull === undefined) throw notFound(`pull request ${tail[1]} does not exist`);
        if (method === 'GET') {
          sendJson(res, 200, pullJson(store, repo, pull, host), ctx);
          return true;
        }
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        const number = Number(tail[1]);
        const pull = repo.pulls.find((candidate) => candidate.number === number);
        if (pull === undefined) throw notFound(`pull request ${tail[1]} does not exist`);
        sendJson(res, 200, pullFiles(store, repo, pull).map((file) => ({
          sha: file.sha,
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          patch: null,
        })), ctx);
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        const number = Number(tail[1]);
        const pull = repo.pulls.find((candidate) => candidate.number === number);
        if (pull === undefined) throw notFound(`pull request ${tail[1]} does not exist`);
        if (pull.state !== 'open') {
          sendJson(res, 405, { message: 'Pull request is not open' }, ctx);
          return true;
        }
        const lookup = store.lookup(repo);
        const base = mergeBase(pull.headSha, pull.baseSha, lookup);
        if (base === null) throw unprocessable('pull request has no merge base');
        const baseTree = parseCommit(lookup(base)!.data).tree;
        const headTree = parseCommit(lookup(pull.headSha)!.data).tree;
        const baseTip = parseCommit(lookup(pull.baseSha)!.data).tree;
        const baseFlat = flattenTree(baseTree, lookup);
        const headFlat = flattenTree(headTree, lookup);
        const tipFlat = flattenTree(baseTip, lookup);
        const headChanges = diffFlat(baseFlat, headFlat);
        const tipChanges = diffFlat(baseFlat, tipFlat);
        const conflicted = headChanges.some((change) => {
          const other = tipChanges.find((candidate) => candidate.path === change.path);
          if (other === undefined) return false;
          return other.newOid !== change.newOid || other.status !== change.status;
        });
        if (conflicted) {
          sendJson(res, 405, { message: 'Merge conflict' }, ctx);
          return true;
        }
        const mergedFlat = new Map(tipFlat);
        for (const change of headChanges) {
          if (change.newOid === null) mergedFlat.delete(change.path);
          else mergedFlat.set(change.path, { oid: change.newOid, mode: '100644' });
        }
        const storeIntoRepo = (type: ObjType, data: Buffer): string => store.putObject(repo, type, data);
        const mergedTree = storeTreeFromFlat(mergedFlat, storeIntoRepo);
        const stamp = store.tick();
        const mergeCommit = buildCommit({
          tree: mergedTree,
          parents: [pull.baseSha],
          message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
          timestamp: stamp.epoch,
        });
        const mergeOid = store.putObject(repo, 'commit', mergeCommit);
        repo.refs.set(headRefOf(pull.baseRef), mergeOid);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = stamp.iso;
        pull.mergeCommitSha = mergeOid;
        pull.closedAt = stamp.iso;
        pull.updatedAt = stamp.iso;
        repo.pushedAt = stamp.iso;
        sendJson(res, 200, { sha: mergeOid, merged: true, message: 'Pull Request successfully merged' }, ctx);
        return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// GraphQL v4
// ---------------------------------------------------------------------------

/** A parsed GraphQL query document (the subset the suite's clients send). */
interface GqlDocument {
  operation: 'query' | 'mutation';
  fields: GqlField[];
  variables: Record<string, unknown>;
}

interface GqlField {
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  selections: GqlField[];
  fragmentType: string | null;
}

class GqlTokenizer {
  private index = 0;
  constructor(private readonly text: string) {}

  private skipSpace(): void {
    while (this.index < this.text.length) {
      const ch = this.text[this.index]!;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') this.index += 1;
      else break;
    }
  }

  peek(): string {
    this.skipSpace();
    return this.index < this.text.length ? this.text[this.index]! : '';
  }

  readName(): string {
    this.skipSpace();
    let name = '';
    while (this.index < this.text.length) {
      const ch = this.text[this.index]!;
      if (/[A-Za-z0-9_]/.test(ch)) {
        name += ch;
        this.index += 1;
      } else break;
    }
    return name;
  }

  readString(): string {
    this.skipSpace();
    if (this.text[this.index] !== '"') throw new Error('expected a quoted string');
    this.index += 1;
    let out = '';
    while (this.index < this.text.length) {
      const ch = this.text[this.index]!;
      if (ch === '"') {
        this.index += 1;
        return out;
      }
      if (ch === '\\') {
        this.index += 1;
        const escaped = this.text[this.index] ?? '';
        out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
        this.index += 1;
        continue;
      }
      out += ch;
      this.index += 1;
    }
    throw new Error('unterminated string');
  }

  readInt(): number {
    this.skipSpace();
    let num = '';
    while (this.index < this.text.length) {
      const ch = this.text[this.index]!;
      if (/[0-9-]/.test(ch)) {
        num += ch;
        this.index += 1;
      } else break;
    }
    const value = Number(num);
    if (!Number.isFinite(value)) throw new Error(`bad integer ${JSON.stringify(num)}`);
    return value;
  }

  readFloat(): number {
    this.skipSpace();
    let num = '';
    while (this.index < this.text.length) {
      const ch = this.text[this.index]!;
      if (/[0-9eE.+-]/.test(ch)) {
        num += ch;
        this.index += 1;
      } else break;
    }
    const value = Number(num);
    if (!Number.isFinite(value)) throw new Error(`bad number ${JSON.stringify(num)}`);
    return value;
  }

  expect(ch: string): void {
    this.skipSpace();
    if (this.text[this.index] !== ch) {
      throw new Error(`expected ${JSON.stringify(ch)} at offset ${this.index}`);
    }
    this.index += 1;
  }

  consumeIf(ch: string): boolean {
    this.skipSpace();
    if (this.text[this.index] === ch) {
      this.index += 1;
      return true;
    }
    return false;
  }

  atEnd(): boolean {
    this.skipSpace();
    return this.index >= this.text.length;
  }
}

/** A small recursive-descent parser for the GraphQL documents the suite sends. */
export class GqlParser {
  private tokenizer: GqlTokenizer;
  constructor(private readonly query: string) {
    this.tokenizer = new GqlTokenizer(query);
  }

  parse(variables: Record<string, unknown>): GqlDocument {
    let operation: 'query' | 'mutation' = 'query';
    const first = this.tokenizer.peek();
    if (first === '{') {
      return { operation, fields: this.parseSelectionSet(variables), variables };
    }
    const keyword = this.tokenizer.readName();
    if (keyword === 'query' || keyword === 'mutation') operation = keyword;
    else if (keyword !== '') throw new Error(`unsupported operation ${JSON.stringify(keyword)}`);
    this.tokenizer.readName();
    this.tokenizer.consumeIf('(');
    while (!this.tokenizer.atEnd() && this.tokenizer.peek() !== ')') {
      this.tokenizer.readName();
      if (this.tokenizer.peek() === ':') {
        this.tokenizer.expect(':');
        this.skipType();
      }
      if (this.tokenizer.peek() === '=') {
        this.tokenizer.expect('=');
        this.parseValue(variables);
      }
    }
    if (this.tokenizer.peek() === ')') this.tokenizer.expect(')');
    return { operation, fields: this.parseSelectionSet(variables), variables };
  }

  private skipType(): void {
    while (!this.tokenizer.atEnd()) {
      const ch = this.tokenizer.peek();
      if (ch === '[' || ch === '!' || ch === ']') {
        this.tokenizer.expect(ch);
      } else if (/[A-Za-z_]/.test(ch)) {
        this.tokenizer.readName();
      } else break;
    }
  }

  private parseSelectionSet(variables: Record<string, unknown>): GqlField[] {
    this.tokenizer.expect('{');
    const fields: GqlField[] = [];
    while (!this.tokenizer.atEnd() && this.tokenizer.peek() !== '}') {
      if (this.tokenizer.peek() === '.') {
        this.tokenizer.expect('.');
        this.tokenizer.expect('.');
        this.tokenizer.expect('.');
        const name = this.tokenizer.readName();
        let fragmentType: string | null = null;
        if (name === 'on') fragmentType = this.tokenizer.readName();
        fields.push({
          name: '...',
          alias: null,
          args: {},
          selections: this.parseSelectionSet(variables),
          fragmentType,
        });
        continue;
      }
      const name = this.tokenizer.readName();
      if (name === '') throw new Error('expected a field name');
      let alias: string | null = null;
      if (this.tokenizer.consumeIf(':')) {
        alias = name;
        const actual = this.tokenizer.readName();
        fields.push(this.readField(actual, alias, variables));
        continue;
      }
      fields.push(this.readField(name, null, variables));
    }
    this.tokenizer.expect('}');
    return fields;
  }

  private readField(name: string, alias: string | null, variables: Record<string, unknown>): GqlField {
    const args: Record<string, unknown> = {};
    if (this.tokenizer.peek() === '(') {
      this.tokenizer.expect('(');
      while (!this.tokenizer.atEnd() && this.tokenizer.peek() !== ')') {
        const argName = this.tokenizer.readName();
        this.tokenizer.expect(':');
        args[argName] = this.parseValue(variables);
      }
      this.tokenizer.expect(')');
    }
    let selections: GqlField[] = [];
    if (this.tokenizer.peek() === '{') selections = this.parseSelectionSet(variables);
    return { name, alias, args, selections, fragmentType: null };
  }

  parseValue(variables: Record<string, unknown>): unknown {
    const ch = this.tokenizer.peek();
    if (ch === '"') return this.tokenizer.readString();
    if (ch === '$') {
      this.tokenizer.expect('$');
      const name = this.tokenizer.readName();
      return variables[name];
    }
    if (ch === '[') {
      this.tokenizer.expect('[');
      const items: unknown[] = [];
      while (!this.tokenizer.atEnd() && this.tokenizer.peek() !== ']') {
        items.push(this.parseValue(variables));
      }
      this.tokenizer.expect(']');
      return items;
    }
    if (ch === '{') {
      this.tokenizer.expect('{');
      const record: Record<string, unknown> = {};
      while (!this.tokenizer.atEnd() && this.tokenizer.peek() !== '}') {
        const key = this.tokenizer.readName();
        this.tokenizer.expect(':');
        record[key] = this.parseValue(variables);
      }
      this.tokenizer.expect('}');
      return record;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const rest = this.query.slice(this.tokenizer['index'] ?? 0);
      const floatMatch = /^-?\d+\.\d+([eE][+-]?\d+)?/.exec(rest);
      if (floatMatch !== null) return this.tokenizer.readFloat();
      return this.tokenizer.readInt();
    }
    const name = this.tokenizer.readName();
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    return name;
  }
}

export class GqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GqlError';
  }
}

/** The fields each GraphQL type exposes (the suite introspects a few of them). */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Viewer: ['login', 'id', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest',
    'pullRequests', 'description', 'url', 'isPrivate', 'createdAt', 'updatedAt',
  ],
  RepositoryOwner: ['login', 'id'],
  Ref: ['name', 'target'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'comments'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRefOid', 'baseRefOid', 'author', 'createdAt', 'updatedAt',
    'files', 'mergedAt', 'closedAt',
  ],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'totalCount', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['comment', 'clientMutationId'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Actor: ['login', 'id'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name', 'type'],
  __EnumValue: ['name'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeStateStatus: ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'MERGEABLE', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'READ', 'TRIAGE', 'WRITE'],
};

/** The mergeability word GraphQL reports for a pull request. */
function pullMergeableWord(pull: PullRec): string {
  return pull.state === 'open' ? 'MERGEABLE' : 'UNKNOWN';
}

/** A pull request's GraphQL state word. */
function pullStateWord(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** An issue's GraphQL state word. */
function issueStateWord(issue: IssueRec): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function cursorForNumber(number: number): string {
  return toB64Url(`issue-cursor:${number}`);
}

function numberFromCursor(cursor: string): number | null {
  const decoded = fromB64Url(cursor);
  if (decoded === null) return null;
  const match = /^issue-cursor:(\d+)$/.exec(decoded);
  if (match === null) return null;
  return Number(match[1]);
}

/** Executor for one operation document against the store. */
export class GqlExecutor {
  constructor(
    private readonly store: Store,
    private readonly host: string,
  ) {}

  run(document: GqlDocument): Record<string, unknown> {
    const errors: Array<Record<string, unknown>> = [];
    const data: Record<string, unknown> = {};
    for (const field of document.fields) {
      try {
        data[field.alias ?? field.name] = this.resolveTopLevel(document, field);
      } catch (err) {
        if (err instanceof GqlError) {
          errors.push({ message: err.message, path: [field.alias ?? field.name] });
          data[field.alias ?? field.name] = null;
        } else {
          throw err;
        }
      }
    }
    const envelope: Record<string, unknown> = { data };
    if (errors.length > 0) envelope.errors = errors;
    return envelope;
  }

  private resolveTopLevel(document: GqlDocument, field: GqlField): unknown {
    if (field.name === '__type') {
      const typeName = asString(field.args.name, '');
      return this.resolveTypeIntrospection(typeName, field.selections);
    }
    if (document.operation === 'mutation') return this.resolveMutation(field);
    if (field.name === 'viewer') {
      return this.pickFields('Viewer', { login: VIEWER_LOGIN, id: VIEWER_ID, databaseId: VIEWER_ID }, field.selections);
    }
    if (field.name === 'repository') {
      const owner = asString(field.args.owner, '');
      const name = asString(field.args.name, '');
      const repo = owner === VIEWER_LOGIN ? this.store.getRepo(owner, name) : undefined;
      if (repo === undefined) return null;
      return this.repositoryValue(repo, field.selections);
    }
    if (field.name === 'node') {
      const gid = asString(field.args.id, '');
      const resolved = this.store.resolveGlobalId(gid);
      if (resolved === null) return null;
      if (resolved.kind === 'repo') return this.repositoryValue(resolved.repo, field.selections);
      if (resolved.kind === 'issue') return this.issueValue(resolved.repo, resolved.issue!, field.selections);
      if (resolved.kind === 'pull') return this.pullValue(resolved.repo, resolved.pull!, field.selections);
      return null;
    }
    throw new GqlError(`Cannot query field "${field.name}" on type "Query".`);
  }

  private resolveTypeIntrospection(typeName: string, selections: GqlField[]): unknown {
    const fields = TYPE_FIELDS[typeName];
    const enumValues = ENUM_VALUES[typeName];
    const value: Record<string, unknown> = { name: typeName };
    for (const selection of selections) {
      if (selection.name === 'name') value.name = typeName;
      else if (selection.name === 'kind') value.kind = enumValues !== undefined ? 'ENUM' : 'OBJECT';
      else if (selection.name === 'fields') {
        value.fields = (fields ?? []).map((fieldName) => {
          const fieldValue: Record<string, unknown> = { name: fieldName };
          for (const sub of selection.selections) {
            if (sub.name === 'name') fieldValue.name = fieldName;
            else if (sub.name === 'type') fieldValue.type = { name: 'String', kind: 'SCALAR' };
          }
          return fieldValue;
        });
      } else if (selection.name === 'enumValues') {
        value.enumValues = (enumValues ?? []).map((name) => ({ name }));
      }
    }
    return value;
  }

  private repositoryValue(repo: RepoRec, selections: GqlField[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of selections) {
      if (field.fragmentType !== null && field.fragmentType !== 'Repository') continue;
      if (field.name === '...') {
        if (field.fragmentType === 'Repository' || field.fragmentType === null) {
          Object.assign(out, this.repositoryValue(repo, field.selections));
        }
        continue;
      }
      const key = field.alias ?? field.name;
      switch (field.name) {
        case 'id': out[key] = repo.gid; break;
        case 'databaseId': out[key] = repo.id; break;
        case 'name': out[key] = repo.name; break;
        case 'nameWithOwner': out[key] = `${repo.owner}/${repo.name}`; break;
        case 'owner': out[key] = this.pickFields('RepositoryOwner', { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0 }, field.selections); break;
        case 'defaultBranchRef': {
          const tip = branchTip(repo, repo.defaultBranch);
          out[key] = tip === null ? null : this.pickFields('Ref', { name: repo.defaultBranch, target: tip.oid }, field.selections);
          break;
        }
        case 'viewerPermission': out[key] = 'ADMIN'; break;
        case 'hasIssuesEnabled': out[key] = true; break;
        case 'description': out[key] = repo.description; break;
        case 'isPrivate': out[key] = repo.private; break;
        case 'url': out[key] = `http://${this.host}/${repo.owner}/${repo.name}`; break;
        case 'createdAt': out[key] = repo.createdAt; break;
        case 'updatedAt': out[key] = repo.updatedAt; break;
        case 'issue': {
          const number = asInteger(field.args.number, 0);
          const issue = this.store.findIssue(repo, number);
          out[key] = issue === undefined ? null : this.issueValue(repo, issue, field.selections);
          break;
        }
        case 'issues': out[key] = this.issuesConnection(repo, field); break;
        case 'pullRequest': {
          const number = asInteger(field.args.number, 0);
          const pull = this.store.findPull(repo, number);
          out[key] = pull === undefined ? null : this.pullValue(repo, pull, field.selections);
          break;
        }
        case 'pullRequests': out[key] = this.pullsConnection(repo, field); break;
        default:
          throw new GqlError(`Cannot query field "${field.name}" on type "Repository".`);
      }
    }
    return out;
  }

  private issuesConnection(repo: RepoRec, field: GqlField): Record<string, unknown> {
    const first = asInteger(field.args.first, 10);
    const after = asString(field.args.after, '');
    const states = Array.isArray(field.args.states) ? field.args.states : ['OPEN'];
    const orderBy = isRecord(field.args.orderBy) ? field.args.orderBy : null;
    const direction = orderBy !== null ? asString(orderBy.direction, 'DESC') : 'DESC';
    let issues = repo.issues.filter((issue) => {
      if (states.length === 0) return true;
      return states.includes(issueStateWord(issue));
    });
    issues = [...issues].sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
    let startIndex = 0;
    if (after !== '') {
      const afterNumber = numberFromCursor(after);
      if (afterNumber !== null) {
        const position = issues.findIndex((issue) => issue.number === afterNumber);
        if (position >= 0) startIndex = position + 1;
      }
    }
    const slice = issues.slice(startIndex, startIndex + first);
    const out: Record<string, unknown> = {};
    for (const selection of field.selections) {
      const key = selection.alias ?? selection.name;
      if (selection.name === 'nodes') out[key] = slice.map((issue) => this.issueValue(repo, issue, selection.selections));
      else if (selection.name === 'edges') {
        out[key] = slice.map((issue) => ({
          node: this.issueValue(repo, issue, selection.selections.filter((sub) => sub.name !== 'cursor' && sub.name !== 'node')),
          cursor: cursorForNumber(issue.number),
        }));
      } else if (selection.name === 'totalCount') out[key] = issues.length;
      else if (selection.name === 'pageInfo') {
        out[key] = this.pageInfoValue(startIndex + slice.length < issues.length, slice.length > 0 ? cursorForNumber(slice[slice.length - 1]!.number) : null, selection.selections);
      }
    }
    return out;
  }

  private pullsConnection(repo: RepoRec, field: GqlField): Record<string, unknown> {
    const first = asInteger(field.args.first, 10);
    const states = Array.isArray(field.args.states) ? field.args.states : null;
    const orderBy = isRecord(field.args.orderBy) ? field.args.orderBy : null;
    const direction = orderBy !== null ? asString(orderBy.direction, 'DESC') : 'DESC';
    let pulls = [...repo.pulls];
    if (states !== null && states.length > 0) {
      pulls = pulls.filter((pull) => states.includes(pullStateWord(pull)));
    }
    pulls.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
    const slice = pulls.slice(0, first);
    const out: Record<string, unknown> = {};
    for (const selection of field.selections) {
      const key = selection.alias ?? selection.name;
      if (selection.name === 'nodes') out[key] = slice.map((pull) => this.pullValue(repo, pull, selection.selections));
      else if (selection.name === 'edges') {
        out[key] = slice.map((pull) => ({
          node: this.pullValue(repo, pull, selection.selections.filter((sub) => sub.name !== 'cursor' && sub.name !== 'node')),
          cursor: cursorForNumber(pull.number),
        }));
      } else if (selection.name === 'totalCount') out[key] = pulls.length;
      else if (selection.name === 'pageInfo') {
        out[key] = this.pageInfoValue(slice.length < pulls.length, slice.length > 0 ? cursorForNumber(slice[slice.length - 1]!.number) : null, selection.selections);
      }
    }
    return out;
  }

  private pageInfoValue(hasNext: boolean, endCursor: string | null, selections: GqlField[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      const key = selection.alias ?? selection.name;
      if (selection.name === 'hasNextPage') out[key] = hasNext;
      else if (selection.name === 'hasPreviousPage') out[key] = false;
      else if (selection.name === 'endCursor') out[key] = endCursor;
      else if (selection.name === 'startCursor') out[key] = endCursor;
    }
    return out;
  }

  private issueValue(repo: RepoRec, issue: IssueRec, selections: GqlField[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of selections) {
      if (field.fragmentType !== null && field.fragmentType !== 'Issue') continue;
      if (field.name === '...') {
        if (field.fragmentType === 'Issue' || field.fragmentType === null) Object.assign(out, this.issueValue(repo, issue, field.selections));
        continue;
      }
      const key = field.alias ?? field.name;
      switch (field.name) {
        case 'id': out[key] = issue.gid; break;
        case 'number': out[key] = issue.number; break;
        case 'title': out[key] = issue.title; break;
        case 'body': out[key] = issue.body; break;
        case 'state': out[key] = issueStateWord(issue); break;
        case 'author': out[key] = this.pickFields('Actor', { login: issue.author, id: issue.author === VIEWER_LOGIN ? VIEWER_ID : 0 }, field.selections); break;
        case 'createdAt': out[key] = issue.createdAt; break;
        case 'updatedAt': out[key] = issue.updatedAt; break;
        case 'comments': {
          const commentNodes = issue.comments.map((comment) => ({
            id: comment.gid,
            body: comment.body,
            author: this.pickFields('Actor', { login: comment.author, id: comment.author === VIEWER_LOGIN ? VIEWER_ID : 0 }, []),
            createdAt: comment.createdAt,
          }));
          out[key] = { nodes: commentNodes, totalCount: commentNodes.length };
          break;
        }
        default:
          throw new GqlError(`Cannot query field "${field.name}" on type "Issue".`);
      }
    }
    return out;
  }

  private pullValue(repo: RepoRec, pull: PullRec, selections: GqlField[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of selections) {
      if (field.fragmentType !== null && field.fragmentType !== 'PullRequest') continue;
      if (field.name === '...') {
        if (field.fragmentType === 'PullRequest' || field.fragmentType === null) Object.assign(out, this.pullValue(repo, pull, field.selections));
        continue;
      }
      const key = field.alias ?? field.name;
      switch (field.name) {
        case 'id': out[key] = pull.gid; break;
        case 'number': out[key] = pull.number; break;
        case 'title': out[key] = pull.title; break;
        case 'body': out[key] = pull.body; break;
        case 'state': out[key] = pullStateWord(pull); break;
        case 'merged': out[key] = pull.merged; break;
        case 'mergeable': out[key] = pullMergeableWord(pull); break;
        case 'headRefName': out[key] = pull.headRef; break;
        case 'baseRefName': out[key] = pull.baseRef; break;
        case 'headRefOid': out[key] = pull.headSha; break;
        case 'baseRefOid': out[key] = pull.baseSha; break;
        case 'author': out[key] = this.pickFields('Actor', { login: pull.author, id: pull.author === VIEWER_LOGIN ? VIEWER_ID : 0 }, field.selections); break;
        case 'createdAt': out[key] = pull.createdAt; break;
        case 'updatedAt': out[key] = pull.updatedAt; break;
        case 'mergedAt': out[key] = pull.mergedAt; break;
        case 'closedAt': out[key] = pull.closedAt; break;
        case 'files': {
          const first = asInteger(field.args.first, 100);
          const files = pullFiles(this.store, repo, pull).slice(0, first);
          const nodes = files.map((file) => ({
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
          }));
          out[key] = { nodes, totalCount: nodes.length };
          break;
        }
        default:
          throw new GqlError(`Cannot query field "${field.name}" on type "PullRequest".`);
      }
    }
    return out;
  }

  private pickFields(typeName: string, values: Record<string, unknown>, selections: GqlField[]): Record<string, unknown> {
    if (selections.length === 0) return values;
    const out: Record<string, unknown> = {};
    const known = TYPE_FIELDS[typeName] ?? [];
    for (const field of selections) {
      if (field.name === '...') {
        Object.assign(out, this.pickFields(typeName, values, field.selections));
        continue;
      }
      if (!known.includes(field.name)) {
        throw new GqlError(`Cannot query field "${field.name}" on type "${typeName}".`);
      }
      const key = field.alias ?? field.name;
      const value = values[field.name];
      out[key] = value === undefined ? null : value;
    }
    return out;
  }

  private resolveMutation(field: GqlField): unknown {
    const input = isRecord(field.args.input) ? field.args.input : {};
    const owner = asString(input.repositoryId, '');
    const repoName = asString(input.repository, '');
    let repo: RepoRec | undefined;
    let repoOwner = '';
    let repoShort = '';
    if (owner !== '') {
      const decoded = fromB64Url(owner);
      if (decoded !== null) {
        const parts = decoded.split(':');
        if (parts[0] === 'repo' && parts.length === 3) {
          repoOwner = parts[1]!;
          repoShort = parts[2]!;
        }
      }
    }
    if (repoShort !== '') repo = this.store.getRepo(repoOwner, repoShort);
    else if (repoName !== '') {
      const parts = repoName.split('/');
      if (parts.length === 2) {
        repoOwner = parts[0]!;
        repoShort = parts[1]!;
        repo = this.store.getRepo(repoOwner, repoShort);
      }
    }
    if (repo === undefined) throw new GqlError('repository not found');
    const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
    const wrap = (key: string, value: unknown): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const selection of field.selections) {
        const alias = selection.alias ?? selection.name;
        if (selection.name === key) {
          out[alias] = value;
        } else if (selection.name === 'clientMutationId') {
          out[alias] = clientMutationId;
        }
      }
      return out;
    };
    if (field.name === 'createIssue') {
      const title = asString(input.title, '').trim();
      if (title === '') throw new GqlError('createIssue requires a title');
      const issue = this.store.createIssue(repo, title, asString(input.body, ''), []);
      return wrap('issue', this.issueValue(repo, issue, field.selections.find((s) => s.name === 'issue')?.selections ?? []));
    }
    if (field.name === 'closeIssue') {
      const number = asInteger(input.issueNumber, 0);
      const issue = this.store.findIssue(repo, number);
      if (issue === undefined) throw new GqlError(`issue ${number} not found`);
      issue.state = 'closed';
      issue.closedAt = this.store.tick().iso;
      issue.updatedAt = issue.closedAt;
      return wrap('issue', this.issueValue(repo, issue, field.selections.find((s) => s.name === 'issue')?.selections ?? []));
    }
    if (field.name === 'createPullRequest') {
      const title = asString(input.title, '').trim();
      const head = asString(input.headRefName, '');
      const base = asString(input.baseRefName, repo.defaultBranch);
      if (title === '' || head === '') throw new GqlError('createPullRequest requires a title and a head ref');
      const headTip = branchTip(repo, head);
      const baseTip = branchTip(repo, base);
      if (headTip === null || baseTip === null) throw new GqlError('createPullRequest needs existing head and base branches');
      const pull = this.store.createPull(repo, title, asString(input.body, ''), branchOf(head), headTip.oid, branchOf(base), baseTip.oid);
      return wrap('pullRequest', this.pullValue(repo, pull, field.selections.find((s) => s.name === 'pullRequest')?.selections ?? []));
    }
    if (field.name === 'mergePullRequest') {
      const number = asInteger(input.pullRequestNumber, 0);
      const pull = this.store.findPull(repo, number);
      if (pull === undefined) throw new GqlError(`pull request ${number} not found`);
      if (pull.state !== 'open') throw new GqlError('pull request is not open');
      const lookup = this.store.lookup(repo);
      const base = mergeBase(pull.headSha, pull.baseSha, lookup);
      if (base === null) throw new GqlError('pull request has no merge base');
      const baseTree = parseCommit(lookup(base)!.data).tree;
      const headTree = parseCommit(lookup(pull.headSha)!.data).tree;
      const baseTip = parseCommit(lookup(pull.baseSha)!.data).tree;
      const baseFlat = flattenTree(baseTree, lookup);
      const headFlat = flattenTree(headTree, lookup);
      const tipFlat = flattenTree(baseTip, lookup);
      const headChanges = diffFlat(baseFlat, headFlat);
      const tipChanges = diffFlat(baseFlat, tipFlat);
      const conflicted = headChanges.some((change) => {
        const other = tipChanges.find((candidate) => candidate.path === change.path);
        return other !== undefined && (other.newOid !== change.newOid || other.status !== change.status);
      });
      if (conflicted) throw new GqlError('merge conflict');
      const mergedFlat = new Map(tipFlat);
      for (const change of headChanges) {
        if (change.newOid === null) mergedFlat.delete(change.path);
        else mergedFlat.set(change.path, { oid: change.newOid, mode: '100644' });
      }
      const storeIntoRepo = (type: ObjType, data: Buffer): string => this.store.putObject(repo, type, data);
      const mergedTree = storeTreeFromFlat(mergedFlat, storeIntoRepo);
      const stamp = this.store.tick();
      const mergeOid = this.store.putObject(
        repo,
        'commit',
        buildCommit({
          tree: mergedTree,
          parents: [pull.baseSha],
          message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
          timestamp: stamp.epoch,
        }),
      );
      repo.refs.set(headRefOf(pull.baseRef), mergeOid);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = stamp.iso;
      pull.mergeCommitSha = mergeOid;
      pull.closedAt = stamp.iso;
      pull.updatedAt = stamp.iso;
      return wrap('pullRequest', this.pullValue(repo, pull, field.selections.find((s) => s.name === 'pullRequest')?.selections ?? []));
    }
    if (field.name === 'addComment') {
      const number = asInteger(input.issueNumber, 0);
      const issue = this.store.findIssue(repo, number);
      if (issue === undefined) throw new GqlError(`issue ${number} not found`);
      const commentBody = asString(input.body, '').trim();
      if (commentBody === '') throw new GqlError('addComment requires a body');
      const comment = this.store.createComment(repo, issue, commentBody);
      const commentValue = {
        id: comment.gid,
        body: comment.body,
        author: { login: comment.author, id: VIEWER_ID },
        createdAt: comment.createdAt,
      };
      return wrap('comment', commentValue);
    }
    throw new GqlError(`Cannot query field "${field.name}" on type "Mutation".`);
  }
}

/** Handle POST /api/graphql (one operation, or a JSON array of them, in order). */
function handleGraphql(req: IncomingMessage, res: ServerResponse, ctx: Ctx, body: Buffer): void {
  const payload = parseJsonBody(body);
  const executor = new GqlExecutor(ctx.store, ctx.host);
  const runOne = (envelope: unknown): Record<string, unknown> => {
    if (!isRecord(envelope)) throw badRequest('GraphQL body must be an operation object');
    const query = asString(envelope.query, '');
    if (query === '') throw badRequest('GraphQL query is required');
    const variables = isRecord(envelope.variables) ? envelope.variables : {};
    let document: GqlDocument;
    try {
      document = new GqlParser(query).parse(variables);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    return executor.run(document);
  };
  if (Array.isArray(payload)) {
    sendJson(res, 200, payload.map((envelope) => runOne(envelope)), ctx);
    return;
  }
  sendJson(res, 200, runOne(payload), ctx);
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol, Streamable HTTP)
// ---------------------------------------------------------------------------

/** The six tools this forge exposes, in the canonical names the suite looks for. */
function mcpToolList(): Array<Record<string, unknown>> {
  const tools: Array<{ name: string; description: string; required: string[]; props: Record<string, unknown> }> = [
    {
      name: 'create_repo',
      description: 'Create a new repository for the authenticated user.',
      required: ['name'],
      props: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
    },
    {
      name: 'get_repo',
      description: 'Get a repository by owner and name.',
      required: ['owner', 'repo'],
      props: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
    },
    {
      name: 'create_issue',
      description: 'Create an issue in a repository.',
      required: ['owner', 'repo', 'title'],
      props: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
    },
    {
      name: 'list_issues',
      description: 'List issues in a repository.',
      required: ['owner', 'repo'],
      props: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
    },
    {
      name: 'create_pull_request',
      description: 'Create a pull request between two branches of a repository.',
      required: ['owner', 'repo', 'title', 'head', 'base'],
      props: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
    },
    {
      name: 'merge_pull_request',
      description: 'Merge a pull request by number.',
      required: ['owner', 'repo', 'pull_number'],
      props: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
    },
  ];
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.props, required: tool.required, additionalProperties: false },
  }));
}

/** Split a `owner/repo` full name, or null when it is not one. */
function splitFullName(fullName: string): { owner: string; repo: string } | null {
  const parts = fullName.split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null;
  return { owner: parts[0]!, repo: parts[1]! };
}

/** Pull the owner/repo pair out of a tool's arguments, by name or by full_name. */
function mcpRepoOf(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const owner = asString(args.owner, '');
  const repo = asString(args.repo, '');
  if (owner !== '' && repo !== '') return { owner, repo };
  const fullName = asString(args.full_name, '');
  if (fullName !== '') return splitFullName(fullName);
  return null;
}

/** The result envelope a tool call returns. */
function mcpToolResult(text: string, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text }],
    structuredContent: JSON.parse(text) as Record<string, unknown>,
    isError,
  };
}

/** A JSON-RPC error envelope (HTTP 200, the error rides in the body). */
function mcpRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** A JSON-RPC success envelope. */
function mcpRpcOk(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/** Run one tool call against the store. Domain errors come back as isError results. */
function mcpCallTool(store: Store, host: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = name.toLowerCase().replace(/^github__/, '');
  const tool = mcpToolList().find((candidate) => candidate.name === normalized);
  if (tool === undefined) throw new GqlError(`unknown tool ${JSON.stringify(name)}`);
  const required = (tool.inputSchema as Record<string, unknown>).required as string[];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      throw new GqlError(`missing required argument ${JSON.stringify(key)} for tool ${JSON.stringify(name)}`);
    }
  }
  const asRepo = (): RepoRec => {
    const pair = mcpRepoOf(args);
    if (pair === null) throw new GqlError('tool call needs an owner and repo (or full_name)');
    const repo = needRepo(store, pair.owner, pair.repo);
    return repo;
  };
  try {
    if (normalized === 'create_repo') {
      const repoName = asString(args.name, '').trim();
      if (repoName === '') throw new GqlError('create_repo needs a name');
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) {
        throw new GqlError(`repository ${repoName} already exists`);
      }
      const repo = store.createRepo(VIEWER_LOGIN, repoName, asBoolean(args.private, false), asString(args.description, ''));
      return mcpToolResult(JSON.stringify(repoJson(repo, host)));
    }
    if (normalized === 'get_repo') {
      const repo = asRepo();
      return mcpToolResult(JSON.stringify(repoJson(repo, host)));
    }
    if (normalized === 'create_issue') {
      const repo = asRepo();
      const title = asString(args.title, '').trim();
      if (title === '') throw new GqlError('create_issue needs a title');
      const issue = store.createIssue(repo, title, asString(args.body, ''), []);
      return mcpToolResult(JSON.stringify(issueJson(issue, repo, host)));
    }
    if (normalized === 'list_issues') {
      const repo = asRepo();
      const state = asString(args.state, 'open');
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return mcpToolResult(JSON.stringify(issues.map((issue) => issueJson(issue, repo, host))));
    }
    if (normalized === 'create_pull_request') {
      const repo = asRepo();
      const title = asString(args.title, '').trim();
      const head = asString(args.head, '');
      const base = asString(args.base, repo.defaultBranch);
      if (title === '' || head === '') throw new GqlError('create_pull_request needs a title and a head branch');
      const headTip = branchTip(repo, head);
      const baseTip = branchTip(repo, base);
      if (headTip === null) throw new GqlError(`head branch ${head} does not exist`);
      if (baseTip === null) throw new GqlError(`base branch ${base} does not exist`);
      const duplicate = repo.pulls.find(
        (candidate) => candidate.state === 'open' && candidate.headRef === branchOf(head) && candidate.baseRef === branchOf(base),
      );
      if (duplicate !== undefined) throw new GqlError(`a pull request from ${head} to ${base} is already open`);
      const pull = store.createPull(repo, title, asString(args.body, ''), branchOf(head), headTip.oid, branchOf(base), baseTip.oid);
      return mcpToolResult(JSON.stringify(pullJson(store, repo, pull, host)));
    }
    if (normalized === 'merge_pull_request') {
      const repo = asRepo();
      const number = asInteger(args.pull_number, 0);
      const pull = store.findPull(repo, number);
      if (pull === undefined) throw new GqlError(`pull request ${number} does not exist`);
      if (pull.state !== 'open') throw new GqlError('pull request is not open');
      const lookup = store.lookup(repo);
      const base = mergeBase(pull.headSha, pull.baseSha, lookup);
      if (base === null) throw new GqlError('pull request has no merge base');
      const baseTree = parseCommit(lookup(base)!.data).tree;
      const headTree = parseCommit(lookup(pull.headSha)!.data).tree;
      const baseTip = parseCommit(lookup(pull.baseSha)!.data).tree;
      const baseFlat = flattenTree(baseTree, lookup);
      const headFlat = flattenTree(headTree, lookup);
      const tipFlat = flattenTree(baseTip, lookup);
      const headChanges = diffFlat(baseFlat, headFlat);
      const tipChanges = diffFlat(baseFlat, tipFlat);
      const conflicted = headChanges.some((change) => {
        const other = tipChanges.find((candidate) => candidate.path === change.path);
        return other !== undefined && (other.newOid !== change.newOid || other.status !== change.status);
      });
      if (conflicted) throw new GqlError('merge conflict');
      const mergedFlat = new Map(tipFlat);
      for (const change of headChanges) {
        if (change.newOid === null) mergedFlat.delete(change.path);
        else mergedFlat.set(change.path, { oid: change.newOid, mode: '100644' });
      }
      const storeIntoRepo = (type: ObjType, data: Buffer): string => store.putObject(repo, type, data);
      const mergedTree = storeTreeFromFlat(mergedFlat, storeIntoRepo);
      const stamp = store.tick();
      const mergeOid = store.putObject(
        repo,
        'commit',
        buildCommit({
          tree: mergedTree,
          parents: [pull.baseSha],
          message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
          timestamp: stamp.epoch,
        }),
      );
      repo.refs.set(headRefOf(pull.baseRef), mergeOid);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = stamp.iso;
      pull.mergeCommitSha = mergeOid;
      pull.closedAt = stamp.iso;
      pull.updatedAt = stamp.iso;
      return mcpToolResult(JSON.stringify({ sha: mergeOid, merged: true, message: 'Pull Request successfully merged' }));
    }
  } catch (err) {
    if (err instanceof ForgeError) return mcpToolResult(JSON.stringify({ message: err.message }), true);
    if (err instanceof GqlError) return mcpToolResult(JSON.stringify({ message: err.message }), true);
    throw err;
  }
  throw new GqlError(`unknown tool ${JSON.stringify(name)}`);
}

/** Handle one JSON-RPC request on /mcp (a notification has no id and gets 202). */
function handleMcpRequest(store: Store, host: string, envelope: unknown, ctx: Ctx): { status: number; value: unknown } | null {
  if (!isRecord(envelope)) return { status: 200, value: mcpRpcError(null, -32600, 'invalid request') };
  const id = envelope.id === undefined ? null : envelope.id;
  const isNotification = envelope.id === undefined;
  const method = asString(envelope.method, '');
  const params = isRecord(envelope.params) ? envelope.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  const protocolVersion = asString(meta.protocolVersion, '') || asString(params.protocolVersion, '') || MCP_REVISION;
  if (method === 'server/discover') {
    return {
      status: 200,
      value: mcpRpcOk(id, {
        supportedVersions: [MCP_REVISION],
        capabilities: { tools: {} },
        serverInfo: { name: MCP_NAME, version: MCP_VERSION },
        _meta: { serverInfo: { name: MCP_NAME, version: MCP_VERSION } },
      }),
    };
  }
  if (method === 'initialize') {
    return {
      status: 200,
      value: mcpRpcOk(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_NAME, version: MCP_VERSION },
      }),
    };
  }
  if (method === 'notifications/initialized') {
    return isNotification ? null : { status: 200, value: mcpRpcOk(id, {}) };
  }
  if (method === 'ping') {
    return { status: 200, value: mcpRpcOk(id, {}) };
  }
  if (method === 'tools/list') {
    return { status: 200, value: mcpRpcOk(id, { tools: mcpToolList() }) };
  }
  if (method === 'tools/call') {
    const toolName = asString(params.name, '');
    const toolArgs = isRecord(params.arguments) ? params.arguments : {};
    try {
      const result = mcpCallTool(store, host, toolName, toolArgs);
      return { status: 200, value: mcpRpcOk(id, result) };
    } catch (err) {
      if (err instanceof GqlError) {
        const message = err.message;
        if (message.startsWith('unknown tool')) {
          return { status: 200, value: mcpRpcError(id, -32601, message) };
        }
        if (message.startsWith('missing required argument')) {
          return { status: 200, value: mcpRpcError(id, -32602, message) };
        }
        return { status: 200, value: mcpRpcOk(id, mcpToolResult(JSON.stringify({ message }), true)) };
      }
      if (err instanceof ForgeError) {
        return { status: 200, value: mcpRpcOk(id, mcpToolResult(JSON.stringify({ message: err.message }), true)) };
      }
      throw err;
    }
  }
  return { status: 200, value: mcpRpcError(id, -32601, `method ${JSON.stringify(method)} not found`) };
}

/** Handle POST /mcp (and the 405 for DELETE). Auth is decided per request first. */
function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: Ctx, body: Buffer): boolean {
  if (req.method === 'DELETE') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'method not allowed' } }, ctx);
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'method not allowed' } }, ctx);
    return true;
  }
  const header = req.headers.authorization ?? '';
  const match = /^token\s+(\S+)$/.exec(header);
  const presented = match !== null ? match[1]! : '';
  if (presented === '' || presented !== SHOP_TOKEN) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Bad credentials' } }, ctx);
    return true;
  }
  let payload: unknown;
  try {
    payload = parseJsonBody(body);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, ctx);
    return true;
  }
  if (Array.isArray(payload)) {
    const answers: Array<Record<string, unknown> | null> = [];
    for (const envelope of payload) {
      const answer = handleMcpRequest(ctx.store, ctx.host, envelope, ctx);
      if (answer !== null) answers.push(answer.value as Record<string, unknown>);
    }
    sendJson(res, 200, answers, ctx);
    return true;
  }
  const answer = handleMcpRequest(ctx.store, ctx.host, payload, ctx);
  if (answer === null) {
    res.writeHead(202, { 'x-github-request-id': ctx.requestId, 'x-oauth-scopes': '' });
    res.end();
    return true;
  }
  sendJson(res, answer.status, answer.value, ctx);
  return true;
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------

export function createForgeServer(store = new Store()): Server {
  const server = createServer(async (req, res) => {
    const host = req.headers.host ?? 'localhost';
    const requestId = store.nextRequestId();
    const url = new URL(req.url ?? '/', `http://${host}`);
    const ctx: Ctx = { store, host, requestId, query: url.searchParams };
    try {
      // GET /healthz — the suite's liveness probe (no auth).
      if (req.method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true }, ctx);
        return;
      }
      // Git smart HTTP: /{owner}/{repo}.git/info/refs and the two pack endpoints.
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(url.pathname);
      if (gitMatch !== null) {
        const owner = gitMatch[1]!;
        const name = gitMatch[2]!;
        const tail = gitMatch[3]!;
        if (!requireAuth(req, ctx, res)) return;
        const body = await readBody(req);
        if (tail === 'info/refs' && req.method === 'GET') {
          handleInfoRefs(req, res, ctx, owner, name);
          return;
        }
        if (tail === 'git-upload-pack' && req.method === 'POST') {
          const repo = needRepo(store, owner, name);
          sendBuffer(res, 200, 'application/x-git-upload-pack-result', handleUploadPack(repo, body), ctx);
          return;
        }
        if (tail === 'git-receive-pack' && req.method === 'POST') {
          const repo = needRepo(store, owner, name);
          sendBuffer(res, 200, 'application/x-git-receive-pack-result', handleReceivePack(store, repo, body), ctx);
          return;
        }
        throw notFound(`git path ${JSON.stringify(tail)} does not exist`);
      }
      // MCP.
      if (url.pathname === '/mcp') {
        const body = await readBody(req);
        handleMcp(req, res, ctx, body);
        return;
      }
      // GraphQL.
      if (url.pathname === '/api/graphql' && req.method === 'POST') {
        if (!requireAuth(req, ctx, res)) return;
        const body = await readBody(req);
        handleGraphql(req, res, ctx, body);
        return;
      }
      // REST v3.
      if (url.pathname.startsWith('/api/v3')) {
        if (!requireAuth(req, ctx, res)) return;
        const body = await readBody(req);
        const handled = handleRest(req, res, ctx, body);
        if (handled) return;
        throw notFound(`route ${req.method ?? 'GET'} ${url.pathname} does not exist`);
      }
      throw notFound(`route ${req.method ?? 'GET'} ${url.pathname} does not exist`);
    } catch (err) {
      if (err instanceof ForgeError) {
        if (!res.headersSent) sendError(res, err.status, err.message, ctx);
        else res.end();
        return;
      }
      if (!res.headersSent) {
        sendError(res, 500, err instanceof Error ? err.message : String(err), ctx);
      } else {
        res.end();
      }
    }
  });
  return server;
}
