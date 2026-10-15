/* The storage-boundary scanner (test/storage-boundary.test.js has the rules and their limits).
   scan(source) reads one module's text and answers its violations, [{ line, rule, excerpt }], in
   line order. Lexical: comments, strings, template literals and regular expressions are told
   apart by a small lexer, nothing more. */

// The store's methods, called as `store.<method>(…)` (store/index.js).
const STORE_METHODS = ['loadDb', 'saveDb', 'readState', 'readStateStrict', 'readStateCached', 'readStateRev', 'casWriteState', 'deleteState', 'listStateUids', 'health'];

// Thin wrappers that hand back a store call's promise, and the objects they are called through
// ('' is a plain call). A new wrapper around the store goes here.
const WRAPPERS = [
  { name: 'saveDb', via: [''] },                                // server.js: function saveDb() { return store.saveDb(db); }
  { name: 'readState', via: ['', 'jobs', 'coachJobs'] },        // coach/jobs.js, and media.js's injected store.readState
  { name: 'listUserIds', via: ['', 'jobs', 'coachJobs'] }       // coach/jobs.js: () => store.listStateUids()
];

const RULES = ['direct-storage-access', 'unawaited-store-call'];

// The account database by name, and a training-document name being built or matched: `state-`
// followed, within the same literal, by `${`, its closing quote, a regex's end, or `.json`.
const DIRECT_ACCESS = [/\bdb\.json\b/g, /\bstate-(?:\$\{|['"`/]|[^\n'"`]*?\.json)/g];
// `storage-boundary-allow`, then a rule name, a colon or nothing; any other word after it is prose.
const MARKER = /storage-boundary-allow\b(.*)/;
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/* Splits source into `withStrings` (comments blanked) and `codeOnly` (strings, template text and
   regular expressions blanked too; the code inside `${…}` stays), both the same length as the
   source with every newline kept, plus the comments' text with their offsets. */
function lex(src) {
  const withStrings = src.split(''), codeOnly = src.split(''), comments = [];
  const blank = (out, from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  const templates = [];                 // per open `${`, the `{` depth inside it
  // What came last: a regular expression may start after an operator or a keyword, and a `/`
  // after an operand (a name, a literal, `)`, `]`, `x++`) is division.
  let prevChar = '', prevWord = '';
  const after = (ch, w = '') => { prevChar = ch; prevWord = w; };
  let i = 0;
  const template = () => {              // i is just past a backtick, or past the `}` closing a `${`
    const start = i;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') { blank(codeOnly, start, i); i++; after('`'); return; }
      if (src[i] === '$' && src[i + 1] === '{') { blank(codeOnly, start, i); i += 2; templates.push(0); after('{'); return; }
      i++;
    }
    blank(codeOnly, start, i);
  };
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && d === '/') {
      const nl = src.indexOf('\n', i), end = nl === -1 ? src.length : nl;
      comments.push({ at: i, text: src.slice(i + 2, end) });
      blank(withStrings, i, end); blank(codeOnly, i, end); i = end; continue;
    }
    if (c === '/' && d === '*') {
      const close = src.indexOf('*/', i + 2), bodyEnd = close === -1 ? src.length : close;
      // One entry per line, so a marker in a block comment is on the line it is written on.
      let at = i + 2;
      for (const line of src.slice(i + 2, bodyEnd).split('\n')) { comments.push({ at, text: line }); at += line.length + 1; }
      const end = close === -1 ? src.length : close + 2;
      blank(withStrings, i, end); blank(codeOnly, i, end); i = end; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      blank(codeOnly, i + 1, j); i = j + 1; after(c); continue;
    }
    if (c === '`') { i++; template(); continue; }
    if (c === '/' && (prevChar === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prevChar) || REGEX_AFTER_WORD.has(prevWord))) {
      let j = i + 1, inClass = false;
      while (j < src.length && src[j] !== '\n' && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j++;
      }
      blank(codeOnly, i + 1, j); i = j + 1;
      while (/[a-z]/i.test(src[i] || '')) i++;
      after('/'); continue;
    }
    if ((c === '+' || c === '-') && d === c) { i += 2; after(')'); continue; }   // `x++ / n`
    if (templates.length && c === '{') templates[templates.length - 1]++;
    if (templates.length && c === '}') {
      if (templates[templates.length - 1] === 0) { templates.pop(); i++; template(); continue; }
      templates[templates.length - 1]--;
    }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      after(src[j - 1], src.slice(i, j)); i = j; continue;
    }
    after(c); i++;
  }
  return { withStrings: withStrings.join(''), codeOnly: codeOnly.join(''), comments };
}

// Where `text` stops being whitespace, going back from `at`.
const skipSpaceBack = (text, at) => { while (at > 0 && /\s/.test(text[at - 1])) at--; return at; };

// The word ending just before `at` in `text`, past any whitespace; and where that word starts.
function wordBefore(text, at) {
  const end = skipSpaceBack(text, at);
  let start = end;
  while (start > 0 && /[\w$]/.test(text[start - 1])) start--;
  return { word: text.slice(start, end), start, end };
}

// Offsets of the calls to the store or a wrapper that are not awaited, returned or an arrow's body.
function unawaitedCalls(codeOnly) {
  const names = [...new Set([...STORE_METHODS, ...WRAPPERS.map(w => w.name)])];
  const call = new RegExp(`(?<![\\w$])(${names.join('|')})\\s*\\(`, 'g');
  const out = [];
  for (const m of codeOnly.matchAll(call)) {
    // What it is called through: `store.saveDb(` → 'store', `saveDb(` → '', `x[0].saveDb(` → null.
    let start = m.index, via = '';
    const dot = skipSpaceBack(codeOnly, m.index);
    if (codeOnly[dot - 1] === '.') {
      const obj = wordBefore(codeOnly, codeOnly[dot - 2] === '?' ? dot - 2 : dot - 1);
      via = obj.word || null; start = obj.start;
    }
    const name = m[1];
    const isStore = via === 'store' && STORE_METHODS.includes(name);
    const isWrapper = WRAPPERS.some(w => w.name === name && w.via.includes(via));
    if (!isStore && !isWrapper) continue;
    // A declaration rather than a call: `function saveDb() {`, `readState(uid) {`.
    if (!via && wordBefore(codeOnly, start).word === 'function') continue;
    let depth = 0, k = m.index + m[0].length - 1;
    for (; k < codeOnly.length; k++) {
      if (codeOnly[k] === '(') depth++;
      else if (codeOnly[k] === ')' && --depth === 0) break;
    }
    if (!via && /^[ \t]*\{/.test(codeOnly.slice(k + 1))) continue;
    const before = wordBefore(codeOnly, start);
    if (before.word === 'await' || before.word === 'return') continue;
    if (!before.word && codeOnly.slice(Math.max(0, before.end - 2), before.end) === '=>') continue;
    out.push(m.index);
  }
  return out;
}

export function scan(src) {
  const { withStrings, codeOnly, comments } = lex(src);
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);
  const lineOf = at => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= at) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const lines = src.split('\n');
  const key = (line, rule) => `${line} ${rule}`;

  const found = new Map();       // one violation per rule per line
  const add = (line, rule) => { if (!found.has(key(line, rule))) found.set(key(line, rule), { line, rule, excerpt: lines[line - 1].trim().slice(0, 160) }); };
  for (const re of DIRECT_ACCESS) for (const m of withStrings.matchAll(re)) add(lineOf(m.index), 'direct-storage-access');
  for (const at of unawaitedCalls(codeOnly)) add(lineOf(at), 'unawaited-store-call');

  // Exemptions: `storage-boundary-allow <rule>: <reason>` in a comment on the violation's line.
  const allowed = new Set();
  for (const c of comments) {
    const m = MARKER.exec(c.text);
    if (!m) continue;
    const line = lineOf(c.at);
    const rule = RULES.find(r => new RegExp(`^\\s*${r}\\b`).test(m[1]));
    if (!rule && !/^\s*(:|\*?\/?\s*$)/.test(m[1])) continue;     // prose that mentions the marker
    const reason = rule ? m[1].replace(new RegExp(`^\\s*${rule}`), '').replace(/^[\s:—–-]+/, '') : '';
    if (rule && /[a-z]/i.test(reason)) allowed.add(key(line, rule));
    else add(line, 'exemption-without-reason');
  }
  const order = [...RULES, 'exemption-without-reason'];
  return [...found.entries()]
    .filter(([k]) => !allowed.has(k))
    .map(([, v]) => v)
    .sort((a, b) => a.line - b.line || order.indexOf(a.rule) - order.indexOf(b.rule));
}
