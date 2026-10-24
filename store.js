'use strict';
/* Stockage : un seul document JSON (base complète). Fichier local ou PostgreSQL. */
const fs = require('fs');
const path = require('path');

function debounced(fn, ms) {
  let timer = null, running = false, again = false;
  const run = async () => {
    if (running) { again = true; return; }
    running = true;
    try { await fn(); } catch (e) { console.error('[store] écriture impossible :', e.message); }
    running = false;
    if (again) { again = false; schedule(); }
  };
  function schedule() { if (timer) return; timer = setTimeout(() => { timer = null; run(); }, ms); }
  schedule.flush = async () => { if (timer) { clearTimeout(timer); timer = null; } await run(); };
  return schedule;
}

function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'db.json');
  let current = null, lastBackup = 0;
  const write = async () => {
    if (!current) return;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(current));
    if (fs.existsSync(file) && Date.now() - lastBackup > 3600 * 1000) { fs.copyFileSync(file, file + '.bak'); lastBackup = Date.now(); }
    fs.renameSync(tmp, file);
  };
  const schedule = debounced(write, 600);
  return {
    kind: 'fichier (' + dir + ')',
    async load() {
      for (const f of [file, file + '.bak']) {
        try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.error('[store] lecture', f, e.message); }
      }
      return null;
    },
    save(db) { current = db; schedule(); },
    flush: () => schedule.flush()
  };
}

function pgStore(url) {
  let Pool;
  try { ({ Pool } = require('pg')); } catch (e) { throw new Error("DATABASE_URL défini mais le module 'pg' est absent : lancez 'npm install'."); }
  const pool = new Pool({ connectionString: url, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }, max: 3 });
  let current = null, ready = false;
  const init = async () => {
    if (ready) return;
    await pool.query("CREATE TABLE IF NOT EXISTS pp_kv (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())");
    ready = true;
  };
  const write = async () => {
    if (!current) return;
    await init();
    await pool.query("INSERT INTO pp_kv(key,value,updated_at) VALUES('db',$1::jsonb,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [JSON.stringify(current)]);
  };
  const schedule = debounced(write, 800);
  return {
    kind: 'PostgreSQL',
    async load() {
      await init();
      const r = await pool.query("SELECT value FROM pp_kv WHERE key='db'");
      return r.rows[0] ? r.rows[0].value : null;
    },
    save(db) { current = db; schedule(); },
    flush: () => schedule.flush()
  };
}

function createStore() {
  if (process.env.DATABASE_URL) return pgStore(process.env.DATABASE_URL);
  return fileStore(process.env.DATA_DIR || path.join(__dirname, 'data'));
}
module.exports = { createStore, fileStore, pgStore };
