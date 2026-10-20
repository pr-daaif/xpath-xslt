// Éditeurs CodeMirror 6 (XPath : texte brut, XSLT : mode XML), thème piloté par les variables CSS.

import { basicSetup } from 'codemirror';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { xml } from '@codemirror/lang-xml';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
  '.cm-content': { caretColor: 'var(--text)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--surface-2)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent-soft) 45%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--accent-soft)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent) !important',
  },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '1px solid var(--border)' },
  '.cm-placeholder': { color: 'var(--muted)' },
});

const highlight = HighlightStyle.define([
  { tag: [t.tagName, t.angleBracket], color: 'var(--code-tag)' },
  { tag: t.attributeName, color: 'var(--code-attr)' },
  { tag: t.attributeValue, color: 'var(--code-val)' },
  { tag: [t.comment, t.processingInstruction, t.documentMeta], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: t.string, color: 'var(--code-val)' },
]);

export function createEditor(parent, { doc = '', mode = 'text', onRun, onChange, hint } = {}) {
  const extensions = [
    Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => { onRun?.(); return true; } }])),
    basicSetup,
    theme,
    syntaxHighlighting(highlight),
    EditorView.lineWrapping,
    EditorView.updateListener.of((u) => { if (u.docChanged) onChange?.(u.state.doc.toString()); }),
  ];
  if (mode === 'xml') extensions.push(xml());
  if (hint) extensions.push(placeholder(hint));
  return new EditorView({ doc, parent, extensions });
}

export const getText = (view) => view.state.doc.toString();

export function setText(view, text) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } });
}

export function insertAtCursor(view, text) {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
  view.focus();
}
