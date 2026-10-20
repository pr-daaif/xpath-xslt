// Affichage des résultats XPath / XSLT. Tout le texte venant du serveur est échappé.

export const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// Coloration syntaxique XML minimale (balises, attributs, commentaires)
export function highlightXml(text) {
  const re = /(<!--[\s\S]*?-->)|(<!\[CDATA\[[\s\S]*?\]\]>)|(<\?[\s\S]*?\?>)|(<!DOCTYPE[^>]*>)|(<\/?[^\s>/]+)([^>]*?)(\/?>)/g;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += escapeHtml(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] || m[3] || m[4]) {
      out += `<span class="x-comment">${escapeHtml(m[0])}</span>`;
    } else if (m[2]) {
      out += escapeHtml(m[0]);
    } else {
      const attrs = escapeHtml(m[6]).replace(
        /([\w:.-]+)(\s*=\s*)(&quot;.*?&quot;|&#39;.*?&#39;)/g,
        '<span class="x-attr">$1</span>$2<span class="x-val">$3</span>');
      out += `<span class="x-tag">${escapeHtml(m[5])}</span>${attrs}<span class="x-tag">${escapeHtml(m[7])}</span>`;
    }
  }
  return out + escapeHtml(text.slice(last));
}

const looksLikeXml = (type) => /^(element|document-node|comment|processing-instruction)/.test(type);

export function formatMs(ms) {
  return ms < 1 ? '< 1 ms' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function copyButton(getText) {
  return el('button', {
    class: 'btn ghost small', type: 'button',
    onclick: async (e) => {
      try {
        await navigator.clipboard.writeText(getText());
        e.target.textContent = 'Copié ✓';
        setTimeout(() => { e.target.textContent = 'Copier'; }, 1500);
      } catch { /* presse-papiers indisponible (site non HTTPS) */ }
    },
  }, 'Copier');
}

function messagesList(messages) {
  return el('ol', { class: 'messages' }, messages.map((m) => el('li', {}, m)));
}

const ERROR_TITLES = {
  timeout: 'Délai dépassé',
  crash: 'Évaluation interrompue',
  busy: 'Serveur occupé',
  network: 'Erreur réseau',
  xslt: 'Erreur XSLT',
  xpath: 'Erreur XPath',
};

export function renderError(container, error) {
  container.replaceChildren(el('div', { class: 'error-box', role: 'alert' },
    el('div', {},
      error.code ? el('span', { class: 'code' }, error.code) : null,
      el('strong', {}, ERROR_TITLES[error.kind] || 'Erreur'),
      error.line ? ` — ligne ${error.line}` : ''),
    el('p', {}, error.message || 'Erreur inconnue'),
    error.messages && error.messages.length ? messagesList(error.messages) : null,
  ));
}

export function renderXPathResult(container, data) {
  const shown = data.items.length;
  const head = el('div', { class: 'result-head' },
    el('strong', {}, data.count === 1 ? '1 item' : `${data.count.toLocaleString('fr-FR')} items`),
    shown < data.count ? el('span', { class: 'muted' }, `(affichage des ${shown} premiers)`) : null,
    el('span', { class: 'muted' }, `· ${formatMs(data.elapsed)}`),
    data.count ? copyButton(() => data.items.map((i) => i.text).join('\n')) : null,
  );
  if (!data.count) {
    container.replaceChildren(head, el('div', { class: 'empty-seq' }, '() — séquence vide'));
    return;
  }
  const list = el('ol', { class: 'items' });
  data.items.forEach((item, i) => {
    const pre = looksLikeXml(item.type) ? el('pre', { html: highlightXml(item.text) }) : el('pre', {}, item.text);
    list.append(el('li', { class: 'item' },
      el('div', { class: 'item-index' }, i + 1),
      el('div', { class: 'item-body' },
        el('span', { class: 'item-type' }, item.type),
        pre,
        item.truncated ? el('div', { class: 'truncated' }, '… (valeur tronquée)') : null)));
  });
  container.replaceChildren(head, list);
}

const looksLikeHtml = (s) => /^\s*(<!DOCTYPE html|<html[\s>])/i.test(s) || /<(body|div|table|p|ul|h1)[\s>]/i.test(s);

export function renderXsltResult(container, data) {
  const views = [];
  if (data.output) {
    const text = data.output.text;
    if (looksLikeHtml(text)) {
      views.push({
        label: 'Aperçu HTML',
        // sandbox vide : aucun script, origine opaque
        render: () => el('iframe', { sandbox: '', srcdoc: text, title: 'Aperçu du résultat HTML' }),
      });
    }
    views.push({
      label: 'Source',
      render: () => el('div', {},
        el('pre', { html: highlightXml(text) }),
        data.output.truncated ? el('div', { class: 'truncated' }, '… (sortie tronquée)') : null),
    });
  }
  for (const doc of data.secondary) {
    views.push({ label: doc.href, render: () => el('pre', { html: highlightXml(doc.text) }) });
  }
  if (data.messages.length) {
    views.push({ label: `Messages (${data.messages.length})`, render: () => messagesList(data.messages) });
  }

  const head = el('div', { class: 'result-head' },
    el('strong', {}, 'Transformation réussie'),
    el('span', { class: 'muted' }, `· ${formatMs(data.elapsed)}`),
    data.output ? copyButton(() => data.output.text) : null);

  if (!views.length) {
    container.replaceChildren(head, el('div', { class: 'empty-seq' }, 'Aucune sortie produite.'));
    return;
  }

  const body = el('div', { class: 'output-body' });
  const tabs = el('div', { class: 'output-tabs' });
  const select = (i) => {
    [...tabs.children].forEach((b, j) => b.classList.toggle('active', i === j));
    body.replaceChildren(views[i].render());
  };
  views.forEach((v, i) => tabs.append(el('button', { class: 'btn ghost small', type: 'button', onclick: () => select(i) }, v.label)));
  container.replaceChildren(head, el('div', { class: 'output' }, tabs, body));
  select(0);
}
