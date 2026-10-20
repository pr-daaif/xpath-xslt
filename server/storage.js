'use strict';
// Stockage des fichiers XML partagés : data/files/<uuid>.xml + data/index.json.
// mondial.xml est intégré (builtin/) et ne peut pas être supprimé.

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

const BUILTIN_DIR = path.join(__dirname, '..', 'builtin');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const FILES_DIR = path.join(DATA_DIR, 'files');
const INDEX = path.join(DATA_DIR, 'index.json');

const BUILTIN = [{
  id: 'mondial',
  name: 'mondial.xml',
  path: path.join(BUILTIN_DIR, 'mondial.xml'),
  builtin: true,
  description: 'Base géographique Mondial (Université de Göttingen)',
}];
for (const f of BUILTIN) f.size = fsSync.statSync(f.path).size;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let entries = [];
let writing = Promise.resolve();

async function init() {
  await fs.mkdir(FILES_DIR, { recursive: true });
  try {
    entries = JSON.parse(await fs.readFile(INDEX, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    entries = [];
  }
}

function persist() {
  // Écritures sérialisées et atomiques (fichier temporaire puis renommage)
  writing = writing.then(async () => {
    const tmp = `${INDEX}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entries, null, 2));
    await fs.rename(tmp, INDEX);
  });
  return writing;
}

function publicView(f) {
  const { path: _path, ...rest } = f;
  return { builtin: false, ...rest };
}

function listFiles() {
  const uploaded = [...entries].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  return [...BUILTIN, ...uploaded].map(publicView);
}

function getFile(id) {
  const builtin = BUILTIN.find((f) => f.id === id);
  if (builtin) return builtin;
  if (!ID_RE.test(id)) return null;
  const entry = entries.find((f) => f.id === id);
  return entry ? { ...entry, path: path.join(FILES_DIR, `${id}.xml`) } : null;
}

function sanitizeName(name) {
  let base = path.basename(String(name || 'fichier.xml'))
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} ._()-]/gu, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/\.xml$/i.test(base)) base += '.xml';
  if (base.length > 80) base = base.slice(0, 76) + '.xml';
  return base;
}

async function addFile({ name, buffer, root, elements }) {
  const id = crypto.randomUUID();
  await fs.writeFile(path.join(FILES_DIR, `${id}.xml`), buffer, { flag: 'wx' });
  const entry = {
    id,
    name: sanitizeName(name),
    size: buffer.length,
    uploadedAt: new Date().toISOString(),
    root,
    elements,
  };
  entries.push(entry);
  await persist();
  return publicView(entry);
}

async function deleteFile(id) {
  const i = entries.findIndex((f) => f.id === id);
  if (i < 0) return false;
  entries.splice(i, 1);
  await persist();
  await fs.rm(path.join(FILES_DIR, `${id}.xml`), { force: true });
  return true;
}

module.exports = {
  init, listFiles, getFile, addFile, deleteFile,
  count: () => entries.length,
  BUILTIN_DIR, FILES_DIR,
};
