import { createEditor, getText, setText, insertAtCursor } from './editor.js';
import { el, renderError, renderXPathResult, renderXsltResult } from './render.js';
import { MONDIAL_EXAMPLES, GENERIC_EXAMPLES, MONDIAL_XSLT, GENERIC_XSLT } from './examples.js';

const $ = (id) => document.getElementById(id);

// --- Préférences locales (le stockage peut être indisponible : navigation privée…) ---

const store = {
  get(key, fallback = null, area = localStorage) {
    try { const v = area.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value, area = localStorage) {
    try { area.setItem(key, JSON.stringify(value)); } catch { /* ignoré */ }
  },
  remove(key, area = localStorage) {
    try { area.removeItem(key); } catch { /* ignoré */ }
  },
};

const state = {
  config: { maxUploadMb: 5, adminEnabled: false },
  files: [],
  file: null,
  admin: store.get('xlab.admin', null, sessionStorage),
  requests: {},
};

// --- API ------------------------------------------------------------------

async function api(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const init = { method, headers: { ...headers }, signal };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`/api${path}`, init);
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  // Les erreurs d'évaluation ({ ok: false, error: {...} }) sont des résultats à afficher, pas des exceptions
  if (!res.ok && !(data && data.error && typeof data.error === 'object')) {
    throw new Error((data && data.error) || `Erreur HTTP ${res.status}`);
  }
  return data;
}

// Une seule requête en cours par onglet : la précédente est annulée
async function evaluate(kind, path, body) {
  state.requests[kind]?.abort();
  const ctrl = new AbortController();
  state.requests[kind] = ctrl;
  try {
    return await api(path, { method: 'POST', body, signal: ctrl.signal });
  } finally {
    if (state.requests[kind] === ctrl) state.requests[kind] = null;
  }
}

// --- Notifications --------------------------------------------------------

let toastTimer;
function toast(message, isError = false) {
  const t = $('toast');
  t.textContent = message;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3500);
}

// --- Éditeurs -------------------------------------------------------------

const xpathEditor = createEditor($('xpath-editor'), {
  doc: store.get('xlab.xpath', "//country[@car_code = 'MA']/name"),
  onRun: runXPath,
  onChange: (text) => store.set('xlab.xpath', text),
  hint: 'Saisissez une expression XPath, puis Ctrl+Entrée',
});

const xsltEditor = createEditor($('xslt-editor'), {
  mode: 'xml',
  onRun: runXslt,
  onChange: (text) => { if (state.file) store.set(`xlab.xslt.${state.file.id}`, text); },
});

const defaultXslt = (file) => (file && file.id === 'mondial' ? MONDIAL_XSLT : GENERIC_XSLT);

// --- Onglets --------------------------------------------------------------

function showTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(active));
    $(`tab-${tab.dataset.tab}`).hidden = !active;
  }
  store.set('xlab.tab', name);
  (name === 'xpath' ? xpathEditor : xsltEditor).requestMeasure();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
}

// --- Fichiers -------------------------------------------------------------

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

async function loadFiles(selectId) {
  state.files = await api('/files');
  const select = $('file-select');
  const builtin = state.files.filter((f) => f.builtin);
  const shared = state.files.filter((f) => !f.builtin);
  const option = (f) => el('option', { value: f.id }, f.builtin ? f.name : `${f.name} — ${formatDate(f.uploadedAt)}`);
  select.replaceChildren(
    el('optgroup', { label: 'Fichier par défaut' }, builtin.map(option)),
    shared.length ? el('optgroup', { label: `Fichiers partagés (${shared.length})` }, shared.map(option)) : null,
  );
  const wanted = selectId || state.file?.id || store.get('xlab.file');
  const file = state.files.find((f) => f.id === wanted) || builtin[0];
  select.value = file.id;
  await selectFile(file);
}

async function selectFile(file) {
  const changed = state.file?.id !== file.id;
  state.file = file;
  store.set('xlab.file', file.id);

  $('file-meta').textContent = file.builtin
    ? `${formatSize(file.size)} · ${file.description || ''}`
    : `${formatSize(file.size)} · <${file.root}> · ${file.elements} éléments`;
  $('file-view').href = `/api/files/${encodeURIComponent(file.id)}`;
  $('file-download').href = `/api/files/${encodeURIComponent(file.id)}?download`;
  updateAdminUi();
  renderExamples();

  if (changed) {
    setText(xsltEditor, store.get(`xlab.xslt.${file.id}`, defaultXslt(file)));
    $('xpath-result').replaceChildren();
    $('xslt-result').replaceChildren();
  }
  await loadStructure(file);
}

$('file-select').addEventListener('change', (e) => {
  const file = state.files.find((f) => f.id === e.target.value);
  if (file) selectFile(file).catch((err) => toast(err.message, true));
});

