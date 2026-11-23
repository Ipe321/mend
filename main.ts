// main.ts is mend, the CLI SPEC.md specifies (MIT). The kit's starting point did sections 1 to 4, 9 and 10 of
// SPEC.md: the command line, the output and exit codes, safe paths, format detection, JSON edits and the
// all-or-nothing write. Sections 5 to 8 are implemented in this file: matching lines at three tiers, reading
// unified diffs (section 6), SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and tracking move
// edits so a successful one prints as an `R` line. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Sections 5 to 8: matching lines at three tiers, and the unified, SEARCH/REPLACE and V4A readers. ----

interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

/** A file's lines, its own line break, and whether it ends with one (section 3). */
function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    lines.pop();
    final = true;
  }
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const stripTrailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => stripTrailWs(s.replace(/^[ \t]+/, ''));

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailWs(a) === stripTrailWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

/** Every start position at or after `from` where O matches the file's lines at `tier` (section 5); occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Match {
  tier: number;
  positions: number[];
}

/** The first tier at which O occurs at or after `from`, with every occurrence there; null when it occurs at no tier. */
function findMatch(lines: string[], o: string[], strict: boolean, from = 0): Match | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions = occurrences(lines, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** Tier 2's re-indent (section 5): a line of N that is not blank and starts with P has that P replaced by F. */
function reindent(line: string, p: string, f: string): string {
  if (line.trim() === '') return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

type EntryKind = 'context' | 'old' | 'new' | 'bs';
interface Entry {
  text: string;
  kind: EntryKind;
  /** Whether the patch line this entry came from was blank: empty for a unified body, empty or only whitespace for a V4A section. */
  rawBlank: boolean;
}

const oldEntries = (body: Entry[]): Entry[] => body.filter((e) => e.kind === 'context' || e.kind === 'old');
const newEntries = (body: Entry[]): Entry[] => body.filter((e) => e.kind === 'context' || e.kind === 'new');

/** The lines N writes over a match of O at `pos`: a context line is the file's own matched line; a new line is the patch's, re-indented at tier 2. */
function renderNew(fileLines: string[], pos: number, o: Entry[], n: Entry[], tier: number): string[] {
  const out: string[] = [];
  const f = leadWs(fileLines[pos] ?? '');
  const p = leadWs(o.length > 0 ? o[0]!.text : '');
  let oi = 0;
  for (const e of n) {
    if (e.kind === 'context') {
      while (o[oi]!.kind !== 'context') oi += 1;
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else {
      out.push(tier === 2 ? reindent(e.text, p, f) : e.text);
    }
  }
  return out;
}

/** Whether a `\` line follows the body's last context or `+` line (section 6's end-of-file rule). */
function bsAfterLastWritten(body: Entry[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const k = body[i]!.kind;
    if (k === 'context' || k === 'new') return body[i + 1]?.kind === 'bs';
  }
  return false;
}

interface UHunk {
  a: number;
  body: Entry[];
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null;
  headNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to the first tab, spaces removed, a leading a/ or b/ removed. */
const pathArg = (line: string): string => {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
};

/** Read a unified diff into its sections and hunks (section 6); structure faults are Exit2 parse errors. */
function unifiedSections(lines: string[]): USection[] {
  const sections: USection[] = [];
  const fresh = (): USection => ({
    diffOld: null,
    diffNew: null,
    headOld: null,
    headNew: null,
    hasPair: false,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    delFile: false,
    hunks: [],
  });
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) {
        cur = fresh();
        sections.push(cur);
      }
      cur.headOld = pathArg(line);
      cur.headNew = pathArg(lines[i + 1]!);
      cur.hasPair = true;
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: Entry[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ text: '', kind: 'context', rawBlank: true });
          j += 1;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ') body.push({ text: bl.slice(1), kind: 'context', rawBlank: false });
        else if (c === '-') body.push({ text: bl.slice(1), kind: 'old', rawBlank: false });
        else if (c === '+') body.push({ text: bl.slice(1), kind: 'new', rawBlank: false });
        else if (c === '\\') body.push({ text: bl.slice(1), kind: 'bs', rawBlank: false });
        else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.rawBlank) body.pop();
      cur.hunks.push({ a: Number(hm[1]), body });
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  return sections;
}

/** Apply a section's hunks to a file's text, in order, each to the result of the ones before it (section 6). */
function applyHunks(text: string, hunks: UHunk[], strict: boolean, path: string): string {
  const parts = splitFile(text);
  const lines = [...parts.lines];
  let final = parts.final;
  let d = 0;
  for (const h of hunks) {
    const o = oldEntries(h.body);
    const n = newEntries(h.body);
    const bs = bsAfterLastWritten(h.body);
    if (o.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...n.map((e) => e.text));
      if (atEnd) final = !bs;
      d += n.length;
      continue;
    }
    const m = findMatch(lines, o.map((e) => e.text), strict);
    if (m === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = m.positions[0]!;
    let best = Math.abs(pos - target);
    for (const cand of m.positions) {
      const dist = Math.abs(cand - target);
      if (dist < best) {
        best = dist;
        pos = cand;
      }
    }
    const written = renderNew(lines, pos, o, n, m.tier);
    const atEnd = pos + o.length === lines.length;
    lines.splice(pos, o.length, ...written);
    if (atEnd) final = !bs;
    d += n.length - o.length;
  }
  return joinFile(lines, parts.br, final);
}

/** One edit per unified section: a creation, a deletion, a move, or a change of the one path (section 6). */
function unifiedEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  return unifiedSections(lines).map((sec) => {
    let oldPath = sec.hasPair ? sec.headOld : (sec.renameFrom ?? sec.diffOld);
    let newPath = sec.hasPair ? sec.headNew : (sec.renameTo ?? sec.diffNew);
    const creation = sec.newFile || oldPath === '/dev/null';
    const deletion = sec.delFile || newPath === '/dev/null';
    if (creation) oldPath = null;
    if (deletion) newPath = null;
    return (tree: Tree): void => {
      if (creation) {
        const p = newPath!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let bsLast = false;
        for (const h of sec.hunks) {
          h.body.forEach((e, k) => {
            if (e.kind === 'new') {
              plus.push(e.text);
              bsLast = h.body[k + 1]?.kind === 'bs';
            }
          });
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (bsLast ? '' : '\n'));
        return;
      }
      if (deletion) {
        const p = oldPath!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const o = oldPath!;
      const n = newPath!;
      if (o === n) {
        if (!safe(o)) throw new Fail('unsafe', o);
        const before = tree.get(o);
        if (before === null) throw new Fail('missing', o);
        tree.now.set(o, applyHunks(before, sec.hunks, strict, o));
        return;
      }
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      tree.now.set(n, applyHunks(before, sec.hunks, strict, o));
      tree.now.set(o, null);
      moves.push([o, n]);
    };
  });
}

/** SEARCH/REPLACE blocks (section 7): one edit per block, in the patch's order. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let k = i - 1; k > prevEnd; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    let div = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        div = j;
        break;
      }
    }
    if (div < 0) throw new Exit2(`error: parse ${i + 1}`);
    let rep = -1;
    for (let j = div + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${i + 1}`);
    const oldLines = lines.slice(i + 1, div);
    const newLines = lines.slice(div + 1, rep);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const parts = splitFile(before);
      const m = findMatch(parts.lines, oldLines, strict);
      if (m === null) throw new Fail('no-match', p);
      if (m.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = m.positions[0]!;
      const f = leadWs(parts.lines[pos] ?? '');
      const lead = leadWs(oldLines[0]!);
      const written = newLines.map((t) => (m.tier === 2 ? reindent(t, lead, f) : t));
      const next = [...parts.lines];
      next.splice(pos, oldLines.length, ...written);
      tree.now.set(p, joinFile(next, parts.br, parts.final));
    });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: Entry[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  addLines: { text: string; rawEmpty: boolean }[];
  moveTo: string | null;
  chunks: VChunk[];
}

const vHead = (line: string): { kind: VSection['kind']; path: string } | null => {
  const heads: [string, VSection['kind']][] = [
    ['*** Add File:', 'add'],
    ['*** Delete File:', 'delete'],
    ['*** Update File:', 'update'],
  ];
  for (const [pre, kind] of heads) {
    if (line.startsWith(pre)) return { kind, path: line.slice(pre.length).trim() };
  }
  return null;
};

/** Read a V4A patch into its sections and chunks (section 8); structure faults are Exit2 parse errors. */
function v4aSections(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const head = vHead(lines[i]!);
    if (head === null) {
      if (blank(lines[i]!)) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sec: VSection = { kind: head.kind, path: head.path, line: i + 1, addLines: [], moveTo: null, chunks: [] };
    sections.push(sec);
    i += 1;
    if (head.kind === 'add') {
      while (i < last && vHead(lines[i]!) === null) {
        const l = lines[i]!;
        if (l.startsWith('+')) sec.addLines.push({ text: l.slice(1), rawEmpty: false });
        else if (l === '') sec.addLines.push({ text: '', rawEmpty: true });
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (sec.addLines.length > 0 && sec.addLines[sec.addLines.length - 1]!.rawEmpty) sec.addLines.pop();
      continue;
    }
    if (head.kind === 'delete') continue;
    let j = i;
    while (j < last && blank(lines[j]!)) j += 1;
    if (j < last && lines[j]!.startsWith('*** Move to:')) {
      sec.moveTo = lines[j]!.slice('*** Move to:'.length).trim();
      i = j + 1;
    }
    let cur: VChunk | null = null;
    let closed = false;
    while (i < last && vHead(lines[i]!) === null) {
      const l = lines[i]!;
      if (l.startsWith('@@')) {
        const anchor = l.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
        sec.chunks.push(cur);
        closed = false;
        i += 1;
        continue;
      }
      if (l.trim() === '*** End of File') {
        if (cur === null) {
          if (sec.chunks.length > 0 || closed) throw new Exit2(`error: parse ${i + 1}`);
          cur = { anchor: null, eof: false, body: [] };
          sec.chunks.push(cur);
        }
        cur.eof = true;
        cur = null;
        closed = true;
        i += 1;
        continue;
      }
      if (l.trim() === '' && cur === null) {
        i += 1;
        continue;
      }
      if (l.startsWith('***')) throw new Exit2(`error: parse ${i + 1}`);
      const c = l === '' ? ' ' : l[0]!;
      if (c !== ' ' && c !== '-' && c !== '+') throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) {
        if (sec.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
        cur = { anchor: null, eof: false, body: [] };
        sec.chunks.push(cur);
      }
      const kind: EntryKind = c === ' ' ? 'context' : c === '-' ? 'old' : 'new';
      cur.body.push({ text: l === '' ? '' : l.slice(1), kind, rawBlank: l.trim() === '' });
      i += 1;
    }
    if (cur !== null) {
      // Blank lines at the end of a section are not part of it (section 8).
      while (cur.body.length > 0 && cur.body[cur.body.length - 1]!.rawBlank) cur.body.pop();
    }
    if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
  }
  return sections;
}

/** One edit per V4A section (section 8): Add, Delete, or Update with a cursor over the file's lines. */
function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  return v4aSections(lines).map((sec) => {
    const p = sec.path;
    return (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (sec.kind === 'add') {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const texts = sec.addLines.map((l) => l.text);
        tree.now.set(p, texts.length === 0 ? '' : texts.join('\n') + '\n');
        return;
      }
      if (sec.kind === 'delete') {
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const dest = sec.moveTo;
      if (dest !== null && !safe(dest)) throw new Fail('unsafe', dest);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (dest !== null && tree.get(dest) !== null) throw new Fail('exists', dest);
      const parts = splitFile(before);
      const fileLines = [...parts.lines];
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          const anchor = ch.anchor;
          let found = -1;
          for (const tier of strict ? [0] : [0, 1, 2]) {
            for (let k = cursor; k < fileLines.length; k += 1) {
              if (lineEq(fileLines[k]!, anchor, tier)) {
                found = k;
                break;
              }
            }
            if (found >= 0) break;
          }
          if (found < 0) throw new Fail('no-match', p);
          cursor = found + 1;
        }
        const o = oldEntries(ch.body);
        const n = newEntries(ch.body);
        if (o.length === 0) {
          const at = ch.eof ? fileLines.length : Math.min(cursor, fileLines.length);
          fileLines.splice(at, 0, ...n.map((e) => e.text));
          cursor = at + n.length;
          continue;
        }
        const m = findMatch(fileLines, o.map((e) => e.text), strict, cursor);
        if (m === null) throw new Fail('no-match', p);
        const cands = ch.eof ? m.positions.filter((q) => q + o.length === fileLines.length) : m.positions;
        if (cands.length === 0) throw new Fail('no-match', p);
        const pos = cands[0]!;
        const written = renderNew(fileLines, pos, o, n, m.tier);
        fileLines.splice(pos, o.length, ...written);
        cursor = pos + written.length;
      }
      const text = joinFile(fileLines, parts.br, parts.final);
      if (dest !== null) {
        tree.now.set(dest, text);
        tree.now.set(p, null);
        moves.push([p, dest]);
      } else {
        tree.now.set(p, text);
      }
    };
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  const moves: [string, string][] = [];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const changed = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  // A successful move whose old path is gone and whose new path is new replaces that pair's D and A lines
  // with one R line, sorted by the new path (section 2).
  const paired = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [o, n] of moves) {
    if (paired.has(o) || paired.has(n) || !changed.has(o) || !changed.has(n)) continue;
    if (tree.original(o) === null || tree.now.get(o) !== null) continue;
    if (tree.original(n) !== null || tree.now.get(n) === null) continue;
    paired.add(o);
    paired.add(n);
    rows.push({ key: n, text: `R ${o} -> ${n}` });
  }
  for (const [p, text] of changed) {
    if (!paired.has(p)) rows.push({ key: p, text });
  }
  rows.sort((x, y) => byBytes(x.key, y.key));
  if (!check) {
    for (const p of [...changed.keys()].sort(byBytes)) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
