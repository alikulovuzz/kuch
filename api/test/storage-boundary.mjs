/* The storage-boundary scanner (test/storage-boundary.test.js has the rules and their limits).
   scan(source) reads one module's text and answers its violations, [{ line, rule, excerpt }], in
   line order. Lexical: comments, strings, template literals and regular expressions are told
   apart by a small lexer, nothing more. */

// The store's methods, called as `store.<method>(…)` (store/index.js).
export const STORE = {
  object: 'store',
  methods: ['loadDb', 'saveDb', 'readState', 'readStateStrict', 'readStateCached', 'readStateRev', 'casWriteState', 'deleteState', 'listStateUids', 'health']
};

// Thin wrappers that hand back a store call's promise, and the objects they are called through
// ('' is a plain call). A new wrapper around the store goes here.
export const WRAPPERS = [
  { name: 'saveDb', via: [''] },                    // server.js: function saveDb() { return store.saveDb(db); }
  { name: 'readState', via: ['', 'jobs'] },         // coach/jobs.js, and media.js's injected store.readState
  { name: 'listUserIds', via: ['', 'jobs'] }        // coach/jobs.js: () => store.listStateUids()
];

export const RULES = ['direct-storage-access', 'unawaited-store-call'];

// The account database by name, and a training-document name being built or matched.
const DIRECT = [/\bdb\.json\b/g, /\bstate-(?:\$\{|['"`]|[^\n]*?\.json)/g];
const MARKER = /storage-boundary-allow\b(.*)/;
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/* Splits source into `code` (comments blanked) and `bare` (strings, template text and regular
   expressions blanked too; the code inside `${…}` stays), both the same length as the source with
   every newline kept, plus the comments' text with their offsets. */
function lex(src) {
  const code = src.split(''), bare = src.split(''), comments = [];
  const blank = (out, from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  const templates = [];           // per open `${`, the `{` depth inside it
  let last = '', word = '';       // the last significant character, and the word it ended
  let i = 0;
  const significant = (ch, w = '') => { last = ch; word = w; };
  const template = () => {        // i is just past a backtick, or past the `}` closing a `${`
    const start = i;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') { blank(bare, start, i); i++; significant('`'); return; }
      if (src[i] === '$' && src[i + 1] === '{') { blank(bare, start, i); i += 2; templates.push(0); significant('{'); return; }
      i++;
    }
    blank(bare, start, i);
  };
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
      comments.push({ at: i, text: src.slice(i + 2, end) });
      blank(code, i, end); blank(bare, i, end); i = end; continue;
    }
    if (c === '/' && d === '*') {
      const close = src.indexOf('*/', i + 2), end = close === -1 ? src.length : close + 2;
      // One entry per line, so a marker in a block comment is on the line it is written on.
      let at = i + 2;
      for (const line of src.slice(i + 2, close === -1 ? src.length : close).split('\n')) { comments.push({ at, text: line }); at += line.length + 1; }
      blank(code, i, end); blank(bare, i, end); i = end; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      blank(bare, i + 1, j); i = j + 1; significant(c); continue;
    }
    if (c === '`') { i++; template(); continue; }
    if (c === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last) || REGEX_AFTER_WORD.has(word))) {
      let j = i + 1, inClass = false;
      while (j < src.length && src[j] !== '\n' && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j++;
      }
      blank(bare, i + 1, j); i = j + 1;
      while (/[a-z]/i.test(src[i] || '')) i++;
      significant('/'); continue;
    }
    if (templates.length && c === '{') templates[templates.length - 1]++;
    if (templates.length && c === '}') {
      if (templates[templates.length - 1] === 0) { templates.pop(); i++; template(); continue; }
      templates[templates.length - 1]--;
    }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      significant(src[j - 1], src.slice(i, j)); i = j; continue;
    }
    significant(c); i++;
  }
  return { code: code.join(''), bare: bare.join(''), comments };
}

// The word ending just before `at` in `text`, skipping whitespace; and where that word starts.
function wordBefore(text, at) {
  let j = at;
  while (j > 0 && /\s/.test(text[j - 1])) j--;
  let k = j;
  while (k > 0 && /[\w$]/.test(text[k - 1])) k--;
  return { word: text.slice(k, j), start: k, end: j };
}

// Calls to the store or a wrapper in `bare` that are not awaited, returned or an arrow's body.
function unawaitedCalls(bare) {
  const names = [...new Set([...STORE.methods, ...WRAPPERS.map(w => w.name)])];
  const call = new RegExp(`(?<![\\w$])(${names.join('|')})\\s*\\(`, 'g');
  const out = [];
  for (const m of bare.matchAll(call)) {
    // The object it is called through, if any: `store.saveDb(`, `jobs.readState(`, `saveDb(`.
    let start = m.index, via = '';
    let j = start;
    while (j > 0 && /\s/.test(bare[j - 1])) j--;
    if (bare[j - 1] === '.') {
      const obj = wordBefore(bare, bare[j - 2] === '?' ? j - 2 : j - 1);
      via = obj.word; start = obj.start;
    }
    const name = m[1];
    const isStore = via === STORE.object && STORE.methods.includes(name);
    const isWrapper = WRAPPERS.some(w => w.name === name && w.via.includes(via));
    if (!isStore && !isWrapper) continue;
    // A declaration rather than a call: `function saveDb() {`, `readState(uid) {`.
    if (!via && wordBefore(bare, start).word === 'function') continue;
    let depth = 0, k = m.index + m[0].length - 1;
    for (; k < bare.length; k++) {
      if (bare[k] === '(') depth++;
      else if (bare[k] === ')' && --depth === 0) break;
    }
    if (!via && /^\s*\{/.test(bare.slice(k + 1))) continue;
    const before = wordBefore(bare, start);
    if (before.word === 'await' || before.word === 'return') continue;
    if (!before.word && bare.slice(Math.max(0, before.end - 2), before.end) === '=>') continue;
    out.push(m.index);
  }
  return out;
}

export function scan(src) {
  const { code, bare, comments } = lex(src);
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);
  const lineOf = at => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= at) lo = mid; else hi = mid - 1; } return lo + 1; };
  const lines = src.split('\n');
  const excerpt = line => lines[line - 1].trim().slice(0, 160);

  const found = new Map();       // `${line} ${rule}` -> violation, one per rule per line
  const add = (line, rule) => { if (!found.has(`${line} ${rule}`)) found.set(`${line} ${rule}`, { line, rule, excerpt: excerpt(line) }); };
  for (const re of DIRECT) for (const m of code.matchAll(re)) add(lineOf(m.index), 'direct-storage-access');
  for (const at of unawaitedCalls(bare)) add(lineOf(at), 'unawaited-store-call');

  // Exemptions: `storage-boundary-allow <rule>: <reason>` in a comment on the violation's line.
  const allowed = new Set();
  for (const c of comments) {
    const m = MARKER.exec(c.text);
    if (!m) continue;
    const line = lineOf(c.at);
    const rule = RULES.find(r => new RegExp(`^\\s*${r}\\b`).test(m[1]));
    const reason = rule ? m[1].replace(new RegExp(`^\\s*${rule}`), '').replace(/^[\s:—–-]+/, '') : '';
    if (rule && /[a-z]/i.test(reason)) allowed.add(`${line} ${rule}`);
    else add(line, 'exemption-without-reason');
  }
  const order = [...RULES, 'exemption-without-reason'];
  return [...found.entries()]
    .filter(([key]) => !allowed.has(key))
    .map(([, v]) => v)
    .sort((a, b) => a.line - b.line || order.indexOf(a.rule) - order.indexOf(b.rule));
}