$('upload-btn').addEventListener('click', () => $('upload-input').click());

$('upload-input').addEventListener('change', async (e) => {
  const input = e.target;
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  if (file.size > state.config.maxUploadMb * 1024 * 1024) {
    toast(`Fichier trop volumineux (maximum ${state.config.maxUploadMb} Mo).`, true);
    return;
  }
  const form = new FormData();
  form.append('name', file.name);
  form.append('file', file);
  const btn = $('upload-btn');
  btn.disabled = true;
  btn.textContent = 'Envoi…';
  try {
    const entry = await api('/files', { method: 'POST', body: form });
    await loadFiles(entry.id);
    toast(`« ${entry.name} » est maintenant disponible pour tous les utilisateurs.`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Téléverser un XML…';
  }
});

// --- Administration -------------------------------------------------------

function updateAdminUi() {
  $('admin-btn').hidden = !state.config.adminEnabled;
  $('admin-btn').classList.toggle('active', Boolean(state.admin));
  $('admin-btn').textContent = state.admin ? 'Admin ✓' : 'Admin';
  $('delete-btn').hidden = !(state.admin && state.file && !state.file.builtin);
}

$('admin-btn').addEventListener('click', async () => {
  if (state.admin) {
    state.admin = null;
    store.remove('xlab.admin', sessionStorage);
    updateAdminUi();
    toast('Mode administrateur désactivé.');
    return;
  }
  const password = window.prompt('Mot de passe administrateur :');
  if (!password) return;
  try {
    await api('/admin/login', { method: 'POST', headers: { 'X-Admin-Password': password } });
    state.admin = password;
    store.set('xlab.admin', password, sessionStorage);
    updateAdminUi();
    toast('Mode administrateur activé : vous pouvez supprimer les fichiers partagés.');
  } catch (err) {
    toast(err.message, true);
  }
});

$('delete-btn').addEventListener('click', async () => {
  const file = state.file;
  if (!file || file.builtin) return;
  if (!window.confirm(`Supprimer définitivement « ${file.name} » pour tous les utilisateurs ?`)) return;
  try {
    await api(`/files/${encodeURIComponent(file.id)}`, { method: 'DELETE', headers: { 'X-Admin-Password': state.admin } });
    store.remove(`xlab.xslt.${file.id}`);
    state.file = null;
    await loadFiles('mondial');
    toast(`« ${file.name} » a été supprimé.`);
  } catch (err) {
    toast(err.message, true);
  }
});

// --- Structure du document -------------------------------------------------

let structureTree = null;

function buildTree(paths) {
  const root = { children: new Map() };
  for (const { path, count } of paths) {
    let node = root;
    const parts = path.split('/');
    parts.forEach((name, i) => {
      if (!node.children.has(name)) {
        node.children.set(name, { name, path: parts.slice(0, i + 1).join('/'), count: 0, children: new Map() });
      }
      node = node.children.get(name);
    });
    node.count = count;
  }
  return root;
}

function renderTree(node, depth, filter) {
  const ul = el('ul');
  // Attributs d'abord, puis éléments ; l'ordre d'apparition est conservé (tri stable)
  const children = [...node.children.values()].sort((a, b) => b.name.startsWith('@') - a.name.startsWith('@'));
  for (const child of children) {
    const sub = child.children.size ? renderTree(child, depth + 1, filter) : null;
    const matches = !filter || child.path.toLowerCase().includes(filter);
    if (filter && !matches && !(sub && sub.children.length)) continue;
    const collapsed = Boolean(sub) && depth >= 1 && !filter;
    const isAttr = child.name.startsWith('@');
    ul.append(el('li', { class: collapsed ? 'collapsed' : '' },
      el('div', { class: 'node-row' },
        el('button', {
          class: `node-toggle${sub ? '' : ' leaf'}`, type: 'button', 'aria-label': 'Déplier ou replier',
          onclick: (e) => {
            const item = e.currentTarget.closest('li');
            item.classList.toggle('collapsed');
            e.currentTarget.textContent = item.classList.contains('collapsed') ? '▸' : '▾';
          },
        }, collapsed ? '▸' : '▾'),
        el('button', {
          class: `node-name${isAttr ? ' attr' : ''}`, type: 'button', title: `Insérer /${child.path}`,
          onclick: () => {
            showTab('xpath');
            insertAtCursor(xpathEditor, `/${child.path}`);
          },
        }, isAttr ? child.name : `<${child.name}>`),
        el('span', { class: 'node-count' }, `×${child.count.toLocaleString('fr-FR')}`)),
      sub));
  }
  return ul;
}

function showStructure() {
  const filter = $('structure-filter').value.trim().toLowerCase();
  const tree = renderTree(structureTree, 0, filter);
  $('structure').replaceChildren(tree.children.length ? tree : el('p', { class: 'muted' }, 'Aucun chemin ne correspond.'));
}

async function loadStructure(file) {
  $('structure').replaceChildren(el('p', { class: 'muted' }, 'Analyse du document…'));
  const data = await api(`/files/${encodeURIComponent(file.id)}/structure`);
  if (state.file?.id !== file.id) return;
  if (!data.ok) {
    $('structure').replaceChildren(el('p', { class: 'muted' }, data.error.message));
    return;
  }
  structureTree = buildTree(data.paths);
  showStructure();
  const ns = Object.entries(data.namespaces);
  $('ns-auto').replaceChildren(...(ns.length
    ? ns.map(([p, uri]) => el('div', {}, `${p} → ${uri}`))
    : [el('div', {}, 'Aucun préfixe déclaré à la racine de ce document.')]));
}

$('structure-filter').addEventListener('input', () => { if (structureTree) showStructure(); });

// --- Exemples -------------------------------------------------------------

function renderExamples() {
  const groups = state.file?.id === 'mondial' ? MONDIAL_EXAMPLES : GENERIC_EXAMPLES;
  $('examples').replaceChildren(...groups.map((g) => el('div', {},
    el('h3', {}, g.group),
    g.items.map(([expr, label]) => el('button', {
      class: 'example', type: 'button',
      onclick: () => {
        showTab('xpath');
        setText(xpathEditor, expr);
        runXPath();
      },
    }, el('code', {}, expr), el('span', {}, label))))));
}

// --- Historique -----------------------------------------------------------

function renderHistory() {
  const history = store.get('xlab.history', []);
  $('history').replaceChildren(
    el('option', { value: '' }, history.length ? `Historique (${history.length})` : 'Historique (vide)'),
    ...history.map((expr, i) => el('option', { value: String(i) }, expr.replace(/\s+/g, ' ').slice(0, 90))),
  );
}

function pushHistory(expr) {
  const history = store.get('xlab.history', []).filter((e) => e !== expr);
  history.unshift(expr);
  store.set('xlab.history', history.slice(0, 30));
  renderHistory();
}

$('history').addEventListener('change', (e) => {
  const expr = store.get('xlab.history', [])[Number(e.target.value)];
  e.target.value = '';
  if (expr !== undefined) {
    setText(xpathEditor, expr);
    xpathEditor.focus();
  }
});

// --- Espaces de noms supplémentaires ---------------------------------------

$('ns-input').value = store.get('xlab.ns', '');
$('ns-input').addEventListener('input', (e) => store.set('xlab.ns', e.target.value));

function parseNamespaces(text) {
  const ns = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][\w.-]*)\s*=\s*(\S+)\s*$/.exec(line);
    if (m) ns[m[1]] = m[2];
  }
  return ns;
}

