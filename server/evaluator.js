'use strict';
// Processus enfant qui exécute les expressions XPath / feuilles XSLT des étudiants.
// Il est lancé par pool.js avec le Permission Model de Node (--permission) :
// pas d'écriture disque, pas de processus enfant, lecture limitée à quelques dossiers.
// On neutralise en plus les points d'entrée JavaScript exposés par SaxonJS (ixsl:eval, js:*).

const proc = process;
const fs = require('fs');
const readText = (p) => fs.readFileSync(p, 'utf8');
const SaxonJS = require('saxon-js');

lockdown();

const MAX_ITEMS = Number(proc.argv[2]) || 1000;
const MAX_ITEM_CHARS = Number(proc.argv[3]) || 50000;
const MAX_DOCS = 4;

const docs = new Map(); // key -> { doc, ns, structure }

function lockdown() {
  const blocked = function () {
    throw new Error("L'exécution de JavaScript est désactivée sur ce serveur");
  };
  for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'process',
    'eval', 'require', 'module', 'SharedArrayBuffer', 'Atomics']) {
    try { delete globalThis[name]; } catch { /* propriété non configurable */ }
    try { globalThis[name] = undefined; } catch { /* lecture seule */ }
  }
  const ctors = [
    Function,
    Object.getPrototypeOf(async function () {}).constructor,
    Object.getPrototypeOf(function* () {}).constructor,
    Object.getPrototypeOf(async function* () {}).constructor,
  ];
  for (const C of ctors) {
    Object.defineProperty(C.prototype, 'constructor', { value: blocked, writable: false, configurable: false });
  }
  globalThis.Function = blocked;
}

// Décrit chaque item de la séquence $r : [type, valeur affichable]
const DESCRIBE_EXPR = `
for $x in subsequence($r, 1, $max) return
  if ($x instance of attribute()) then ['attribute(' || name($x) || ')', name($x) || '="' || string($x) || '"']
  else if ($x instance of element()) then ['element(' || name($x) || ')', serialize($x, map{'indent': true()})]
  else if ($x instance of text()) then ['text()', string($x)]
  else if ($x instance of comment()) then ['comment()', serialize($x)]
  else if ($x instance of processing-instruction()) then ['processing-instruction()', serialize($x)]
  else if ($x instance of document-node()) then ['document-node()', serialize($x, map{'indent': true()})]
  else if ($x instance of namespace-node()) then ['namespace-node()', name($x) || '=' || string($x)]
  else if ($x instance of map(*)) then ['map(*)', serialize($x, map{'method': 'adaptive', 'indent': true()})]
  else if ($x instance of array(*)) then ['array(*)', serialize($x, map{'method': 'adaptive', 'indent': true()})]
  else if ($x instance of function(*)) then ['function(*)',
    (if (exists(function-name($x))) then string(function-name($x)) else '(fonction anonyme)') || '#' || function-arity($x)]
  else if ($x instance of xs:integer) then ['xs:integer', string($x)]
  else if ($x instance of xs:decimal) then ['xs:decimal', string($x)]
  else if ($x instance of xs:double) then ['xs:double', string($x)]
  else if ($x instance of xs:float) then ['xs:float', string($x)]
  else if ($x instance of xs:boolean) then ['xs:boolean', string($x)]
  else if ($x instance of xs:untypedAtomic) then ['xs:untypedAtomic', string($x)]
  else if ($x instance of xs:anyURI) then ['xs:anyURI', string($x)]
  else if ($x instance of xs:string) then ['xs:string', string($x)]
  else if ($x instance of xs:QName) then ['xs:QName', string($x)]
  else if ($x instance of xs:dateTime) then ['xs:dateTime', string($x)]
  else if ($x instance of xs:date) then ['xs:date', string($x)]
  else if ($x instance of xs:time) then ['xs:time', string($x)]
  else if ($x instance of xs:dayTimeDuration) then ['xs:dayTimeDuration', string($x)]
  else if ($x instance of xs:yearMonthDuration) then ['xs:yearMonthDuration', string($x)]
  else if ($x instance of xs:duration) then ['xs:duration', string($x)]
  else ['xs:anyAtomicType', string($x)]`;

// Chemins (éléments et attributs) avec leur nombre d'occurrences, dans l'ordre d'apparition.
// Parcours DOM en JS : bien plus rapide qu'une expression XPath équivalente sur mondial.xml.
function collectPaths(root) {
  const counts = new Map();
  const add = (p) => counts.set(p, (counts.get(p) || 0) + 1);
  const stack = [[root, root.nodeName]];
  while (stack.length) {
    const [el, path] = stack.pop();
    add(path);
    const attrs = el.attributes;
    for (let i = 0; i < attrs.length; i++) {
      const name = attrs.item(i).name;
      if (name !== 'xmlns' && !name.startsWith('xmlns:')) add(`${path}/@${name}`);
    }
    const children = [];
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) children.push([c, `${path}/${c.nodeName}`]);
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return [...counts].map(([path, count]) => ({ path, count }));
}

