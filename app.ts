// github-core-clone-01 (rebuild): a standalone GitHub-compatible git forge.
//
// One process, in-memory store, Node built-ins only. Four surfaces on one port:
// git smart HTTP (upload-pack v2, receive-pack v0), REST v3 under /api/v3,
// GraphQL v4 at /api/graphql, MCP at /mcp.
//
// Determinism rule: no wall clock anywhere in a response. Every timestamp is
// FIXED_EPOCH plus a monotonically increasing creation sequence, so two runs
// that see the same request order produce the same bytes.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ------------------------------------------------------------------ scenario identity
// The suite's scenario is public and fixed: user, repo and branch names all
// derive from SCENARIO_SEED, and the bearer token names the scenario's viewer.
// Re-derive that login here with the same generator instead of guessing it.
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64 = 0xffffffffffffffffn;

function fnv1a64(text) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & U64;
  }
  return h;
}
function mix64(v) {
  let z = (v + 0x9e3779b97f4a7c15n) & U64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64;
  return (z ^ (z >> 31n)) & U64;
}
class Rng {
  constructor(seed) {
    const m = seed & U64;
    this.s = m === 0n ? SCENARIO_SEED : m;
  }
  nextU64() {
    let x = this.s;
    x = (x ^ (x >> 12n)) & U64;
    x = (x ^ (x << 25n)) & U64;
    x = (x ^ (x >> 27n)) & U64;
    this.s = x;
    return (x * 0x2545f4914f6cdd1dn) & U64;
  }
  nextU32() { return Number(this.nextU64() >> 32n); }
  nextInt(max) {
    if (max === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % max);
    for (;;) {
      const v = this.nextU32();
      if (v < limit) return v % max;
    }
  }
  pick(items) { return items[this.nextInt(items.length)]; }
}
const FIRST = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'];
const LAST = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'];
function scenarioViewer() {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set();
  let first = null;
  for (let i = 0; i < 12; i += 1) {
    const f = rng.pick(FIRST);
    const l = rng.pick(LAST);
    const base = `${f}${l}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) { login = `${base}-${suffix}`; suffix += 1; }
    used.add(login);
    const user = { id: 1000 + i, login, name: `${f} ${l}`, email: `${login}@example.invalid` };
    if (i === 0) first = user;
  }
  return first;
}
const VIEWER = scenarioViewer();
const VIEWER_LOGIN = VIEWER.login;
const AGENT = 'github-core-clone/1.0';
const ZERO_OID = '0'.repeat(40);
const FIXED_EPOCH = 1700000000;

// ------------------------------------------------------------------ git object model
const TYPE_CODE = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function hashObject(type, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  h.update(body);
  return h.digest('hex');
}
function isOid(v) { return typeof v === 'string' && /^[0-9a-f]{40}$/.test(v); }

function parseTree(data) {
  const entries = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}
// Git sorts tree entries by name, with directories compared as if suffixed '/'.
function compareTreeNames(a, b) {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}
function buildTree(entries) {
  const sorted = [...entries].sort(compareTreeNames);
  const parts = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
function parseCommit(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headEnd = blank < 0 ? buf.length : blank;
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents = [];
  let author = '';
  let committer = '';
  for (const line of buf.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = val;
    else if (key === 'parent') parents.push(val);
    else if (key === 'author') author = val;
    else if (key === 'committer') committer = val;
  }
  return { tree, parents, author, committer, message };
}
function parseTag(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headEnd = blank < 0 ? buf.length : blank;
  const headers = new Map();
  for (const line of buf.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp >= 0) headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8'),
  };
}
function buildCommitBytes({ tree, parents = [], message, author, committer, timestamp }) {
  const who = `${author} ${timestamp} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${committer ? `${committer} ${timestamp} +0000` : who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

// ------------------------------------------------------------------ pkt-line codec
const PKT_MAX = 65516;
function pktLine(payload) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
const pktFlush = () => Buffer.from('0000', 'ascii');
const pktDelim = () => Buffer.from('0001', 'ascii');
function decodePktLines(buf) {
  const packets = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) { packets.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end' }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

// ------------------------------------------------------------------ packfile codec
// Packs we write carry plain (undeltified) objects; packs we read may carry
// ofs-delta and ref-delta entries, resolved here on read.
function writePackObjectHeader(type, size) {
  const code = TYPE_CODE[type];
  const bytes = [];
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
function writePack(objects) {
  const list = objects instanceof Map ? [...objects.values()] : [...objects];
  const parts = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const o of list) {
    const data = Buffer.isBuffer(o.data) ? o.data : Buffer.from(o.data);
    parts.push(writePackObjectHeader(o.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
function readPackVarint(buf, start) {
  let byte = buf[start];
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first: buf[start] };
}
function readPackOfsBase(buf, start) {
  let byte = buf[start];
  let off = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[off++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: off };
}
function inflateAt(buf, offset) {
  const res = inflateSync(buf.subarray(offset), { info: true });
  return { data: res.buffer, next: offset + res.engine.bytesWritten };
}
function applyDelta(base, delta) {
  const baseBuf = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const d = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let off = 0;
  const readSize = () => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = d[off++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== baseBuf.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < d.length) {
    const op = d[off++];
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOff += d[off++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += d[off++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      baseBuf.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      d.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}
function readPack(pack) {
  const buf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const raw = [];
  const byOffset = new Map();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOff = off;
    const header = readPackVarint(buf, off);
    off = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry = { offset: entryOff, typeCode, size: header.size, data: null };
    if (typeCode === 6) {
      const base = readPackOfsBase(buf, off);
      off = base.next;
      entry.baseOffset = entryOff - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) throw new Error(`unknown pack type ${typeCode}`);
    const inflated = inflateAt(buf.subarray(0, trailerStart), off);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOff, entry);
  }
  if (off !== trailerStart) throw new Error('pack trailing bytes');
  const objects = new Map();
  const resolvedByOid = new Map();
  const resolving = new Set();
  const resolve = (entry) => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type;
    let data;
    if (entry.typeCode === 6) {
      const base = resolve(byOffset.get(entry.baseOffset));
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid);
      if (!baseEntry) throw new Error('ref-delta base not in pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = { type, data, oid };
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return entry.resolved;
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return { version, count, objects };
}

// ------------------------------------------------------------------ store
// A repo is a namespace of git objects and refs plus the REST resources.
// Everything is created in request order, which fixes every ordering a
// check can observe.
let globalSeq = 0; // creation sequence; timestamps derive from it, never the wall clock
let globalIdSeq = 0; // ids for issues / PRs / comments, stable across reads
let repoIdSeq = 5000; // repository databaseIds
let requestSeq = 0; // X-GitHub-Request-Id values
function nextSeq() { globalSeq += 1; return globalSeq; }
function stampFor(seq) { return new Date((FIXED_EPOCH + seq) * 1000).toISOString(); }
function gid(kind, repoDbId, n) {
  return Buffer.from(`${kind}:${repoDbId}:${n}`, 'utf8').toString('base64');
}
function parseGid(value) {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;
    return { kind: parts[0], repoDbId: Number(parts[1]), n: Number(parts[2]) };
  } catch { return null; }
}

function makeRepo(owner, name, fields) {
  const seq = nextSeq();
  return {
    id: repoIdSeq,
    owner,
    name,
    fullName: `${owner}/${name}`,
    description: fields.description ?? null,
    private: fields.private === true,
    defaultBranch: fields.default_branch || 'main',
    createdSeq: seq,
    createdAt: stampFor(seq),
    updatedAt: stampFor(seq),
    objects: new Map(), // oid -> {type, data}
    refs: new Map(), // 'refs/heads/x' -> oid
    labels: new Map(), // name -> {name, color}
    issues: new Map(), // number -> issue
    pulls: new Map(), // number -> pull
    comments: new Map(), // issue number -> [comment]
    nextNumber: 1, // shared issue + PR counter
    version: 0, // bumped on any mutation; part of the fetch pack cache key
  };
}
const repos = new Map(); // 'owner/name' -> repo
const reposById = new Map(); // databaseId -> repo
function repoKey(owner, name) { return `${owner}/${name}`; }
function createRepo(owner, name, fields) {
  const repo = makeRepo(owner, name, fields);
  repos.set(repoKey(owner, name), repo);
  reposById.set(repo.id, repo);
  repoIdSeq += 1;
  return repo;
}
function findRepo(owner, name) { return repos.get(repoKey(owner, name)) ?? null; }

// ------------------------------------------------------------------ git store operations
function storeObject(repo, type, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const oid = hashObject(type, buf);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data: buf });
  return oid;
}
function getObject(repo, oid) { return repo.objects.get(oid) ?? null; }
function getCommit(repo, oid) {
  const o = getObject(repo, oid);
  return o && o.type === 'commit' ? parseCommit(o.data) : null;
}
function getTreeEntries(repo, oid) {
  const o = getObject(repo, oid);
  return o && o.type === 'tree' ? parseTree(o.data) : null;
}
// Follow tag objects to the object a ref finally names.
function peel(repo, oid) {
  let cur = oid;
  for (let i = 0; i < 16; i += 1) {
    const o = getObject(repo, cur);
    if (!o) return null;
    if (o.type === 'tag') {
      const t = parseTag(o.data);
      if (!t.object || t.object === cur) return null;
      cur = t.object;
      continue;
    }
    return { oid: cur, type: o.type };
  }
  return null;
}
function headTip(repo) { return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null; }
function refTip(repo, ref) { return repo.refs.get(ref) ?? null; }
// All objects reachable from the roots. `stopAtParents` names commits the
// requester already holds as shallow boundaries: the commit itself and its
// tree/blobs are held, its parents are not.
function collectReachable(repo, roots, stopAtParents = new Set()) {
  const out = new Set();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (!oid || out.has(oid) || oid === ZERO_OID) continue;
    const o = getObject(repo, oid);
    if (!o) continue;
    out.add(oid);
    if (o.type === 'commit') {
      const c = parseCommit(o.data);
      if (c.tree) stack.push(c.tree);
      if (!stopAtParents.has(oid)) for (const p of c.parents) stack.push(p);
    } else if (o.type === 'tree') {
      for (const e of parseTree(o.data)) if (e.mode !== '160000') stack.push(e.oid);
    } else if (o.type === 'tag') {
      const t = parseTag(o.data);
      if (t.object) stack.push(t.object);
    }
  }
  return out;
}
function ancestorSet(repo, tip, cap = 200000) {
  const seen = new Set();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (!oid || seen.has(oid) || seen.size >= cap) continue;
    const c = getCommit(repo, oid);
    if (!c) continue;
    seen.add(oid);
    for (const p of c.parents) stack.push(p);
  }
  return seen;
}
function isAncestor(repo, ancestor, descendant) {
  if (ancestor === descendant) return true;
  return ancestorSet(repo, descendant).has(ancestor);
}
function mergeBase(repo, a, b) {
  if (!a || !b) return null;
  const ancestorsA = ancestorSet(repo, a);
  const stack = [b];
  const seen = new Set();
  while (stack.length > 0) {
    const oid = stack.pop();
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const c = getCommit(repo, oid);
    if (!c) continue;
    for (const p of c.parents) stack.push(p);
  }
  return null;
}
function firstParentChain(repo, tip, cap = 100000) {
  const out = [];
  let cur = tip;
  const seen = new Set();
  while (cur && !seen.has(cur) && out.length < cap) {
    seen.add(cur);
    const c = getCommit(repo, cur);
    if (!c) break;
    out.push({ oid: cur, commit: c });
    cur = c.parents[0] ?? null;
  }
  return out;
}
// Flatten a commit's tree into path -> {oid, mode}.
function flattenTree(repo, treeOid) {
  const out = new Map();
  const walk = (oid, prefix) => {
    const entries = getTreeEntries(repo, oid);
    if (!entries) return;
    for (const e of entries) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else if (e.mode !== '160000') out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  return out;
}
// Build (and store) a tree from a flat file map; returns the root tree oid.
function treeFromFiles(repo, files) {
  const build = (paths) => {
    const children = new Map();
    for (const [path, file] of paths) {
      const slash = path.indexOf('/');
      if (slash < 0) children.set(path, { mode: file.mode, oid: file.oid });
      else {
        const dir = path.slice(0, slash);
        const rest = path.slice(slash + 1);
        let list = children.get(dir);
        if (!list) { list = { mode: '40000', sub: new Map() }; children.set(dir, list); }
        list.sub.set(rest, file);
      }
    }
    const entries = [];
    for (const [name, child] of children) {
      if (child.sub) entries.push({ mode: '40000', name, oid: build([...child.sub.entries()]) });
      else entries.push({ mode: child.mode, name, oid: child.oid });
    }
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build([...files.entries()]);
}
function commitObject(repo, { tree, parents, message }) {
  const seq = nextSeq();
  const author = `${VIEWER.name} <${VIEWER.email}>`;
  const data = buildCommitBytes({ tree, parents, message, author, committer: author, timestamp: FIXED_EPOCH + seq });
  return { oid: storeObject(repo, 'commit', data), seq };
}
// Three-way conflict check between the PR's head and base, using the CURRENT
// ref tips (the base can advance after the PR opens — that is what makes a
// PR conflicted), over their merge base.
function prIsConflicted(repo, pull) {
  const headTipOid = refTip(repo, `refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const baseTipOid = refTip(repo, `refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  const base = mergeBase(repo, headTipOid, baseTipOid);
  const baseTree = base ? getCommit(repo, base)?.tree : null;
  const headCommit = getCommit(repo, headTipOid);
  const baseCommit = getCommit(repo, baseTipOid);
  if (!headCommit || !baseCommit) return false;
  const baseFiles = baseTree ? flattenTree(repo, baseTree) : new Map();
  const headFiles = flattenTree(repo, headCommit.tree);
  const currentFiles = flattenTree(repo, baseCommit.tree);
  for (const [path, headFile] of headFiles) {
    const baseFile = baseFiles.get(path);
    const currentFile = currentFiles.get(path);
    const changedInHead = !baseFile || baseFile.oid !== headFile.oid;
    const changedInBase = (!baseFile && currentFile) || (baseFile && (!currentFile || currentFile.oid !== baseFile.oid));
    if (!changedInHead || !changedInBase) continue;
    if (!currentFile || currentFile.oid !== headFile.oid) return true;
  }
  for (const [path, baseFile] of baseFiles) {
    if (headFiles.has(path) || !currentFiles.has(path)) continue;
    const currentFile = currentFiles.get(path);
    if (currentFile && currentFile.oid !== baseFile.oid) return true;
  }
  return false;
}
function lineDiffStats(oldText, newText) {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  return { additions: b.length - prefix - suffix, deletions: a.length - prefix - suffix };
}
// Diff base tree -> head tree: [{filename, status, additions, deletions, changes}]
function diffTrees(repo, baseTreeOid, headTreeOid) {
  const base = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map();
  const head = headTreeOid ? flattenTree(repo, headTreeOid) : new Map();
  const out = [];
  const names = new Set([...base.keys(), ...head.keys()]);
  for (const name of [...names].sort()) {
    const b = base.get(name);
    const h = head.get(name);
    if (b && !h) {
      const oldText = getObject(repo, b.oid)?.data.toString('utf8') ?? '';
      const stats = lineDiffStats(oldText, '');
      out.push({ filename: name, status: 'removed', additions: 0, deletions: stats.deletions, changes: stats.deletions });
    } else if (!b && h) {
      const newText = getObject(repo, h.oid)?.data.toString('utf8') ?? '';
      const stats = lineDiffStats('', newText);
      out.push({ filename: name, status: 'added', additions: stats.additions, deletions: 0, changes: stats.additions });
    } else if (b && h && b.oid !== h.oid) {
      const oldText = getObject(repo, b.oid)?.data.toString('utf8') ?? '';
      const newText = getObject(repo, h.oid)?.data.toString('utf8') ?? '';
      const stats = lineDiffStats(oldText, newText);
      out.push({ filename: name, status: 'modified', additions: stats.additions, deletions: stats.deletions, changes: stats.additions + stats.deletions });
    }
  }
  return out;
}

// ------------------------------------------------------------------ fetch pack selection
// {objects, shallow, unshallow} for a fetch of `wants` with `haves` and an
// optional `depth`. Objects the client already holds are excluded.
// `clientShallow` is the requester's current shallow boundaries: those
// commits are held, but their parents are not — that is what makes a deepen
// deliver the next generation. The shallow boundary of a depth-limited fetch
// is the deepest generation actually delivered; a boundary the client sent
// that is now fully delivered is reported as unshallow.
function selectFetch(repo, wants, haves, depth, clientShallow = []) {
  const stopAt = new Set(clientShallow.filter(isOid));
  const haveReachable = collectReachable(repo, haves.filter(isOid), stopAt);
  const objects = new Map();
  const addObject = (oid) => {
    if (!oid || haveReachable.has(oid)) return;
    const o = getObject(repo, oid);
    if (o && !objects.has(oid)) objects.set(oid, { type: o.type, data: o.data });
  };
  const shallow = [];
  const unshallow = [];
  const wantSet = new Set(wants.filter(isOid));
  const addTree = (treeOid) => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop();
      if (!oid || haveReachable.has(oid) || objects.has(oid)) continue;
      const o = getObject(repo, oid);
      if (!o) continue;
      objects.set(oid, { type: o.type, data: o.data });
      if (o.type === 'tree') {
        for (const e of parseTree(o.data)) if (e.mode !== '160000') stack.push(e.oid);
      }
    }
  };
  if (depth === undefined || depth === null) {
    for (const w of wantSet) {
      const peeled = peel(repo, w);
      const start = peeled && peeled.type === 'commit' ? peeled.oid : w;
      const stack = [start];
      const seen = new Set();
      while (stack.length > 0) {
        const oid = stack.pop();
        if (!oid || seen.has(oid) || haveReachable.has(oid)) continue;
        const c = getCommit(repo, oid);
        if (!c) continue;
        seen.add(oid);
        addObject(oid);
        addTree(c.tree);
        for (const p of c.parents) stack.push(p);
      }
      if (getObject(repo, w)?.type === 'tag') addObject(w);
    }
    for (const s of stopAt) if (getCommit(repo, s)) unshallow.push(s);
  } else {
    // Bounded-depth walk: commit generations from the wants, 0-based.
    const visited = new Map(); // oid -> generation
    const queue = [];
    for (const w of wantSet) {
      const peeled = peel(repo, w);
      const start = peeled && peeled.type === 'commit' ? peeled.oid : w;
      if (start && !visited.has(start)) { visited.set(start, 0); queue.push(start); }
      if (getObject(repo, w)?.type === 'tag') addObject(w);
    }
    const boundary = new Set();
    while (queue.length > 0) {
      const oid = queue.shift();
      const gen = visited.get(oid);
      const c = getCommit(repo, oid);
      if (!c) continue;
      addObject(oid);
      addTree(c.tree);
      if (gen + 1 < depth) {
        for (const p of c.parents) {
          if (!visited.has(p)) { visited.set(p, gen + 1); queue.push(p); }
        }
      } else if (gen + 1 === depth) {
        if (!haveReachable.has(oid)) boundary.add(oid);
      }
    }
    for (const b of boundary) if (getCommit(repo, b)) shallow.push(b);
    for (const s of stopAt) {
      if (visited.has(s) && !boundary.has(s)) unshallow.push(s);
    }
  }
  // Include the wanted tag objects themselves, and any wanted ref target the walk missed.
  for (const w of wantSet) addObject(w);
  return { objects, shallow, unshallow };
}
const packCache = new Map(); // key -> {pack, shallow, unshallow}; invalidated by repo.version
function cachedFetchPack(repo, wants, haves, depth, clientShallow = []) {
  const key = `${repo.id}:${repo.version}:${[...wants].sort().join(',')}:${[...haves].sort().join(',')}:${depth ?? ''}:${[...clientShallow].sort().join(',')}`;
  const hit = packCache.get(key);
  if (hit) return hit;
  const sel = selectFetch(repo, wants, haves, depth, clientShallow);
  const pack = writePack(sel.objects);
  const result = { pack, shallow: sel.shallow, unshallow: sel.unshallow };
  if (packCache.size > 64) packCache.clear();
  packCache.set(key, result);
  return result;
}
function sidebandPackets(pack, band = 1) {
  const out = [];
  const CHUNK = PKT_MAX - 1; // one byte for the band number
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return out;
}

// ------------------------------------------------------------------ git advertisement
const UPLOAD_V0_CAPS = 'side-band-64k multi_ack_detailed thin-pack side-band ofs-delta shallow no-progress include-tag agent=github-core-clone/1.0';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs quiet atomic ofs-delta agent=github-core-clone/1.0';
function collectRefs(repo) {
  const out = [];
  for (const [ref, oid] of repo.refs) out.push({ ref, oid });
  out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return out;
}
function refsAdvertisement(repo, service) {
  const tip = headTip(repo);
  const refs = collectRefs(repo);
  const isUpload = service === 'git-upload-pack';
  const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} ${isUpload ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS}`;
  const chunks = [];
  chunks.push(pktLine(`# service=${service}\n`));
  chunks.push(pktFlush());
  if (refs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = tip ?? refs.find((r) => r.ref === `refs/heads/${repo.defaultBranch}`)?.oid ?? refs[0].oid;
    chunks.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const r of refs) {
      chunks.push(pktLine(`${r.oid} ${r.ref}\n`));
      const peeled = peel(repo, r.oid);
      if (peeled && peeled.type === 'commit' && getObject(repo, r.oid)?.type === 'tag') {
        chunks.push(pktLine(`${peeled.oid} ${r.ref}^{}\n`));
      }
    }
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}
function refsAdvertisementV2(repo, service) {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('agent=github-core-clone/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

// ------------------------------------------------------------------ v2 command parsing
function parseV2Args(packets) {
  // {command, args: [{key, value}]}; args are the lines after the command line.
  let command = '';
  const args = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!command) {
      const m = line.match(/^command=(\S+)$/);
      if (m) command = m[1];
      continue;
    }
    const eq = line.indexOf(' ');
    const key = eq < 0 ? line : line.slice(0, eq);
    const value = eq < 0 ? '' : line.slice(eq + 1);
    args.push({ key, value });
  }
  return { command, args };
}
function handleLsRefs(repo, args) {
  const wantPeel = args.some((a) => a.key === 'peel');
  const wantSymrefs = args.some((a) => a.key === 'symrefs');
  const wantUnborn = args.some((a) => a.key === 'unborn');
  const prefixes = args.filter((a) => a.key === 'ref-prefix').map((a) => a.value);
  const tip = headTip(repo);
  const chunks = [];
  const emit = (oid, ref, extra) => {
    if (prefixes.length > 0 && !prefixes.some((p) => ref.startsWith(p))) return;
    chunks.push(pktLine(`${oid} ${ref}${extra}\n`));
  };
  const refs = collectRefs(repo);
  if (refs.length === 0) {
    if (wantUnborn) chunks.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    chunks.push(pktFlush());
    return Buffer.concat(chunks);
  }
  emit(tip ?? refs[0].oid, 'HEAD', wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '');
  for (const r of refs) {
    let extra = '';
    if (wantPeel) {
      const peeled = peel(repo, r.oid);
      if (peeled && getObject(repo, r.oid)?.type === 'tag') extra += ` peeled:${peeled.oid}`;
    }
    emit(r.oid, r.ref, extra);
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}
function handleFetchV2(repo, args) {
  const wants = [];
  const haves = [];
  const clientShallow = [];
  let depth;
  for (const a of args) {
    if (a.key === 'want') wants.push(a.value);
    else if (a.key === 'have') haves.push(a.value);
    else if (a.key === 'shallow') clientShallow.push(a.value);
    else if (a.key === 'deepen') depth = Number.parseInt(a.value, 10);
    else if (a.key === 'done') break;
  }
  if (!Number.isFinite(depth)) depth = undefined;
  const chunks = [];
  const { pack, shallow, unshallow } = cachedFetchPack(repo, wants, haves, depth, clientShallow);
  // Protocol v2: the acknowledgments section exists only when the client
  // negotiated with `have` lines. With no haves the response starts at
  // shallow-info / packfile; an acknowledgments section anyway is what real
  // git rejects.
  if (haves.length > 0) {
    chunks.push(pktLine('acknowledgments\n'));
    chunks.push(pktLine('NAK\n'));
    chunks.push(pktDelim());
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    chunks.push(pktLine('shallow-info\n'));
    for (const s of shallow) chunks.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) chunks.push(pktLine(`unshallow ${s}\n`));
    chunks.push(pktDelim());
  }
  chunks.push(pktLine('packfile\n'));
  chunks.push(...sidebandPackets(pack));
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ v0 fetch parsing
function handleFetchV0(repo, body) {
  const { packets } = decodePktLines(body);
  const wants = [];
  const haves = [];
  const clientShallow = [];
  let depth;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8');
    const m = line.match(/^(want|have|shallow|deepen)\s+(\S+)/);
    if (!m) continue;
    if (m[1] === 'want') wants.push(m[2]);
    else if (m[1] === 'have') haves.push(m[2]);
    else if (m[1] === 'shallow') clientShallow.push(m[2]);
    else if (m[1] === 'deepen') depth = Number.parseInt(m[2], 10);
  }
  if (!Number.isFinite(depth)) depth = undefined;
  const { pack, shallow, unshallow } = cachedFetchPack(repo, wants, haves, depth, clientShallow);
  const chunks = [];
  chunks.push(pktLine('NAK\n'));
  for (const s of shallow) chunks.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) chunks.push(pktLine(`unshallow ${s}\n`));
  chunks.push(...sidebandPackets(pack));
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ receive-pack v0
function handleReceivePack(repo, body) {
  const { packets, rest } = decodePktLines(body);
  const commands = [];
  let seenCaps = false;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8');
    if (!seenCaps) {
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      seenCaps = true;
    }
    const m = line.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/);
    if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  let unpackOk = true;
  let unpackError = '';
  if (rest.length > 0) {
    try {
      const parsed = readPack(rest);
      for (const [oid, obj] of parsed.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const report = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
    let reason = null;
    if (!unpackOk) reason = 'unpack failed';
    else if (cmd.oldOid !== current) reason = 'old value mismatch';
    else if (cmd.newOid !== ZERO_OID && !repo.objects.has(cmd.newOid)) reason = 'object not found';
    else if (cmd.newOid !== ZERO_OID && current !== ZERO_OID && !isAncestor(repo, current, cmd.newOid)) reason = 'non-fast-forward';
    if (reason) {
      report.push(`ng ${cmd.ref} ${reason}\n`);
      continue;
    }
    if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
    else repo.refs.set(cmd.ref, cmd.newOid);
    report.push(`ok ${cmd.ref}\n`);
  }
  if (commands.length > 0) repo.version += 1;
  // The report-status stream is itself pkt-lined *inside* band 1: one
  // sideband packet carries pktLine('unpack ok\n') + the report lines +
  // flush, then the outer stream ends with a flush. Raw text inside band 1
  // is what real git rejects.
  const inner = Buffer.concat([
    pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackError}\n`),
    ...report.map((line) => pktLine(line)),
    pktFlush(),
  ]);
  return Buffer.concat([...sidebandPackets(inner), pktFlush()]);
}

// ------------------------------------------------------------------ HTTP plumbing
const JSON_TYPE = 'application/json; charset=utf-8';
function sendJson(res, status, body, headers = {}) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${++requestSeq}`,
    ...headers,
  });
  res.end(text);
}
function sendEmpty(res, status, headers = {}) {
  res.writeHead(status, { 'x-github-request-id': `req-${++requestSeq}`, ...headers });
  res.end();
}
function sendBytes(res, status, buf, contentType, headers = {}) {
  res.writeHead(status, { 'content-type': contentType, 'content-length': buf.length, ...headers });
  res.end(buf);
}
function pathOf(req) {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; }
}
function queryOf(req) {
  try { return new URL(req.url ?? '/', 'http://entry').searchParams; } catch { return new URLSearchParams(); }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
async function readJsonBody(req) {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  return JSON.parse(buf.toString('utf8'));
}
function bearerToken(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/);
  return m ? m[1] : null;
}
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
function requireAuth(req, res) {
  if (SHOP_TOKEN === '') return true; // local dev: any Bearer token is accepted
  const tok = bearerToken(req);
  if (tok === null || tok !== SHOP_TOKEN) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return false;
  }
  return true;
}
function pageSlice(list, query) {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const items = list.slice(start, start + perPage);
  return { items, perPage, page, hasNext: start + items.length < list.length, lastPage: Math.max(1, Math.ceil(list.length / perPage)) };
}
function linkHeader(req, page, perPage, hasNext, lastPage) {
  const base = `http://${req.headers.host ?? 'entry'}${pathOf(req)}`;
  const parts = [];
  if (hasNext) parts.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  if (lastPage > 1) parts.push(`<${base}?per_page=${perPage}&page=${lastPage}>; rel="last"`);
  return parts.join(', ');
}

// ------------------------------------------------------------------ REST resource shapes
function repoJson(repo) {
  return {
    id: repo.id,
    node_id: gid('Repository', repo.id, 0),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER.id : 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://example.invalid/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, push: true, pull: true },
  };
}
function issueJson(repo, issue) {
  return {
    id: issue.id,
    node_id: gid('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state: issue.state,
    locked: false,
    user: { login: VIEWER_LOGIN, id: VIEWER.id },
    labels: issue.labels.map((l) => ({ name: l, color: repo.labels.get(l)?.color ?? '000000' })),
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
    author_association: 'OWNER',
  };
}
function pullJson(repo, pull) {
  return {
    id: pull.id,
    node_id: gid('PullRequest', repo.id, pull.number),
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    title: pull.title,
    body: pull.body ?? null,
    user: { login: VIEWER_LOGIN, id: VIEWER.id },
    labels: [],
    head: { ref: pull.head.ref, sha: refTip(repo, `refs/heads/${pull.head.ref}`) ?? pull.head.sha, label: `${VIEWER_LOGIN}:${pull.head.ref}`, repo: repoJson(repo) },
    base: { ref: pull.base.ref, sha: refTip(repo, `refs/heads/${pull.base.ref}`) ?? pull.base.sha, label: `${VIEWER_LOGIN}:${pull.base.ref}`, repo: repoJson(repo) },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: prIsConflicted(repo, pull) ? false : true,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://example.invalid/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}
function sortedIssues(repo, query) {
  let list = [...repo.issues.values()];
  const state = query.get('state') ?? 'open';
  if (state !== 'all') list = list.filter((i) => i.state === state);
  const direction = (query.get('direction') ?? 'desc').toLowerCase() === 'asc' ? 1 : -1;
  list.sort((a, b) => (a.seq - b.seq) * direction || (a.number - b.number) * direction);
  return list;
}
function sortedPulls(repo, query) {
  let list = [...repo.pulls.values()];
  const state = query.get('state') ?? 'open';
  if (state !== 'all') list = list.filter((p) => (p.merged ? 'closed' : p.state) === state);
  list.sort((a, b) => b.seq - a.seq);
  return list;
}
function createIssueInternal(repo, fields) {
  const seq = nextSeq();
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue = {
    id: ++globalIdSeq,
    number,
    title: fields.title,
    body: fields.body ?? null,
    state: 'open',
    labels: [...(fields.labels ?? [])],
    seq,
    createdAt: stampFor(seq),
    updatedAt: stampFor(seq),
    closedAt: null,
  };
  repo.issues.set(number, issue);
  repo.comments.set(number, []);
  repo.version += 1;
  return issue;
}
function createPullInternal(repo, fields) {
  const headTipOid = refTip(repo, `refs/heads/${fields.head}`);
  const baseTipOid = refTip(repo, `refs/heads/${fields.base}`);
  const seq = nextSeq();
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull = {
    id: ++globalIdSeq,
    number,
    title: fields.title,
    body: fields.body ?? null,
    state: 'open',
    head: { ref: fields.head, sha: headTipOid },
    base: { ref: fields.base, sha: baseTipOid },
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq,
    createdAt: stampFor(seq),
    updatedAt: stampFor(seq),
    closedAt: null,
  };
  repo.pulls.set(number, pull);
  repo.version += 1;
  return pull;
}
// Squash-merge: one commit on the base branch whose tree is the head's tree.
function mergePullInternal(repo, pull) {
  const headTipOid = refTip(repo, `refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const headCommit = getCommit(repo, headTipOid);
  const baseTipOid = refTip(repo, `refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  if (!headCommit || !baseTipOid) return null;
  const seq = nextSeq();
  const { oid } = commitObject(repo, {
    tree: headCommit.tree,
    parents: [baseTipOid],
    message: `Merge pull request #${pull.number} from ${VIEWER_LOGIN}/${pull.head.ref}\n\n${pull.title}`,
  });
  repo.refs.set(`refs/heads/${pull.base.ref}`, oid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stampFor(seq);
  pull.mergeCommitSha = oid;
  pull.closedAt = pull.mergedAt;
  pull.updatedAt = pull.mergedAt;
  repo.version += 1;
  return oid;
}

// ------------------------------------------------------------------ REST v3 router
async function handleRest(req, res, path, query) {
  if (!requireAuth(req, res)) return;
  const method = req.method ?? 'GET';
  const segs = path.split('/').filter((s) => s !== '');
  // GET /api/v3/meta
  if (method === 'GET' && segs.length === 3 && segs[2] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }
  // GET /api/v3/user
  if (method === 'GET' && segs.length === 3 && segs[2] === 'user') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return;
  }
  // POST / GET /api/v3/user/repos
  if (segs.length === 4 && segs[2] === 'user' && segs[3] === 'repos') {
    if (method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) { sendJson(res, 422, { message: 'Repository name is required' }); return; }
      if (findRepo(VIEWER_LOGIN, name)) {
        sendJson(res, 422, { message: `Repository ${VIEWER_LOGIN}/${name} already exists` });
        return;
      }
      const repo = createRepo(VIEWER_LOGIN, name, body);
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const list = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.createdSeq - b.createdSeq).map(repoJson);
      const { items, perPage, page, hasNext, lastPage } = pageSlice(list, query);
      const headers = {};
      const link = linkHeader(req, page, perPage, hasNext, lastPage);
      if (link) headers.link = link;
      sendJson(res, 200, items, headers);
      return;
    }
  }
  // /api/v3/repos/{owner}/{repo}/...
  if (segs.length >= 4 && segs[2] === 'repos') {
    const owner = decodeURIComponent(segs[3]);
    const name = decodeURIComponent(segs[4]);
    const repo = findRepo(owner, name);
    const rest = segs.slice(5);
    // repo itself
    if (rest.length === 0) {
      if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
      if (method === 'PATCH') {
        let body;
        try { body = await readJsonBody(req); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
        repo.updatedAt = stampFor(nextSeq());
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        reposById.delete(repo.id);
        sendEmpty(res, 204);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
    // branches
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const list = collectRefs(repo).filter((r) => r.ref.startsWith('refs/heads/')).map((r) => ({
          name: r.ref.slice('refs/heads/'.length),
          commit: { sha: r.oid, url: `/api/v3/repos/${repo.fullName}/commits/${r.oid}` },
          protected: false,
        }));
        sendJson(res, 200, list);
        return;
      }
      if (method === 'GET' && rest.length === 2) {
        const tip = refTip(repo, `refs/heads/${rest[1]}`);
        if (!tip) { sendJson(res, 404, { message: 'Branch not found' }); return; }
        sendJson(res, 200, { name: rest[1], commit: { sha: tip, url: `/api/v3/repos/${repo.fullName}/commits/${tip}` }, protected: false });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // commits
    if (rest[0] === 'commits') {
      if (method === 'GET' && rest.length === 1) {
        const branch = query.get('sha') ?? repo.defaultBranch;
        const tip = refTip(repo, `refs/heads/${branch}`);
        if (!tip) { sendJson(res, 200, []); return; }
        const list = firstParentChain(repo, tip).map(({ oid, commit }) => ({
          sha: oid,
          commit: {
            message: commit.message,
            author: { name: VIEWER.name, email: VIEWER.email, date: stampFor(0) },
            committer: { name: VIEWER.name, email: VIEWER.email, date: stampFor(0) },
          },
          author: { login: VIEWER_LOGIN, id: VIEWER.id },
          committer: { login: VIEWER_LOGIN, id: VIEWER.id },
        }));
        sendJson(res, 200, list);
        return;
      }
      if (method === 'GET' && rest.length === 2) {
        const commit = getCommit(repo, rest[1]);
        if (!commit) { sendJson(res, 404, { message: 'Not Found' }); return; }
        sendJson(res, 200, {
          sha: rest[1],
          commit: {
            message: commit.message,
            author: { name: VIEWER.name, email: VIEWER.email, date: stampFor(0) },
            committer: { name: VIEWER.name, email: VIEWER.email, date: stampFor(0) },
          },
        });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'GET' && rest.length >= 4) {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const tip = refTip(repo, ref);
        if (!tip) { sendJson(res, 404, { message: 'Not Found' }); return; }
        sendJson(res, 200, { ref, object: { sha: tip, type: getObject(repo, tip)?.type ?? 'commit' }, url: `/api/v3/repos/${repo.fullName}/git/refs/${rest.slice(2).join('/')}` });
        return;
      }
      if (method === 'POST' && rest.length === 2) {
        let body;
        try { body = await readJsonBody(req); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
          sendJson(res, 422, { message: 'Invalid ref or sha' });
          return;
        }
        if (repo.refs.has(ref)) { sendJson(res, 422, { message: 'Reference already exists' }); return; }
        repo.refs.set(ref, sha);
        repo.version += 1;
        sendJson(res, 201, { ref, object: { sha, type: getObject(repo, sha)?.type ?? 'commit' } });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // contents
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const refName = query.get('ref') ?? repo.defaultBranch;
      const tip = refTip(repo, `refs/heads/${refName}`);
      if (method === 'GET') {
        if (!tip) { sendJson(res, 404, { message: 'Not Found' }); return; }
        const treeOid = getCommit(repo, tip)?.tree;
        if (!treeOid) { sendJson(res, 404, { message: 'Not Found' }); return; }
        const files = flattenTree(repo, treeOid);
        if (filePath === '') {
          const entries = [];
          const seen = new Set();
          for (const [p, f] of files) {
            const first = p.split('/')[0];
            if (seen.has(first)) continue;
            seen.add(first);
            const isDir = p.includes('/');
            entries.push({
              type: isDir ? 'dir' : 'file',
              name: first,
              path: first,
              sha: isDir ? '' : f.oid,
              size: isDir ? 0 : (getObject(repo, f.oid)?.data.length ?? 0),
            });
          }
          sendJson(res, 200, entries);
          return;
        }
        const file = files.get(filePath);
        if (file) {
          const data = getObject(repo, file.oid)?.data ?? Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', name: filePath.split('/').pop(), path: filePath,
            content: data.toString('base64'), sha: file.oid, size: data.length,
          });
          return;
        }
        const prefix = `${filePath}/`;
        const entries = [];
        const seen = new Set();
        for (const [p, f] of files) {
          if (!p.startsWith(prefix)) continue;
          const rest2 = p.slice(prefix.length);
          const first = rest2.split('/')[0];
          if (seen.has(first)) continue;
          seen.add(first);
          const isDir = rest2.includes('/');
          entries.push({ type: isDir ? 'dir' : 'file', name: first, path: `${filePath}/${first}`, sha: isDir ? '' : f.oid, size: isDir ? 0 : (getObject(repo, f.oid)?.data.length ?? 0) });
        }
        if (entries.length > 0) { sendJson(res, 200, entries); return; }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'PUT' || method === 'DELETE') {
        let body;
        try { body = await readJsonBody(req); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const branch = typeof body.branch === 'string' && body.branch ? body.branch : repo.defaultBranch;
        const branchTip = refTip(repo, `refs/heads/${branch}`);
        const baseTip = branchTip ?? headTip(repo);
        const files = baseTip ? flattenTree(repo, getCommit(repo, baseTip)?.tree ?? '') : new Map();
        const existing = files.get(filePath);
        if (method === 'PUT') {
          if (!body.message || typeof body.content !== 'string') { sendJson(res, 422, { message: 'message and content are required' }); return; }
          if (existing && body.sha && body.sha !== existing.oid) { sendJson(res, 409, { message: 'sha does not match the current blob' }); return; }
          if (existing && !body.sha) { sendJson(res, 409, { message: 'sha is required to update a file' }); return; }
          if (!existing && body.sha) { sendJson(res, 422, { message: 'file does not exist' }); return; }
          let contentBuf;
          try { contentBuf = Buffer.from(body.content, 'base64'); } catch { sendJson(res, 422, { message: 'content is not valid base64' }); return; }
          const blobOid = storeObject(repo, 'blob', contentBuf);
          const next = new Map(files);
          next.set(filePath, { oid: blobOid, mode: '100644' });
          const treeOid = treeFromFiles(repo, next);
          const parents = branchTip ? [branchTip] : (baseTip ? [baseTip] : []);
          const { oid } = commitObject(repo, { tree: treeOid, parents, message: body.message });
          repo.refs.set(`refs/heads/${branch}`, oid);
          repo.version += 1;
          sendJson(res, existing ? 200 : 201, {
            content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: contentBuf.length, encoding: 'base64', type: 'file' },
            commit: { sha: oid, message: body.message },
          });
          return;
        }
        // DELETE
        if (!existing) { sendJson(res, 404, { message: 'Not Found' }); return; }
        if (body.sha && body.sha !== existing.oid) { sendJson(res, 409, { message: 'sha does not match the current blob' }); return; }
        const next = new Map(files);
        next.delete(filePath);
        const treeOid = treeFromFiles(repo, next);
        const parents = branchTip ? [branchTip] : [];
        const { oid } = commitObject(repo, { tree: treeOid, parents, message: body.message ?? `Delete ${filePath}` });
        repo.refs.set(`refs/heads/${branch}`, oid);
        repo.version += 1;
        sendJson(res, 200, { commit: { sha: oid, message: body.message ?? `Delete ${filePath}` } });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // labels
    if (rest[0] === 'labels') {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
        return;
      }
      if (method === 'POST') {
        let body;
        try { body = await readJsonBody(req); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const name = typeof body.name === 'string' ? body.name : '';
        if (!name) { sendJson(res, 422, { message: 'label name is required' }); return; }
        const existing = repo.labels.get(name);
        if (existing) { sendJson(res, 201, { name: existing.name, color: existing.color, description: '' }); return; }
        const label = { name, color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : '000000' };
        repo.labels.set(name, label);
        sendJson(res, 201, { name: label.name, color: label.color, description: '' });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // issues
    if (rest[0] === 'issues') {
      if (method === 'GET' && rest.length === 1) {
        const list = sortedIssues(repo, query).map((i) => issueJson(repo, i));
        const { items, perPage, page, hasNext, lastPage } = pageSlice(list, query);
        const headers = {};
        const link = linkHeader(req, page, perPage, hasNext, lastPage);
        if (link) headers.link = link;
        sendJson(res, 200, items, headers);
        return;
      }
      if (method === 'POST' && rest.length === 1) {
        let body;
        try { body = await readJsonBody(req); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        if (!body.title) { sendJson(res, 422, { message: 'title is required' }); return; }
        const labels = Array.isArray(body.labels) ? body.labels : [];
        for (const l of labels) {
          if (!repo.labels.has(l)) { sendJson(res, 422, { message: `label ${l} does not exist` }); return; }
        }
        const issue = createIssueInternal(repo, { title: body.title, body: body.body, labels });
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      if (rest.length === 2) {
        const n = Number(rest[1]);
        const issue = repo.issues.get(n);
        if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
        if (method === 'PATCH') {
          let body;
          try { body = await readJsonBody(req); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
            issue.state = body.state;
            issue.closedAt = body.state === 'closed' ? stampFor(nextSeq()) : null;
          }
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          issue.updatedAt = stampFor(nextSeq());
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const n = Number(rest[1]);
        const issue = repo.issues.get(n);
        if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
        if (method === 'GET') {
          const list = (repo.comments.get(n) ?? []).map((c) => ({
            id: c.id, node_id: gid('IssueComment', repo.id, c.id), body: c.body,
            user: { login: VIEWER_LOGIN, id: VIEWER.id }, created_at: c.createdAt, updated_at: c.updatedAt,
          }));
          sendJson(res, 200, list);
          return;
        }
        if (method === 'POST') {
          let body;
          try { body = await readJsonBody(req); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
          if (!body.body) { sendJson(res, 422, { message: 'body is required' }); return; }
          const seq = nextSeq();
          const comment = { id: ++globalIdSeq, body: body.body, seq, createdAt: stampFor(seq), updatedAt: stampFor(seq) };
          repo.comments.get(n).push(comment);
          sendJson(res, 201, {
            id: comment.id, node_id: gid('IssueComment', repo.id, comment.id), body: comment.body,
            user: { login: VIEWER_LOGIN, id: VIEWER.id }, created_at: comment.createdAt, updated_at: comment.updatedAt,
          });
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // pulls
    if (rest[0] === 'pulls') {
      if (method === 'GET' && rest.length === 1) {
        const list = sortedPulls(repo, query).map((p) => pullJson(repo, p));
        sendJson(res, 200, list);
        return;
      }
      if (method === 'POST' && rest.length === 1) {
        let body;
        try { body = await readJsonBody(req); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : '';
        if (!head || !base || !body.title) { sendJson(res, 422, { message: 'head, base and title are required' }); return; }
        if (!refTip(repo, `refs/heads/${head}`)) { sendJson(res, 422, { message: `head branch ${head} does not exist` }); return; }
        if (!refTip(repo, `refs/heads/${base}`)) { sendJson(res, 422, { message: `base branch ${base} does not exist` }); return; }
        const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.head.ref === head && p.base.ref === base);
        if (existing) { sendJson(res, 422, { message: 'A pull request already exists for this head and base' }); return; }
        const pull = createPullInternal(repo, { head, base, title: body.title, body: body.body });
        sendJson(res, 201, pullJson(repo, pull));
        return;
      }
      if (rest.length >= 2) {
        const n = Number(rest[1]);
        const pull = repo.pulls.get(n);
        if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return; }
        if (rest.length === 2 && method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return; }
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          const headCommit = getCommit(repo, pull.head.sha);
          const baseCommit = getCommit(repo, pull.base.sha);
          const files = diffTrees(repo, baseCommit?.tree ?? null, headCommit?.tree ?? null);
          sendJson(res, 200, files);
          return;
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          if (pull.merged) { sendJson(res, 405, { message: 'Pull request has already been merged' }); return; }
          if (prIsConflicted(repo, pull)) { sendJson(res, 405, { message: 'Merge conflict: the pull request cannot be merged' }); return; }
          const sha = mergePullInternal(repo, pull);
          if (!sha) { sendJson(res, 422, { message: 'Cannot merge' }); return; }
          sendJson(res, 200, { sha, merged: true, message: `Pull request #${pull.number} successfully merged` });
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

// ------------------------------------------------------------------ GraphQL (hand-rolled executor)
// The suite sends a small fixed set of documents; this parser covers the
// GraphQL surface those documents use: operations, aliases, variables,
// literal arguments (incl. lists and objects), inline fragments, and
// __type introspection. No external library is involved.
function gqlLex(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '.' && src.startsWith('...', i)) { tokens.push({ kind: 'spread' }); i += 3; continue; }
    if ('{}():!=$@[]='.includes(c)) { tokens.push({ kind: c }); i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; continue; }
        out += src[j]; j += 1;
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      const raw = src.slice(i, j);
      tokens.push({ kind: 'number', value: raw.includes('.') || /[eE]/.test(raw) ? Number.parseFloat(raw) : Number.parseInt(raw, 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${c}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}
class GqlParser {
  constructor(tokens) { this.t = tokens; this.i = 0; }
  peek() { return this.t[this.i]; }
  next() { return this.t[this.i++]; }
  expect(kind) {
    const tok = this.next();
    if (tok.kind !== kind) throw new Error(`expected ${kind}, got ${tok.kind}`);
    return tok;
  }
  parseDocument() {
    const definitions = [];
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === '{') definitions.push(this.parseOperation('query', null));
      else {
        const kw = this.expect('name').value;
        if (kw === 'query' || kw === 'mutation' || kw === 'subscription') {
          let name = null;
          if (this.peek().kind === 'name') name = this.next().value;
          definitions.push(this.parseOperation(kw, name));
        } else if (kw === 'fragment') {
          const name = this.expect('name').value;
          this.expect('name'); // 'on'
          const type = this.expect('name').value;
          definitions.push({ kind: 'fragment', name, type, selection: this.parseSelectionSet() });
        } else throw new Error(`unsupported definition ${kw}`);
      }
    }
    return definitions;
  }
  parseOperation(kind, name) {
    const varDefs = [];
    if (this.peek().kind === '(') {
      this.next();
      while (this.peek().kind !== ')') {
        this.expect('$');
        const vname = this.expect('name').value;
        this.expect(':');
        let type = '';
        while (this.peek().kind === 'name' || this.peek().kind === '!' || this.peek().kind === '[' || this.peek().kind === ']') type += this.next().kind === 'name' ? this.t[this.i - 1].value : this.t[this.i - 1].kind;
        if (this.peek().kind === '=') { this.next(); this.parseValue(); }
        varDefs.push({ name: vname, type });
      }
      this.expect(')');
    }
    return { kind: 'operation', operation: kind, name, varDefs, selection: this.parseSelectionSet() };
  }
  parseSelectionSet() {
    this.expect('{');
    const sels = [];
    while (this.peek().kind !== '}') sels.push(this.parseSelection());
    this.expect('}');
    return sels;
  }
  parseSelection() {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.t[this.i].value === 'on') {
        this.next();
        const type = this.expect('name').value;
        return { kind: 'inlineFragment', type, selection: this.parseSelectionSet() };
      }
      const name = this.expect('name').value;
      return { kind: 'fragmentSpread', name };
    }
    let alias = null;
    let name = this.expect('name').value;
    if (this.peek().kind === ':') {
      this.next();
      alias = name;
      name = this.expect('name').value;
    }
    const args = {};
    if (this.peek().kind === '(') {
      this.next();
      while (this.peek().kind !== ')') {
        const aname = this.expect('name').value;
        this.expect(':');
        args[aname] = this.parseValue();
      }
      this.expect(')');
    }
    while (this.peek().kind === '@') {
      this.next();
      this.expect('name');
      if (this.peek().kind === '(') { this.next(); while (this.peek().kind !== ')') this.parseValue(); this.expect(')'); }
    }
    let selection = null;
    if (this.peek().kind === '{') selection = this.parseSelectionSet();
    return { kind: 'field', name, alias: alias ?? name, args, selection };
  }
  parseValue() {
    const tok = this.next();
    if (tok.kind === '$') return { variable: this.expect('name').value };
    if (tok.kind === 'string' || tok.kind === 'number') return tok.value;
    if (tok.kind === 'name') {
      if (tok.value === 'true') return true;
      if (tok.value === 'false') return false;
      if (tok.value === 'null') return null;
      return { enum: tok.value };
    }
    if (tok.kind === '[') {
      const list = [];
      while (this.peek().kind !== ']') list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (tok.kind === '{') {
      const obj = {};
      while (this.peek().kind !== '}') {
        const k = this.expect('name').value;
        this.expect(':');
        obj[k] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    throw new Error(`unexpected value token ${tok.kind}`);
  }
}
function gqlResolveValue(v, variables) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if ('variable' in v) return variables[v.variable];
    if ('enum' in v) return v.enum;
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = gqlResolveValue(val, variables);
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => gqlResolveValue(x, variables));
  return v;
}
// Node model: {__type, value}; value is the store object (or a plain view).
function gqlNode(type, value) { return { __type: type, value }; }
const GQL_TYPE_FIELDS = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};
function gqlCursor(n) { return Buffer.from(String(n), 'utf8').toString('base64'); }
function gqlDecodeCursor(c) {
  try { return Number.parseInt(Buffer.from(c, 'base64').toString('utf8'), 10); } catch { return null; }
}
function gqlResolveField(node, field, args, ctx) {
  const { __type, value } = node;
  if (__type === 'Query') {
    if (field === 'viewer') return gqlNode('User', VIEWER);
    if (field === 'repository') {
      const repo = findRepo(args.owner, args.name);
      return repo ? gqlNode('Repository', repo) : null;
    }
    if (field === 'node') {
      const parsed = parseGid(args.id);
      if (!parsed) return null;
      const repo = reposById.get(parsed.repoDbId);
      if (!repo) return null;
      if (parsed.kind === 'Repository') return gqlNode('Repository', repo);
      if (parsed.kind === 'Issue') {
        const issue = repo.issues.get(parsed.n);
        return issue ? gqlNode('Issue', { repo, issue }) : null;
      }
      if (parsed.kind === 'PullRequest') {
        const pull = repo.pulls.get(parsed.n);
        return pull ? gqlNode('PullRequest', { repo, pull }) : null;
      }
      return null;
    }
    if (field === '__type') {
      const name = args.name;
      if (name === 'SearchType') return { __type: '__Type', value: { name, enumValues: [{ name: 'ISSUE' }, { name: 'PULL_REQUEST' }, { name: 'REPOSITORY' }, { name: 'USER' }] } };
      if (GQL_TYPE_FIELDS[name]) return { __type: '__Type', value: { name, fields: GQL_TYPE_FIELDS[name].map((n) => ({ name: n })) } };
      return null;
    }
    if (field === '__schema') return { __type: '__Schema', value: {} };
    ctx.error(`Field "${field}" doesn't exist on type "Query".`);
    return null;
  }
  if (__type === 'Mutation') {
    if (field === 'createIssue') {
      const input = args.input ?? {};
      const parsed = parseGid(input.repositoryId);
      const repo = parsed ? reposById.get(parsed.repoDbId) : null;
      if (!repo) { ctx.error('Repository not found'); return null; }
      const issue = createIssueInternal(repo, { title: input.title, body: input.body ?? null });
      return { __type: 'CreateIssuePayload', value: { issue, repo } };
    }
    if (field === 'closeIssue') {
      const input = args.input ?? {};
      const parsed = parseGid(input.issueId);
      const repo = parsed ? reposById.get(parsed.repoDbId) : null;
      const issue = repo?.issues.get(parsed?.n ?? -1);
      if (!issue) { ctx.error('Issue not found'); return null; }
      issue.state = 'closed';
      issue.closedAt = stampFor(nextSeq());
      issue.updatedAt = stampFor(nextSeq());
      return { __type: 'CloseIssuePayload', value: { issue, repo } };
    }
    if (field === 'createPullRequest') {
      const input = args.input ?? {};
      const parsed = parseGid(input.repositoryId);
      const repo = parsed ? reposById.get(parsed.repoDbId) : null;
      if (!repo) { ctx.error('Repository not found'); return null; }
      if (!refTip(repo, `refs/heads/${input.headRefName}`) || !refTip(repo, `refs/heads/${input.baseRefName}`)) {
        ctx.error('head or base branch does not exist');
        return null;
      }
      const pull = createPullInternal(repo, { head: input.headRefName, base: input.baseRefName, title: input.title, body: input.body ?? null });
      return { __type: 'CreatePullRequestPayload', value: { pull, repo } };
    }
    if (field === 'mergePullRequest') {
      const input = args.input ?? {};
      const parsed = parseGid(input.pullRequestId);
      const repo = parsed ? reposById.get(parsed.repoDbId) : null;
      const pull = repo?.pulls.get(parsed?.n ?? -1);
      if (!pull) { ctx.error('Pull request not found'); return null; }
      if (pull.merged) { ctx.error('Pull request already merged'); return null; }
      if (prIsConflicted(repo, pull)) { ctx.error('Merge conflict'); return { __type: 'MergePullRequestPayload', value: { pull, repo } }; }
      mergePullInternal(repo, pull);
      return { __type: 'MergePullRequestPayload', value: { pull, repo } };
    }
    if (field === 'addComment') {
      const input = args.input ?? {};
      const parsed = parseGid(input.subjectId);
      const repo = parsed ? reposById.get(parsed.repoDbId) : null;
      const issue = repo?.issues.get(parsed?.n ?? -1);
      if (!issue || parsed?.kind !== 'Issue') { ctx.error('Issue not found'); return null; }
      const seq = nextSeq();
      const comment = { id: ++globalIdSeq, body: input.body, seq, createdAt: stampFor(seq), updatedAt: stampFor(seq) };
      repo.comments.get(issue.number).push(comment);
      return { __type: 'AddCommentPayload', value: { comment, repo } };
    }
    ctx.error(`Field "${field}" doesn't exist on type "Mutation".`);
    return null;
  }
  if (__type === 'User') {
    if (field === 'login') return value.login;
    if (field === 'id') return value.id;
    if (field === 'name') return value.name;
    ctx.error(`Field "${field}" doesn't exist on type "User".`);
    return null;
  }
  if (__type === 'Repository') {
    const repo = value;
    if (field === 'id') return gid('Repository', repo.id, 0);
    if (field === 'databaseId') return repo.id;
    if (field === 'name') return repo.name;
    if (field === 'nameWithOwner') return repo.fullName;
    if (field === 'owner') return gqlNode('User', { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER.id : 1000, name: repo.owner });
    if (field === 'defaultBranchRef') return gqlNode('BranchRef', { name: repo.defaultBranch });
    if (field === 'viewerPermission') return 'ADMIN';
    if (field === 'hasIssuesEnabled') return true;
    if (field === 'issue') {
      const issue = repo.issues.get(args.number);
      return issue ? gqlNode('Issue', { repo, issue }) : null;
    }
    if (field === 'issues') {
      let list = [...repo.issues.values()];
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      const ob = args.orderBy ?? {};
      if (ob.field === 'CREATED_AT') {
        const dir = ob.direction === 'ASC' ? 1 : -1;
        list.sort((a, b) => (a.seq - b.seq) * dir || (a.number - b.number) * dir);
      } else list.sort((a, b) => a.number - b.number);
      const after = typeof args.after === 'string' ? gqlDecodeCursor(args.after) : null;
      if (after !== null) list = list.filter((i) => i.number > after);
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(0, first);
      const hasNext = list.length > first;
      return {
        __type: 'IssueConnection',
        value: {
          nodes: page.map((i) => gqlNode('Issue', { repo, issue: i })),
          pageInfo: { hasNextPage: hasNext, endCursor: page.length ? gqlCursor(page[page.length - 1].number) : null },
          totalCount: list.length,
        },
      };
    }
    if (field === 'pullRequests') {
      let list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states);
        list = list.filter((p) => wanted.has(p.merged ? 'CLOSED' : p.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      const after = typeof args.after === 'string' ? gqlDecodeCursor(args.after) : null;
      if (after !== null) list = list.filter((p) => p.number > after);
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(0, first);
      return {
        __type: 'PullRequestConnection',
        value: {
          nodes: page.map((p) => gqlNode('PullRequest', { repo, pull: p })),
          pageInfo: { hasNextPage: list.length > first, endCursor: page.length ? gqlCursor(page[page.length - 1].number) : null },
          totalCount: list.length,
        },
      };
    }
    if (field === 'pullRequest') {
      const pull = repo.pulls.get(args.number);
      return pull ? gqlNode('PullRequest', { repo, pull }) : null;
    }
    ctx.error(`Field "${field}" doesn't exist on type "Repository".`);
    return null;
  }
  if (__type === 'Issue') {
    const { repo, issue } = value;
    if (field === 'id') return gid('Issue', repo.id, issue.number);
    if (field === 'number') return issue.number;
    if (field === 'title') return issue.title;
    if (field === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field === 'body') return issue.body ?? '';
    if (field === 'createdAt') return issue.createdAt;
    ctx.error(`Field "${field}" doesn't exist on type "Issue".`);
    return null;
  }
  if (__type === 'PullRequest') {
    const { repo, pull } = value;
    if (field === 'id') return gid('PullRequest', repo.id, pull.number);
    if (field === 'number') return pull.number;
    if (field === 'title') return pull.title;
    if (field === 'state') return pull.merged || pull.state === 'closed' ? 'CLOSED' : 'OPEN';
    if (field === 'headRefName') return pull.head.ref;
    if (field === 'baseRefName') return pull.base.ref;
    if (field === 'mergeable') return prIsConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    if (field === 'merged') return pull.merged;
    if (field === 'files') {
      const headCommit = getCommit(repo, pull.head.sha);
      const baseCommit = getCommit(repo, pull.base.sha);
      const diff = diffTrees(repo, baseCommit?.tree ?? null, headCommit?.tree ?? null);
      const first = typeof args.first === 'number' ? args.first : diff.length;
      return {
        __type: 'FileConnection',
        value: { nodes: diff.slice(0, first).map((f) => gqlNode('PullRequestFile', { path: f.filename })) },
      };
    }
    ctx.error(`Field "${field}" doesn't exist on type "PullRequest".`);
    return null;
  }
  if (__type === 'BranchRef') {
    if (field === 'name') return value.name;
    ctx.error(`Field "${field}" doesn't exist on type "BranchRef".`);
    return null;
  }
  if (__type === 'PullRequestFile') {
    if (field === 'path') return value.path;
    ctx.error(`Field "${field}" doesn't exist on type "PullRequestFile".`);
    return null;
  }
  if (__type === '__Type') {
    if (field === 'name') return value.name;
    if (field === 'fields') return (value.fields ?? []).map((f) => ({ __type: '__Field', value: f }));
    if (field === 'enumValues') return (value.enumValues ?? []).map((e) => ({ __type: '__EnumValue', value: e }));
    ctx.error(`Field "${field}" doesn't exist on type "__Type".`);
    return null;
  }
  if (__type === '__Field' || __type === '__EnumValue') {
    if (field === 'name') return value.name;
    ctx.error(`Field "${field}" doesn't exist on type "${__type}".`);
    return null;
  }
  if (__type === '__Schema') {
    if (field === 'queryType') return { __type: '__Type', value: { name: 'Query', fields: [] } };
    if (field === 'mutationType') return { __type: '__Type', value: { name: 'Mutation', fields: [] } };
    if (field === 'types') return [];
    ctx.error(`Field "${field}" doesn't exist on type "__Schema".`);
    return null;
  }
  if (__type === 'IssueConnection' || __type === 'PullRequestConnection' || __type === 'FileConnection') {
    if (field === 'nodes') return value.nodes;
    if (field === 'edges') return value.nodes.map((n) => ({ __type: 'Edge', value: { node: n } }));
    if (field === 'pageInfo') return { __type: 'PageInfo', value: value.pageInfo };
    if (field === 'totalCount') return value.totalCount;
    ctx.error(`Field "${field}" doesn't exist on type "${__type}".`);
    return null;
  }
  if (__type === 'PageInfo') {
    if (field === 'hasNextPage') return value.hasNextPage;
    if (field === 'endCursor') return value.endCursor;
    if (field === 'hasPreviousPage') return false;
    if (field === 'startCursor') return null;
    ctx.error(`Field "${field}" doesn't exist on type "PageInfo".`);
    return null;
  }
  if (__type === 'Edge') {
    if (field === 'node') return value.node;
    if (field === 'cursor') return null;
    ctx.error(`Field "${field}" doesn't exist on type "Edge".`);
    return null;
  }
  if (__type === 'CreateIssuePayload' || __type === 'CloseIssuePayload') {
    if (field === 'issue') return gqlNode('Issue', { repo: value.repo, issue: value.issue });
    ctx.error(`Field "${field}" doesn't exist on type "${__type}".`);
    return null;
  }
  if (__type === 'CreatePullRequestPayload' || __type === 'MergePullRequestPayload') {
    if (field === 'pullRequest') return gqlNode('PullRequest', { repo: value.repo, pull: value.pull });
    ctx.error(`Field "${field}" doesn't exist on type "${__type}".`);
    return null;
  }
  if (__type === 'AddCommentPayload') {
    if (field === 'commentEdge') return { __type: 'CommentEdge', value: { node: value.comment, repo: value.repo } };
    ctx.error(`Field "${field}" doesn't exist on type "${__type}".`);
    return null;
  }
  if (__type === 'CommentEdge') {
    if (field === 'node') return { __type: 'IssueComment', value: { comment: value.node, repo: value.repo } };
    ctx.error(`Field "${field}" doesn't exist on type "CommentEdge".`);
    return null;
  }
  if (__type === 'IssueComment') {
    if (field === 'id') return gid('IssueComment', value.repo.id, value.comment.id);
    if (field === 'body') return value.comment.body;
    ctx.error(`Field "${field}" doesn't exist on type "IssueComment".`);
    return null;
  }
  ctx.error(`Field "${field}" doesn't exist on type "${__type}".`);
  return null;
}
function gqlExecuteSelection(node, selection, variables, ctx, fragments) {
  const out = {};
  for (const sel of selection) {
    if (sel.kind === 'inlineFragment') {
      if (!node || node.__type !== sel.type) continue;
      Object.assign(out, gqlExecuteSelection(node, sel.selection, variables, ctx, fragments));
      continue;
    }
    if (sel.kind === 'fragmentSpread') {
      const frag = fragments[sel.name];
      if (!frag) { ctx.error(`Unknown fragment "${sel.name}".`); continue; }
      if (!node || (frag.type && node.__type !== frag.type)) continue;
      Object.assign(out, gqlExecuteSelection(node, frag.selection, variables, ctx, fragments));
      continue;
    }
    const args = {};
    for (const [k, v] of Object.entries(sel.args)) args[k] = gqlResolveValue(v, variables);
    const resolved = gqlResolveField(node, sel.name, args, ctx);
    if (resolved === null || resolved === undefined) {
      out[sel.alias] = null;
      continue;
    }
    if (sel.selection === null) {
      out[sel.alias] = resolved;
      continue;
    }
    if (Array.isArray(resolved)) {
      out[sel.alias] = resolved.map((item) => {
        if (item && typeof item === 'object' && '__type' in item) return gqlExecuteSelection(item, sel.selection, variables, ctx, fragments);
        return item;
      });
      continue;
    }
    if (resolved && typeof resolved === 'object' && '__type' in resolved) {
      out[sel.alias] = gqlExecuteSelection(resolved, sel.selection, variables, ctx, fragments);
      continue;
    }
    out[sel.alias] = resolved;
  }
  return out;
}
function gqlExecuteOne(doc, variables) {
  const errors = [];
  const ctx = { error: (msg) => errors.push({ message: msg }) };
  let data = {};
  try {
    const parser = new GqlParser(gqlLex(doc.query));
    const defs = parser.parseDocument();
    const fragments = {};
    for (const d of defs) if (d.kind === 'fragment') fragments[d.name] = d;
    const ops = defs.filter((d) => d.kind === 'operation');
    const op = ops.find((o) => o.name === doc.operationName) ?? ops[0];
    if (!op) throw new Error('no operation');
    const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
    data = gqlExecuteSelection(gqlNode(rootType, {}), op.selection, variables ?? {}, ctx, fragments);
  } catch (err) {
    errors.push({ message: err instanceof Error ? err.message : String(err) });
    data = {};
  }
  const result = { data };
  if (errors.length > 0) result.errors = errors;
  return result;
}
async function handleGraphql(req, res) {
  if (!requireAuth(req, res)) return;
  let body;
  try { body = await readJsonBody(req); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
  if (Array.isArray(body)) {
    const results = body.map((item) => gqlExecuteOne(item, item?.variables ?? {}));
    sendJson(res, 200, results);
    return;
  }
  sendJson(res, 200, gqlExecuteOne(body, body?.variables ?? {}));
}

// ------------------------------------------------------------------ MCP (Streamable HTTP, JSON-RPC 2.0)
const MCP_SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];
function mcpToolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}
function mcpToolError(message) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}
// The suite may call a tool with a server prefix (github__create_issue) and
// may hand owner/repo as a single full_name "owner/repo": normalize both.
function mcpFindTool(name) {
  const wanted = String(name).toLowerCase();
  const suffix = wanted.includes('__') ? wanted.slice(wanted.lastIndexOf('__') + 2) : wanted;
  return MCP_TOOLS.find((t) => t.name === wanted || t.name === suffix) ?? null;
}
function mcpNormalizeArgs(args) {
  const out = { ...args };
  if ((out.owner === undefined || out.repo === undefined) && typeof out.full_name === 'string') {
    const slash = out.full_name.indexOf('/');
    if (slash > 0) {
      out.owner ??= out.full_name.slice(0, slash);
      out.repo ??= out.full_name.slice(slash + 1);
    }
  }
  return out;
}
function mcpCallTool(name, rawArgs) {
  const tool = mcpFindTool(name);
  if (!tool) return { error: { code: -32601, message: `Method not found: ${name}` } };
  const args = mcpNormalizeArgs(rawArgs ?? {});
  for (const reqd of tool.inputSchema.required) {
    if (args[reqd] === undefined || args[reqd] === null || args[reqd] === '') {
      return { error: { code: -32602, message: `Missing required parameter: ${reqd}` } };
    }
  }
  if (tool.name === 'create_repo') {
    const repoName = args.name;
    if (findRepo(VIEWER_LOGIN, repoName)) return { result: mcpToolError(`Repository ${VIEWER_LOGIN}/${repoName} already exists`) };
    const repo = createRepo(VIEWER_LOGIN, repoName, { description: args.description, private: args.private });
    return { result: mcpToolResult(repoJson(repo)) };
  }
  const repo = findRepo(args.owner, args.repo);
  if (!repo) return { result: mcpToolError(`Repository ${args.owner}/${args.repo} not found`) };
  if (tool.name === 'get_repo') return { result: mcpToolResult(repoJson(repo)) };
  if (tool.name === 'create_issue') {
    const labels = Array.isArray(args.labels) ? args.labels : [];
    for (const l of labels) if (!repo.labels.has(l)) return { result: mcpToolError(`label ${l} does not exist`) };
    const issue = createIssueInternal(repo, { title: args.title, body: args.body ?? null, labels });
    return { result: mcpToolResult(issueJson(repo, issue)) };
  }
  if (tool.name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'all';
    const list = [...repo.issues.values()]
      .filter((i) => state === 'all' || i.state === state)
      .sort((a, b) => b.seq - a.seq)
      .map((i) => issueJson(repo, i));
    return { result: mcpToolResult(list) };
  }
  if (tool.name === 'create_pull_request') {
    if (!refTip(repo, `refs/heads/${args.head}`)) return { result: mcpToolError(`head branch ${args.head} does not exist`) };
    if (!refTip(repo, `refs/heads/${args.base}`)) return { result: mcpToolError(`base branch ${args.base} does not exist`) };
    const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.head.ref === args.head && p.base.ref === args.base);
    if (existing) return { result: mcpToolError('A pull request already exists for this head and base') };
    const pull = createPullInternal(repo, { head: args.head, base: args.base, title: args.title, body: args.body ?? null });
    return { result: mcpToolResult(pullJson(repo, pull)) };
  }
  if (tool.name === 'merge_pull_request') {
    const pull = repo.pulls.get(Number(args.pull_number));
    if (!pull) return { result: mcpToolError(`Pull request ${args.pull_number} not found`) };
    if (pull.merged) return { result: mcpToolError('Pull request already merged') };
    if (prIsConflicted(repo, pull)) return { result: mcpToolError('Merge conflict: the pull request cannot be merged') };
    mergePullInternal(repo, pull);
    return { result: mcpToolResult(pullJson(repo, pull)) };
  }
  return { error: { code: -32601, message: `Method not found: ${name}` } };
}
async function handleMcp(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method === 'DELETE') { sendEmpty(res, 405); return; }
  if (req.method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = body.id ?? null;
  const method = body.method;
  const params = body.params ?? {};
  const reply = (result) => sendJson(res, 200, { jsonrpc: '2.0', id, result });
  const replyError = (code, message) => sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'notifications/initialized') { sendEmpty(res, 202); return; }
  if (method === 'server/discover') {
    reply({
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
    });
    return;
  }
  if (method === 'initialize') {
    reply({
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
    });
    return;
  }
  if (method === 'ping') { reply({}); return; }
  if (method === 'tools/list') { reply({ tools: MCP_TOOLS }); return; }
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments ?? {};
    if (typeof name !== 'string') { replyError(-32602, 'Missing required parameter: name'); return; }
    const out = mcpCallTool(name, args);
    if (out.error) { replyError(out.error.code, out.error.message); return; }
    reply(out.result);
    return;
  }
  replyError(-32601, `Method not found: ${method}`);
}

// ------------------------------------------------------------------ git HTTP routes
async function handleGit(req, res, path, query) {
  const method = req.method ?? 'GET';
  const m = path.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (!m) { sendJson(res, 404, { message: 'Not Found' }); return; }
  const owner = decodeURIComponent(m[1]);
  const name = decodeURIComponent(m[2]);
  const repo = findRepo(owner, name);
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
  const action = m[3];
  if (action === 'info/refs') {
    if (method !== 'GET') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { sendJson(res, 400, { message: 'service is required' }); return; }
    const v2 = req.headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
    const body = v2 ? refsAdvertisementV2(repo, service) : refsAdvertisement(repo, service);
    sendBytes(res, 200, body, `application/x-${service}-advertisement`);
    return;
  }
  if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
  const body = await readBody(req);
  try {
    if (action === 'git-upload-pack') {
      const v2 = req.headers['git-protocol'] === 'version=2';
      let out;
      if (v2) {
        const { packets } = decodePktLines(body);
        const { command, args } = parseV2Args(packets);
        if (command === 'ls-refs') out = handleLsRefs(repo, args);
        else if (command === 'fetch') out = handleFetchV2(repo, args);
        else { sendBytes(res, 400, Buffer.from('unknown command'), 'text/plain'); return; }
      } else {
        out = handleFetchV0(repo, body);
      }
      sendBytes(res, 200, out, 'application/x-git-upload-pack-result');
      return;
    }
    const out = handleReceivePack(repo, body);
    sendBytes(res, 200, out, 'application/x-git-receive-pack-result');
  } catch (err) {
    process.stderr.write(`[git-error] ${err instanceof Error ? err.stack : String(err)}\n`);
    sendBytes(res, 400, Buffer.from(err instanceof Error ? err.message : 'bad request'), 'text/plain');
  }
}

// ------------------------------------------------------------------ app
export function createApp() {
  return createServer((req, res) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    try {
      if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
      if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
        sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }
      if (path === '/api/graphql') { void handleGraphql(req, res); return; }
      if (path === '/mcp') { void handleMcp(req, res); return; }
      if (path.includes('.git/')) { void handleGit(req, res, path, queryOf(req)); return; }
      if (path.startsWith('/api/v3')) { void handleRest(req, res, path, queryOf(req)); return; }
      sendJson(res, 404, { message: 'Not Found' });
    } catch {
      if (!res.writableEnded) sendJson(res, 500, { message: 'Internal Server Error' });
    }
  });
}
