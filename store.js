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
    flush: () => schedule.flush(),
    async putFile(id, buf) { fs.mkdirSync(path.join(dir, 'files'), { recursive: true }); fs.writeFileSync(path.join(dir, 'files', id + '.bin'), buf); },
    async getFile(id) { const f = path.join(dir, 'files', id + '.bin'); return fs.existsSync(f) ? fs.readFileSync(f) : null; },
    async delFile(id) { try { fs.unlinkSync(path.join(dir, 'files', id + '.bin')); } catch (e) {} },
    async putBackup(meta, buf) { const d = path.join(dir, 'backups'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, meta.id + '.json.gz'), buf); fs.writeFileSync(path.join(d, meta.id + '.meta.json'), JSON.stringify(meta)); },
    async listBackups() {
      const d = path.join(dir, 'backups'); if (!fs.existsSync(d)) return [];
      return fs.readdirSync(d).filter(f => f.endsWith('.meta.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch (e) { return null; } }).filter(Boolean).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
    async getBackup(id) { const f = path.join(dir, 'backups', id + '.json.gz'); return fs.existsSync(f) ? fs.readFileSync(f) : null; },
    async pruneBackups(keep) {
      const all = await this.listBackups();
      for (const m of all.slice(keep)) { try { fs.unlinkSync(path.join(dir, 'backups', m.id + '.json.gz')); fs.unlinkSync(path.join(dir, 'backups', m.id + '.meta.json')); } catch (e) {} }
    }
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
    await pool.query("CREATE TABLE IF NOT EXISTS pp_files (id text PRIMARY KEY, data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now())");
    await pool.query("CREATE TABLE IF NOT EXISTS pp_backups (id text PRIMARY KEY, meta jsonb NOT NULL, data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now())");
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
    flush: () => schedule.flush(),
    async putFile(id, buf) { await init(); await pool.query("INSERT INTO pp_files(id,data) VALUES($1,$2) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data", [id, buf]); },
    async getFile(id) { await init(); const r = await pool.query("SELECT data FROM pp_files WHERE id=$1", [id]); return r.rows[0] ? r.rows[0].data : null; },
    async delFile(id) { await init(); await pool.query("DELETE FROM pp_files WHERE id=$1", [id]); },
    async putBackup(meta, buf) { await init(); await pool.query("INSERT INTO pp_backups(id,meta,data) VALUES($1,$2::jsonb,$3) ON CONFLICT (id) DO UPDATE SET meta=EXCLUDED.meta, data=EXCLUDED.data", [meta.id, JSON.stringify(meta), buf]); },
    async listBackups() { await init(); const r = await pool.query("SELECT meta FROM pp_backups ORDER BY created_at DESC"); return r.rows.map(x => x.meta); },
    async getBackup(id) { await init(); const r = await pool.query("SELECT data FROM pp_backups WHERE id=$1", [id]); return r.rows[0] ? r.rows[0].data : null; },
    async pruneBackups(keep) { await init(); await pool.query("DELETE FROM pp_backups WHERE id NOT IN (SELECT id FROM pp_backups ORDER BY created_at DESC LIMIT $1)", [keep]); }
  };
}

function createStore() {
  if (process.env.DATABASE_URL) return pgStore(process.env.DATABASE_URL);
  return fileStore(process.env.DATA_DIR || path.join(__dirname, 'data'));
}
module.exports = { createStore, fileStore, pgStore };
