'use strict';

const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');

const storage = require('./storage');
const { EvaluatorPool, EvalError } = require('./pool');
const { checkSource } = require('./guard');

const env = (name, fallback) => (process.env[name] !== undefined && process.env[name] !== '' ? process.env[name] : fallback);

const config = {
  port: Number(env('PORT', 3000)),
  adminPassword: env('ADMIN_PASSWORD', ''),
  maxUploadMb: Number(env('MAX_UPLOAD_MB', 5)),
  maxFiles: Number(env('MAX_FILES', 200)),
  poolSize: Number(env('POOL_SIZE', Math.max(2, Math.min(4, os.cpus().length)))),
  timeoutMs: Number(env('EVAL_TIMEOUT_MS', 10000)),
  memoryMb: Number(env('EVAL_MEMORY_MB', 768)),
  maxItems: Number(env('MAX_RESULT_ITEMS', 1000)),
  maxItemChars: Number(env('MAX_ITEM_CHARS', 50000)),
  trustProxy: env('TRUST_PROXY', 'loopback'),
};
// « 1 » = nombre de proxys ; sinon Express l'interpréterait comme une adresse IP
if (/^\d+$/.test(config.trustProxy)) config.trustProxy = Number(config.trustProxy);

const pool = new EvaluatorPool({
  size: config.poolSize,
  timeoutMs: config.timeoutMs,
  memoryMb: config.memoryMb,
  maxItems: config.maxItems,
  maxItemChars: config.maxItemChars,
  readDirs: [storage.BUILTIN_DIR, storage.FILES_DIR],
  preload: fileRef(storage.getFile('mondial')),
});

function fileRef(file) {
  return { key: file.id, path: file.path };
}

const app = express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '1mb' }));

const evalLimiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false });
const uploadLimiter = rateLimit({
  windowMs: 60 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Trop de téléversements, réessayez plus tard.' },
});
const adminLimiter = rateLimit({
  windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessayez plus tard.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1, fields: 4 },
});

function isAdmin(req) {
  if (!config.adminPassword) return false;
  const given = Buffer.from(String(req.get('X-Admin-Password') || ''));
  const expected = Buffer.from(config.adminPassword);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function requireFile(req, res) {
  const file = storage.getFile(String(req.params.id || req.body?.fileId || ''));
  if (!file) res.status(404).json({ error: 'Fichier introuvable.' });
  return file;
}

// Décode le XML selon le BOM ou la déclaration d'encodage, et le normalise en UTF-8
function decodeXml(buffer) {
  let encoding = 'utf-8';
  if (buffer[0] === 0xff && buffer[1] === 0xfe) encoding = 'utf-16le';
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) encoding = 'utf-16be';
  else {
    const head = buffer.subarray(0, 200).toString('latin1');
    const m = /^\s*<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/.exec(head);
    if (m) encoding = m[1];
  }
  let text;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`Le fichier n'est pas correctement encodé (${encoding}).`);
  }
  text = text.replace(/^﻿/, '');
  return text.replace(/^(\s*<\?xml[^>]*encoding\s*=\s*)["'][\w.:-]+["']/, '$1"UTF-8"');
}

async function evaluate(res, op, payload) {
  try {
    const result = await pool.run(op, payload);
    if (result.error) return res.json({ ok: false, error: { kind: op, ...result.error } });
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof EvalError) {
      return res.status(e.kind === 'busy' ? 503 : 200).json({ ok: false, error: { kind: e.kind, message: e.message } });
    }
    throw e;
  }
}

// --- Fichiers -------------------------------------------------------------

app.get('/api/config', (req, res) => {
  res.json({
    maxUploadMb: config.maxUploadMb,
    timeoutMs: config.timeoutMs,
    maxItems: config.maxItems,
    adminEnabled: Boolean(config.adminPassword),
  });
});

app.get('/api/files', (req, res) => {
  res.json(storage.listFiles());
});

app.get('/api/files/:id', (req, res) => {
  const file = requireFile(req, res);
  if (!file) return;
  // text/plain + CSP : le XML d'un étudiant ne doit jamais être interprété comme une page sur ce domaine
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  res.set('Cache-Control', file.builtin ? 'public, max-age=86400' : 'public, max-age=3600');
  if (req.query.download !== undefined) {
    res.attachment(file.name);
    res.type('application/xml');
  } else {
    res.type('text/plain; charset=utf-8');
  }
  res.sendFile(file.path);
});