async function loadDoc(file) {
  let entry = docs.get(file.key);
  if (entry) {
    docs.delete(file.key);
    docs.set(file.key, entry); // LRU : remis en dernière position
    return entry;
  }
  const doc = await SaxonJS.getResource({ text: readText(file.path), type: 'xml' });
  entry = { doc, ns: rootNamespaces(doc), structure: null };
  docs.set(file.key, entry);
  while (docs.size > MAX_DOCS) docs.delete(docs.keys().next().value);
  return entry;
}

function rootNamespaces(doc) {
  const pairs = SaxonJS.XPath.evaluate(
    "for $p in in-scope-prefixes(/*)[not(. = ('', 'xml'))] return [$p, string(namespace-uri-for-prefix($p, /*))]",
    doc, { resultForm: 'array' });
  return Object.fromEntries(pairs);
}

function clip(s) {
  return s.length > MAX_ITEM_CHARS
    ? { text: s.slice(0, MAX_ITEM_CHARS), truncated: true }
    : { text: s, truncated: false };
}

function toError(e) {
  const code = String(e && e.code || '').replace(/^Q\{[^}]*\}/, '') || null;
  const message = String(e && e.message || e)
    .replace(/Q\{http:\/\/www\.w3\.org\/2005\/xqt-errors\}/g, '')
    .replace(/ in (undefined|\/NoStylesheetBaseURI)\b/g, '');
  // SaxonJS renvoie parfois un numéro de ligne interne au compilateur : on ne garde que ceux du texte soumis
  const line = Number(e && e.xsltLineNr) || null;
  return { code, message, line: line && e.lineLimit && line <= e.lineLimit ? line : null };
}

async function xpath({ file, expr, namespaces }) {
  const { doc, ns } = await loadDoc(file);
  const namespaceContext = { ...ns, ...(namespaces || {}) };
  const t0 = performance.now();
  const r = SaxonJS.XPath.evaluate(expr, doc, { resultForm: 'xdm', namespaceContext });
  const elapsed = performance.now() - t0;
  const count = SaxonJS.XPath.evaluate('count($r)', null, { params: { r } });
  const items = SaxonJS.XPath.evaluate(DESCRIBE_EXPR, null, { params: { r, max: MAX_ITEMS }, resultForm: 'array' })
    .map(([type, value]) => ({ type, ...clip(value) }));
  return { count, items, elapsed, namespaces: namespaceContext };
}

async function xslt({ file, xsl }) {
  const { doc } = await loadDoc(file);
  const messages = [];
  const warn = console.warn;
  console.warn = (...args) => { if (messages.length < 500) messages.push(args.join(' ')); };
  const t0 = performance.now();
  try {
    const results = SaxonJS.XPath.evaluate(
      `let $o := transform(map{'stylesheet-text': $s, 'source-node': $d, 'delivery-format': 'serialized'})
       return map:keys($o) ! [string(.), string($o(.))]`,
      null, { params: { s: xsl, d: doc }, resultForm: 'array' });
    const elapsed = performance.now() - t0;
    const output = results.find(([k]) => k === 'output');
    return {
      output: output ? clip(output[1]) : null,
      secondary: results.filter(([k]) => k !== 'output').map(([href, text]) => ({ href, ...clip(text) })),
      messages,
      elapsed,
    };
  } catch (e) {
    if (e && typeof e === 'object') {
      e.messages = messages;
      e.lineLimit = xsl.split('\n').length;
    }
    throw e;
  } finally {
    console.warn = warn;
  }
}

async function check({ text }) {
  const doc = await SaxonJS.getResource({ text, type: 'xml' });
  const [root, elements] = SaxonJS.XPath.evaluate('name(/*), count(//*)', doc, { resultForm: 'array' });
  return { root, elements };
}

async function structure({ file }) {
  const entry = await loadDoc(file);
  if (!entry.structure) entry.structure = collectPaths(entry.doc.documentElement);
  return { paths: entry.structure, namespaces: entry.ns };
}

const ops = { xpath, xslt, check, structure };

proc.on('message', async (msg) => {
  const { id, op } = msg;
  try {
    const result = await ops[op](msg);
    proc.send({ id, ok: true, result });
  } catch (e) {
    proc.send({ id, ok: false, error: { ...toError(e), messages: e && e.messages } });
  }
});

(async () => {
  const preload = proc.argv[4];
  if (preload) {
    try { await loadDoc(JSON.parse(preload)); } catch { /* le chargement sera retenté à la demande */ }
  }
  proc.send({ ready: true });
})();
