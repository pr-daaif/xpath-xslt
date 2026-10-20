'use strict';
// Pool de processus évaluateurs (server/evaluator.js).
// Chaque tâche a un délai maximal : au-delà, le processus est tué puis relancé.

const { fork } = require('child_process');
const path = require('path');

const EVALUATOR = path.join(__dirname, 'evaluator.js');
const NODE_MODULES = path.join(__dirname, '..', 'node_modules');

class EvalError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

class EvaluatorPool {
  constructor({ size, timeoutMs, memoryMb, readDirs, maxQueue = 200, maxItems, maxItemChars, preload }) {
    this.timeoutMs = timeoutMs;
    this.maxQueue = maxQueue;
    this.args = [String(maxItems), String(maxItemChars), preload ? JSON.stringify(preload) : ''];
    this.execArgv = [
      '--permission',
      ...[NODE_MODULES, EVALUATOR, ...readDirs].map((p) => `--allow-fs-read=${p}`),
      `--max-old-space-size=${memoryMb}`,
    ];
    this.queue = [];
    this.nextId = 1;
    this.slots = Array.from({ length: size }, () => this.spawn({}));
  }

  spawn(slot) {
    slot.ready = false;
    slot.task = null;
    slot.timedOut = false;
    slot.child = fork(EVALUATOR, this.args, {
      env: {},
      execArgv: this.execArgv,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    slot.child.on('message', (msg) => this.onMessage(slot, msg));
    slot.child.on('exit', (code, signal) => this.onExit(slot, code, signal));
    return slot;
  }

  run(op, payload) {
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new EvalError('busy', 'Serveur surchargé, réessayez dans quelques secondes.'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, op, payload, resolve, reject });
      this.dispatch();
    });
  }

  dispatch() {
    for (const slot of this.slots) {
      if (!this.queue.length) return;
      if (!slot.ready || slot.task) continue;
      const task = this.queue.shift();
      slot.task = task;
      task.timer = setTimeout(() => {
        slot.timedOut = true;
        slot.child.kill('SIGKILL');
      }, this.timeoutMs);
      slot.child.send({ id: task.id, op: task.op, ...task.payload });
    }
  }

  onMessage(slot, msg) {
    if (msg.ready) {
      slot.ready = true;
      this.dispatch();
      return;
    }
    const task = slot.task;
    if (!task || task.id !== msg.id) return;
    clearTimeout(task.timer);
    slot.task = null;
    // Une erreur XPath/XSLT est un résultat normal pour l'étudiant, pas un rejet
    task.resolve(msg.ok ? msg.result : { error: msg.error });
    this.dispatch();
  }

  onExit(slot, code, signal) {
    const task = slot.task;
    if (task) {
      clearTimeout(task.timer);
      task.reject(slot.timedOut
        ? new EvalError('timeout', `Délai dépassé : l'évaluation a été interrompue après ${this.timeoutMs / 1000} s.`)
        : new EvalError('crash', `L'évaluation a épuisé la mémoire disponible ou a échoué (${signal || code}).`));
    }
    if (this.closed) return;
    // Un processus mort avant d'être prêt indique un problème de démarrage : on évite de boucler
    const wasReady = slot.ready;
    slot.ready = false;
    setTimeout(() => this.spawn(slot), wasReady ? 0 : 1000);
  }

  close() {
    this.closed = true;
    for (const slot of this.slots) slot.child.kill();
  }
}

module.exports = { EvaluatorPool, EvalError };