app.get('/api/files/:id/structure', evalLimiter, async (req, res) => {
  const file = requireFile(req, res);
  if (!file) return;
  await evaluate(res, 'structure', { file: fileRef(file) });
});

app.post('/api/files', uploadLimiter, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `Fichier trop volumineux (maximum ${config.maxUploadMb} Mo).`
        : `Téléversement invalide (${err.code}).`;
      return res.status(413).json({ error: msg });
    }
    next(err);
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  if (storage.count() >= config.maxFiles) {
    return res.status(507).json({ error: 'Nombre maximal de fichiers partagés atteint. Contactez votre enseignant.' });
  }
  let text;
  try {
    text = decodeXml(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (checkSource(text)) {
    return res.status(400).json({ error: 'Ce fichier contient des références à des extensions non autorisées.' });
  }
  let info;
  try {
    info = await pool.run('check', { text });
  } catch (e) {
    if (e instanceof EvalError) return res.status(400).json({ error: `Analyse impossible : ${e.message}` });
    throw e;
  }
  if (info.error) {
    return res.status(400).json({ error: `Le fichier n'est pas un XML bien formé : ${info.error.message}` });
  }
  const name = req.body.name || Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const entry = await storage.addFile({ name, buffer: Buffer.from(text, 'utf8'), ...info });
  res.status(201).json(entry);
});

app.delete('/api/files/:id', adminLimiter, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Mot de passe administrateur requis.' });
  const file = storage.getFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'Fichier introuvable.' });
  if (file.builtin) return res.status(400).json({ error: 'Ce fichier intégré ne peut pas être supprimé.' });
  await storage.deleteFile(file.id);
  res.status(204).end();
});

app.post('/api/admin/login', adminLimiter, (req, res) => {
  if (!config.adminPassword) return res.status(403).json({ error: "L'administration est désactivée (ADMIN_PASSWORD non défini)." });
  if (!isAdmin(req)) return res.status(403).json({ error: 'Mot de passe incorrect.' });
  res.json({ ok: true });
});

// --- Évaluation -----------------------------------------------------------

app.post('/api/xpath', evalLimiter, async (req, res) => {
  const { expr, namespaces } = req.body || {};
  if (typeof expr !== 'string' || !expr.trim()) return res.status(400).json({ error: 'Expression vide.' });
  if (expr.length > 20000) return res.status(400).json({ error: 'Expression trop longue.' });
  const ns = {};
  if (namespaces && typeof namespaces === 'object') {
    for (const [p, uri] of Object.entries(namespaces)) {
      if (/^[A-Za-z_][\w.-]*$/.test(p) && typeof uri === 'string') ns[p] = uri;
    }
  }
  const denied = checkSource(expr) || checkSource(Object.values(ns).join(' '));
  if (denied) return res.json({ ok: false, error: { kind: 'xpath', code: 'INTERDIT', message: denied } });
  const file = requireFile(req, res);
  if (!file) return;
  await evaluate(res, 'xpath', { file: fileRef(file), expr, namespaces: ns });
});

app.post('/api/xslt', evalLimiter, async (req, res) => {
  const { xsl } = req.body || {};
  if (typeof xsl !== 'string' || !xsl.trim()) return res.status(400).json({ error: 'Feuille de style vide.' });
  if (xsl.length > 200000) return res.status(400).json({ error: 'Feuille de style trop longue.' });
  const denied = checkSource(xsl);
  if (denied) return res.json({ ok: false, error: { kind: 'xslt', code: 'INTERDIT', message: denied } });
  const file = requireFile(req, res);
  if (!file) return;
  await evaluate(res, 'xslt', { file: fileRef(file), xsl });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue.' }));

// --- Interface (build Vite) -----------------------------------------------

const DIST = path.join(__dirname, '..', 'dist');
app.use(express.static(DIST, { index: 'index.html', maxAge: '1h' }));
app.get('/{*splat}', (req, res) => res.sendFile(path.join(DIST, 'index.html')));

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Erreur interne du serveur.' });
});

storage.init().then(() => {
  const server = app.listen(config.port, () => {
    console.log(`XPath/XSLT Lab sur http://localhost:${config.port} (évaluateurs : ${config.poolSize})`);
    if (!config.adminPassword) console.warn('ADMIN_PASSWORD non défini : la suppression de fichiers est désactivée.');
  });
  const shutdown = () => {
    pool.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
});