// --- Évaluation -----------------------------------------------------------

async function run(kind, path, body, render) {
  const result = $(`${kind}-result`);
  const status = $(`${kind}-status`);
  const btn = $(`${kind}-run`);
  btn.disabled = true;
  status.textContent = kind === 'xpath' ? 'Évaluation…' : 'Transformation…';
  let superseded = false;
  try {
    const data = await evaluate(kind, path, body);
    if (data.ok) render(result, data);
    else renderError(result, data.error);
  } catch (err) {
    // Annulée par une requête plus récente : c'est elle qui mettra l'interface à jour
    superseded = err.name === 'AbortError';
    if (!superseded) renderError(result, { kind: 'network', message: err.message });
  } finally {
    if (!superseded) {
      btn.disabled = false;
      status.textContent = '';
    }
  }
}

function runXPath() {
  const expr = getText(xpathEditor).trim();
  if (!expr || !state.file) return;
  pushHistory(expr);
  run('xpath', '/xpath', { fileId: state.file.id, expr, namespaces: parseNamespaces($('ns-input').value) }, renderXPathResult);
}

function runXslt() {
  const xsl = getText(xsltEditor);
  if (!xsl.trim() || !state.file) return;
  run('xslt', '/xslt', { fileId: state.file.id, xsl }, renderXsltResult);
}

$('xpath-run').addEventListener('click', runXPath);
$('xslt-run').addEventListener('click', runXslt);
$('xslt-reset').addEventListener('click', () => {
  if (window.confirm('Remplacer la feuille de style actuelle par l’exemple de départ ?')) {
    setText(xsltEditor, defaultXslt(state.file));
  }
});

// --- Démarrage ------------------------------------------------------------

(async () => {
  renderHistory();
  showTab(store.get('xlab.tab', 'xpath'));
  try {
    state.config = await api('/config');
    if (!state.config.adminEnabled) state.admin = null;
    await loadFiles();
  } catch (err) {
    toast(`Impossible de contacter le serveur : ${err.message}`, true);
  }
})();
