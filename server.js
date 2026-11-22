'use strict';
/* Portail Parents — serveur central (CST Manjo). Aucune dépendance obligatoire (pg seulement avec DATABASE_URL). */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createStore } = require('./store');
const push = require('./push');

const VERSION = '1.2.0';
const SERVICE = 'portail-parents-server';
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = (Number(process.env.MAX_BODY_MB) || 30) * 1024 * 1024;
const SESSION_TTL = 12 * 3600;                        // secondes (le client attend 43200)
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
/* Fichiers de l'application : dossier public/ s'il existe, sinon directement à la racine (liste blanche). */
const HAS_PUBLIC = fs.existsSync(path.join(__dirname, 'public'));
const PUBLIC_DIR = HAS_PUBLIC ? path.join(__dirname, 'public') : __dirname;
const ROOT_ALLOWED = new Set(['index.html', 'manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png']);

/* ---------- jeux de clés synchronisées ---------- */
const ARRAY_ADMIN = ['teachers', 'parents', 'classes', 'subjects', 'sequences', 'templates', 'events', 'students', 'staff'];
const OBJECT_ADMIN = ['classPrincipals', 'supervisor', 'profiles', 'smsSettings', 'whatsappSettings', 'school'];
const SHARED = ['messages', 'bulletins', 'bulletinRequests', 'bulletinHistory', 'grades', 'absences', 'annonces', 'profileRequests'];
/* Personnel de direction : droits de chaque fonction (surveillant = compte historique). vie : 'write' (saisie) ou 'read' (lecture) */
const STAFF_ROLES = {
  surveillant: { label: 'Surveillant général', vie: 'write', notes: true, bulletins: false, annonces: false },
  vice: { label: 'Vice-principal', vie: 'read', notes: true, bulletins: true, annonces: true },
  prefet: { label: 'Préfet des études', vie: 'read', notes: true, bulletins: true, annonces: true },
  comptable: { label: 'Comptable', vie: false, notes: false, bulletins: false, annonces: true }
};
const capsOf = acc => STAFF_ROLES[(acc && acc.staffRole) || 'surveillant'] || STAFF_ROLES.surveillant;
const MAX_ATTACH = (Number(process.env.MAX_ATTACH_MB) || 6) * 1024 * 1024;
const MAX_RECORDS = 60000;
const MAX_FILE = (Number(process.env.MAX_FILE_MB) || 10) * 1024 * 1024;
const PUSH_ON = process.env.PUSH_ENABLED !== 'false';
const PUSH_ALLOW_ANY = process.env.PUSH_ALLOW_ANY === 'true';      // tests uniquement
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@cst-manjo.cm';
const BACKUP_EVERY = Number(process.env.BACKUP_EVERY_MS) || (Number(process.env.BACKUP_EVERY_HOURS) || 24) * 3600 * 1000;
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP) || 30;

/* ---------- utilitaires ---------- */
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const digits = s => String(s == null ? '' : s).replace(/\D/g, '');
const phoneKey = s => { const d = digits(s); return d.length >= 8 ? d.slice(-9) : ''; };
const same = (a, b) => { const c = o => { const x = Object.assign({}, o); delete x._rev; return JSON.stringify(x); }; return c(a) === c(b); };
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const isObj = o => o && typeof o === 'object' && !Array.isArray(o);

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { scheme: 'scrypt', salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') };
}
function verifyCred(cred, pw) {
  pw = String(pw == null ? '' : pw);
  if (!cred || !pw) return false;
  if (cred.scheme === 'scrypt') return safeEq(crypto.scryptSync(pw, cred.salt, 32).toString('hex'), cred.hash);
  if (cred.scheme === 'cst-sha256') {      // même hachage que l'application (compatibilité avec les comptes existants)
    return [pw, pw.replace(/\s/g, '')].some(c => safeEq(sha256('CST|' + c + '|Manjo'), cred.hash));
  }
  if (cred.scheme === 'phone') { const k = phoneKey(pw); return !!k && k === cred.hash; }
  if (cred.scheme === 'plain') return [pw, pw.replace(/\s/g, '')].some(c => safeEq(c, cred.hash));
  return false;
}

/* ---------- base en mémoire ---------- */
const store = createStore();
let db = null;
function freshDb() { return { revision: 0, adminRevision: 0, state: {}, accounts: {}, sessions: {}, notifs: {}, files: {}, push: {}, vapid: null, lastBackupAt: 0, createdAt: new Date().toISOString() }; }
const persist = () => store.save(db);

/* ---------- comptes ---------- */
/* Première connexion : les parents, enseignants et le surveillant s'identifient par leur NOM et choisissent eux-mêmes un code à 4 chiffres.
   FIRST_LOGIN_PHONE=false désactive la vérification du numéro de téléphone enregistré lors de ce premier choix. */
const FIRST_LOGIN_PHONE = process.env.FIRST_LOGIN_PHONE !== 'false';
const nameTokens = s => norm(s).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean);
function nameMatches(acc, typed) {
  const t = nameTokens(typed);
  if (!t.length) return false;
  return (acc.names || []).some(n => {
    const a = nameTokens(n);
    if (!a.length) return false;
    return t.every(x => a.includes(x)) || a.every(x => t.includes(x));
  });
}
const weakPin = pin => /^(\d)\1{3}$/.test(pin) || ['1234', '4321', '0123', '3210', '1212', '2580', '0852', '1122'].includes(pin);
function provision(kind, rec) {
  if (!rec || rec.id == null) return null;
  const staff = kind === 'staff';
  const id = kind + ':' + rec.id;
  let acc = db.accounts[id], created = false;
  if (!acc) { acc = db.accounts[id] = { id, role: staff ? 'supervisor' : kind, refId: rec.id, cred: null, pending: true }; created = true; }
  acc.role = staff ? 'supervisor' : kind;
  acc.staffRole = staff ? (STAFF_ROLES[rec.role] && rec.role !== 'surveillant' ? rec.role : 'vice') : (kind === 'supervisor' ? 'surveillant' : undefined);
  acc.label = acc.staffRole ? STAFF_ROLES[acc.staffRole].label : undefined;
  acc.name = rec.name || acc.name || kind;
  acc.names = (kind === 'supervisor' ? [rec.name, rec.username || 'surveillant', 'surveillant'] : [rec.name]).filter(Boolean);
  acc.phoneKey = phoneKey(rec.phone);
  acc.active = rec.active !== false;
  acc.pending = !acc.cred;
  return { created, account: acc };
}
function autoProvision() {
  const st = db.state, keep = new Set(['admin']);
  (st.teachers || []).forEach(t => { const r = provision('teacher', t); if (r) keep.add(r.account.id); });
  (st.parents || []).forEach(p => { const r = provision('parent', p); if (r) keep.add(r.account.id); });
  if (isObj(st.supervisor) && st.supervisor.id != null) { const r = provision('supervisor', st.supervisor); if (r) keep.add(r.account.id); }
  (st.staff || []).forEach(x => { const r = provision('staff', x); if (r) keep.add(r.account.id); });
  for (const id of Object.keys(db.accounts)) if (!keep.has(id)) { delete db.accounts[id]; delete db.notifs[id]; }
  for (const [h, s] of Object.entries(db.sessions)) if (!db.accounts[s.acc]) delete db.sessions[h];
}
function findAccounts(typed, phone) {
  const u = norm(typed);
  if (['admin', norm(process.env.ADMIN_USERNAME || 'admin')].includes(u)) return db.accounts.admin ? [db.accounts.admin] : [];
  let c = Object.values(db.accounts).filter(a => a.role !== 'admin' && nameMatches(a, typed));
  const pk = phoneKey(phone);
  if (pk) c = c.filter(a => a.phoneKey === pk);
  return c;
}
function migrateAccounts() {
  for (const a of Object.values(db.accounts)) {
    if (a.role === 'admin') continue;
    if (!a.names) a.names = [a.name].filter(Boolean);
    if (a.phoneKey === undefined) a.phoneKey = ((a.usernames || []).find(x => String(x).startsWith('tel:')) || '').slice(4);
    a.pending = !a.cred;
  }
  if (process.env.RESET_ALL_ACCESS === 'true') {
    for (const a of Object.values(db.accounts)) if (a.role !== 'admin') { a.cred = null; a.pending = true; }
    db.sessions = Object.fromEntries(Object.entries(db.sessions).filter(([, s]) => (db.accounts[s.acc] || {}).role === 'admin'));
    console.log('[ACCÈS] Tous les comptes (hors administrateur) devront choisir un nouveau code à 4 chiffres.');
  }
}

function ensureAdmin() {
  const username = norm(process.env.ADMIN_USERNAME || 'admin');
  let acc = db.accounts.admin;
  const pw = process.env.ADMIN_PASSWORD;
  if (!acc || (pw && process.env.RESET_ADMIN === 'true')) {
    let pass = pw;
    if (!pass) { pass = crypto.randomBytes(9).toString('base64url'); console.log('\n[ADMIN] Aucun ADMIN_PASSWORD défini. Mot de passe généré (à noter, affiché une seule fois) : ' + pass + '\n'); }
    db.accounts.admin = { id: 'admin', role: 'admin', refId: 'admin', name: 'Administration', usernames: [...new Set(['admin', username])], active: true, cred: hashPw(pass), srcHash: null };
    persist();
  }
}

/* ---------- sessions et limitation de débit ---------- */
const attempts = new Map();
function tooMany(key, max = 8, win = 10 * 60 * 1000) { const a = attempts.get(key); return !!(a && a.n >= max && Date.now() - a.t < win); }
function noteFail(key, win = 10 * 60 * 1000) { const a = attempts.get(key); if (!a || Date.now() - a.t > win) attempts.set(key, { n: 1, t: Date.now() }); else a.n++; }
function newSession(acc) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  for (const [h, s] of Object.entries(db.sessions)) if (s.exp < now) delete db.sessions[h];
  db.sessions[sha256(token)] = { acc: acc.id, exp: now + SESSION_TTL * 1000 };
  return token;
}
function authenticate(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const s = db.sessions[sha256(m[1])];
  if (!s || s.exp < Date.now()) return null;
  const acc = db.accounts[s.acc];
  return acc && acc.active ? acc : null;
}
function publicUser(acc) {
  return { id: acc.role === 'admin' ? 'admin' : acc.refId, role: acc.role, username: (acc.names || acc.usernames || [])[0] || acc.id, name: acc.name, staffRole: acc.staffRole, label: acc.label };
}

/* ---------- contexte d'un utilisateur ---------- */
function ctxFor(acc) {
  const st = db.state, ctx = { acc, role: acc.role, ref: acc.refId, classes: [], me: null };
  const cls = new Set();
  if (acc.role === 'teacher') {
    const t = (st.teachers || []).find(x => String(x.id) === String(acc.refId)); ctx.me = t || null;
    if (t) { (t.classes || []).forEach(c => cls.add(norm(c))); if (t.principalClass) cls.add(norm(t.principalClass)); }
    Object.entries(st.classPrincipals || {}).forEach(([c, tid]) => { if (String(tid) === String(acc.refId)) cls.add(norm(c)); });
  } else if (acc.role === 'parent') {
    const p = (st.parents || []).find(x => String(x.id) === String(acc.refId)); ctx.me = p || null;
    if (p) { (p.children || []).forEach(c => { if (c) cls.add(norm(typeof c === 'object' ? (c.className || c.classe || c.class) : '')); }); if (p.className) cls.add(norm(p.className)); }
    cls.delete('');
  } else if (acc.role === 'supervisor') {
    ctx.me = String(acc.id).indexOf('staff:') === 0 ? ((st.staff || []).find(x => String(x.id) === String(acc.refId)) || null) : (isObj(st.supervisor) ? st.supervisor : null);
    ctx.label = acc.label || 'Surveillant général'; ctx.caps = capsOf(acc);
  }
  ctx.classes = [...cls];
  return ctx;
}
const inClasses = (ctx, c) => ctx.classes.includes(norm(c));

function visibleMsg(m, ctx) {
  if (ctx.role === 'admin') return true;
  const me = ctx.me;
  if (ctx.role === 'teacher') {
    if (!me) return false;
    return m.to === me.name || m.from === me.name ||
      (m.recipientRole === 'teacher' && idIs(m.recipientId, 'teacher', me.id)) ||
      (m.senderRole === 'teacher' && idIs(m.senderId, 'teacher', me.id));
  }
  if (ctx.role === 'supervisor') {
    const lab = ctx.label;
    return (m.recipientRole === 'supervisor' && (m.recipientId == null || idIs(m.recipientId, 'supervisor', ctx.ref))) || (m.senderRole === 'supervisor' && idIs(m.senderId, 'supervisor', ctx.ref)) || m.to === lab || m.from === lab || (me && (m.to === me.name || m.from === me.name)) || m.group === 'ALL';
  }
  if (ctx.role === 'parent') {
    if (!me) return false;
    if (m.parentId != null && String(m.parentId) === String(me.id)) return true;
    if (m.to === me.name || m.from === me.name) return true;
    if (m.group === 'ALL') return true;
    if (m.group && inClasses(ctx, m.group)) return true;
    if (m.groupId && m.recipientRole === 'parent' && String(m.recipientId) === String(me.id)) return true;
    return false;
  }
  return false;
}

/* ---------- fusion des enregistrements partagés ---------- */
const RANK = { deliveryStatus: { local: 0, queued: 0, sent: 1, delivered: 2, read: 3 }, status: { requested: 0, sent: 1, delivered: 2 }, stage: { toPrincipal: 1, sentToParents: 2 } };
const higher = (field, a, b) => { const r = RANK[field] || {}; return (r[b] == null ? -1 : r[b]) > (r[a] == null ? -1 : r[a]) ? b : a; };
function mergeRecord(key, old, inc) {
  const out = Object.assign({}, old || {}, inc);
  if (!old) return out;
  if (key === 'messages') {
    out.read = !!(old.read || inc.read);
    out.readBy = Object.assign({}, old.readBy || {}, inc.readBy || {});
    if (old.readAt || inc.readAt) out.readAt = old.readAt || inc.readAt;
    out.deliveryStatus = higher('deliveryStatus', old.deliveryStatus, inc.deliveryStatus) || out.deliveryStatus;
  } else if (key === 'bulletinRequests') out.status = higher('status', old.status, inc.status);
  else if (key === 'bulletins') out.stage = higher('stage', old.stage, inc.stage);
  return out;
}
const MUT_MSG = ['read', 'readBy', 'readAt', 'deliveryStatus', 'deliveredAt', 'sentAt', 'starred'];
const pick = (src, fields) => { const o = {}; fields.forEach(f => { if (src[f] !== undefined) o[f] = src[f]; }); return o; };

/* Identifiant d'expéditeur : accepte 12 ou "teacher:12" / "supervisor:1". */
const idIs = (v, role, ref) => String(v) === String(ref) || String(v) === role + ':' + ref;

/* Pièce jointe : on ne garde que le nom, le type et l'identifiant du fichier stocké par ce même compte (jamais d'identifiant d'un autre). */
function cleanAttach(att, acc) {
  if (!isObj(att)) return null;
  const out = { name: String(att.name || 'fichier').slice(0, 120), size: att.size, type: String(att.type || '').slice(0, 80) };
  if (att.fileId) {
    const f = db.files[att.fileId];
    if (f && f.kind === 'attach' && (f.owner === acc.id || acc.role === 'admin')) { out.fileId = att.fileId; return out; }
    return null;
  }
  if (typeof att.data === 'string' && att.data.length <= 300000) { out.data = att.data; return out; }
  return null;
}

/* Renvoie l'enregistrement fusionné, ou null si l'écriture n'est pas autorisée. */
function authorize(key, old, raw, ctx) {
  const role = ctx.role, ref = ctx.ref;
  if (role === 'admin') return mergeRecord(key, old, raw);
  switch (key) {
    case 'messages': {
      if (old) { if (!visibleMsg(old, ctx)) return null; return mergeRecord(key, old, pick(raw, MUT_MSG)); }
      if (role === 'supervisor') raw = Object.assign({}, raw, { senderRole: 'supervisor', senderId: 'supervisor:' + ref, from: ctx.label });     // identité imposée par le serveur
      if (raw.senderRole && (raw.senderRole !== role || !idIs(raw.senderId, role, ref))) return null;
      if (role === 'parent' && (raw.group || raw.groupId)) return null;
      if (role === 'teacher' && raw.group && (raw.group === 'ALL' || !inClasses(ctx, raw.group))) return null;
      if (role === 'teacher' && raw.parentId != null && !(db.state.parents || []).some(p => String(p.id) === String(raw.parentId))) return null;
      if (!visibleMsg(raw, ctx)) return null;
      const rec = Object.assign({}, raw);
      if (rec.attach) { rec.attach = cleanAttach(rec.attach, ctx.acc); if (!rec.attach) delete rec.attach; }
      if (rec.voice && JSON.stringify(rec.voice).length > 400000) rec.voice = null;
      return rec;
    }
    case 'annonces': {
      if (role === 'supervisor' && ctx.caps.annonces) {
        if (old) return String(old.byAcc) === ctx.acc.id ? mergeRecord(key, old, pick(raw, ['title', 'body', 'target', 'pinned', 'urgent'])) : null;
        if (JSON.stringify(raw).length > 20000) return null;
        return Object.assign({}, raw, { by: ctx.label, byAcc: ctx.acc.id });
      }
      return null;
    }
    case 'profileRequests': {
      if (role !== 'parent' || old) return null;
      const ch = isObj(raw.changes) ? raw.changes : {}, nm = String(ch.name || '').trim().slice(0, 80), ph = String(ch.phone || '').trim().slice(0, 30);
      if ((!nm && !ph) || String(raw.parentId) !== String(ref)) return null;
      if ((db.state.profileRequests || []).some(r => String(r.parentId) === String(ref) && r.status === 'pending')) return null;
      return { id: raw.id, parentId: ref, parentName: ctx.me ? ctx.me.name : '', changes: Object.assign({}, nm ? { name: nm } : {}, ph ? { phone: ph } : {}), reason: String(raw.reason || '').slice(0, 300), status: 'pending', createdAt: raw.createdAt || new Date().toISOString() };
    }
    case 'bulletinRequests': {
      if (role === 'parent') {
        if (old) return null;
        if (String(raw.parentId) !== String(ref) || !inClasses(ctx, raw.className)) return null;
        return Object.assign({}, raw, { status: 'requested' });
      }
      if (role === 'teacher' && old && inClasses(ctx, old.className)) return mergeRecord(key, old, pick(raw, ['status', 'deliveredAt']));
      return null;
    }
    case 'bulletins': {
      if (role === 'supervisor' && ctx.caps.bulletins) {
        if (!old) {
          if (raw.kind !== 'class' || !raw.fileId || !db.files[raw.fileId] || !(db.state.teachers || []).some(t => String(t.id) === String(raw.principalTeacherId))) return null;
          const rep = (db.state.bulletins || []).filter(b => b.kind === 'class' && norm(b.className) === norm(raw.className) && b.sequence === raw.sequence).map(b => b.id);
          return Object.assign({ _replaces: rep }, pick(raw, ['id', 'className', 'sequence', 'name', 'fileId', 'size', 'date', 'type', 'available', 'principalTeacherId']), { kind: 'class', stage: 'toPrincipal', importedBy: ctx.label });
        }
        return old.kind === 'class' ? mergeRecord(key, old, pick(raw, ['available'])) : null;
      }
      if (role === 'teacher' && old && old.requestId != null && String(old.principalTeacherId) === String(ref)) return mergeRecord(key, old, pick(raw, ['stage', 'forwardedAt', 'forwardedBy']));
      return null;
    }
    case 'bulletinHistory': {
      if (old) return null;
      if (role === 'parent' && String(raw.parentId) !== String(ref)) return null;
      if (JSON.stringify(raw).length > 5000) return null;
      return Object.assign({}, raw);
    }
    case 'grades': {
      if (role === 'teacher' && inClasses(ctx, raw.className) && (!old || inClasses(ctx, old.className))) return mergeRecord(key, old, raw);
      return null;
    }
    case 'absences': {
      if (role === 'parent') {
        if (!(old && inClasses(ctx, old.className))) return null;
        const upd = pick(raw, ['justification', 'status']);
        if (isObj(upd.justification)) { upd.justification = Object.assign({}, upd.justification); if (upd.justification.attach) { const ca = cleanAttach(upd.justification.attach, ctx.acc); if (ca) upd.justification.attach = ca; else delete upd.justification.attach; } }
        return mergeRecord(key, old, upd);
      }
      if (role === 'supervisor') return ctx.caps.vie === 'write' ? mergeRecord(key, old, raw) : null;
      if (role === 'teacher' && inClasses(ctx, raw.className) && (!old || inClasses(ctx, old.className))) return mergeRecord(key, old, raw);
      return null;
    }
  }
  return null;
}

function mergeShared(key, postedArr, ctx, base, allowDelete, rev) {
  const cur = db.state[key] || (db.state[key] = []);
  const map = new Map(cur.map(r => [String(r.id), r]));
  let changed = false;
  const postedIds = new Set();
  for (const raw of postedArr) {
    if (!isObj(raw) || raw.id == null) continue;
    const id = String(raw.id); postedIds.add(id);
    const old = map.get(id);
    const res = authorize(key, old, raw, ctx);
    if (!res) continue;
    if (res._replaces) { res._replaces.forEach(x => map.delete(String(x))); delete res._replaces; }
    if (!old || !same(old, res)) { res._rev = rev; map.set(id, res); changed = true; }
  }
  if (allowDelete) for (const [id, r] of map) if (!postedIds.has(id) && (r._rev || 0) <= base) { map.delete(id); changed = true; }
  if (map.size > MAX_RECORDS) return false;
  db.state[key] = [...map.values()];
  return changed;
}

/* ---------- vue filtrée d'un état pour chaque rôle ---------- */
const noPw = o => { const c = Object.assign({}, o); delete c.password; return c; };
const teacherPub = t => ({ id: t.id, name: t.name, subjects: t.subjects || [], classes: t.classes || [], active: t.active !== false, isPrincipal: t.isPrincipal, principalClass: t.principalClass });
function viewFor(ctx) {
  const st = db.state, role = ctx.role, out = {};
  const A = k => Array.isArray(st[k]) ? st[k] : [];
  if (role === 'admin') {
    ARRAY_ADMIN.forEach(k => { out[k] = A(k); });
    OBJECT_ADMIN.forEach(k => { if (isObj(st[k])) out[k] = st[k]; });
    SHARED.forEach(k => { out[k] = A(k); });
    return out;
  }
  ['classes', 'subjects', 'sequences', 'events', 'annonces'].forEach(k => { out[k] = A(k); });
  out.classPrincipals = isObj(st.classPrincipals) ? st.classPrincipals : {};
  if (isObj(st.school) && Object.keys(st.school).length) out.school = st.school;   // nom, année et téléphone de l'établissement (public)
  const msgs = A('messages').filter(m => visibleMsg(m, ctx));
  out.messages = msgs;
  if (role === 'parent') {
    const p = ctx.me;
    out.parents = p ? [noPw(p)] : [];
    const myKids = p ? (p.children || []).map(c => norm(typeof c === 'object' ? c.name : c)).concat(norm(p.student)).filter(Boolean) : [];
    out.teachers = A('teachers').filter(t => (t.classes || []).some(c => inClasses(ctx, c)) || (t.principalClass && inClasses(ctx, t.principalClass))).map(teacherPub);
    out.students = A('students').filter(s => myKids.includes(norm(s.name)));
    out.bulletinRequests = A('bulletinRequests').filter(r => String(r.parentId) === String(ctx.ref));
    const reqIds = new Set(out.bulletinRequests.map(r => String(r.id)));
    out.bulletins = A('bulletins').filter(b => b.stage === 'sentToParents' && inClasses(ctx, b.className) && b.requestId != null && reqIds.has(String(b.requestId)));
    out.bulletinHistory = A('bulletinHistory').filter(h => String(h.parentId) === String(ctx.ref));
    out.profileRequests = A('profileRequests').filter(r => String(r.parentId) === String(ctx.ref));
    out.grades = A('grades').filter(g => inClasses(ctx, g.className) && myKids.includes(norm(g.student)));
    out.absences = A('absences').filter(a => inClasses(ctx, a.className) && myKids.includes(norm(a.student)));
  } else if (role === 'teacher') {
    out.teachers = A('teachers').map(t => String(t.id) === String(ctx.ref) ? noPw(t) : teacherPub(t));
    const myParents = A('parents').filter(p => (p.children || []).some(c => c && typeof c === 'object' && inClasses(ctx, c.className || c.classe || c.class)) || (p.className && inClasses(ctx, p.className)));
    out.parents = myParents.map(p => { const c = noPw(p); delete c.password; return c; });
    out.students = A('students').filter(s => inClasses(ctx, s.className));
    out.bulletinRequests = A('bulletinRequests').filter(r => inClasses(ctx, r.className));
    out.bulletins = A('bulletins').filter(b => String(b.principalTeacherId) === String(ctx.ref));
    out.bulletinHistory = A('bulletinHistory').filter(h => String(h.teacherId) === String(ctx.ref) || String(h.forwardedBy) === String(ctx.ref));
    out.grades = A('grades').filter(g => inClasses(ctx, g.className));
    out.absences = A('absences').filter(a => inClasses(ctx, a.className));
  } else if (role === 'supervisor') {
    const caps = ctx.caps || STAFF_ROLES.surveillant;
    out.supervisor = ctx.me ? Object.assign(noPw(ctx.me), { staffRole: ctx.acc.staffRole, label: ctx.label }) : {};
    out.teachers = A('teachers').map(teacherPub);
    out.parents = A('parents').map(noPw);
    out.students = A('students');
    out.absences = caps.vie ? A('absences') : [];
    out.grades = caps.notes ? A('grades') : [];
    out.bulletins = caps.bulletins ? A('bulletins').filter(b => b.kind === 'class') : [];
    out.bulletinRequests = []; out.bulletinHistory = [];
  }
  return out;
}

/* ---------- gestion des routes ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const need = (c, status, msg) => { if (!c) throw new HttpError(status, msg); };

function login(body, ip) {
  need(isObj(body), 400, 'Requête invalide');
  const u = String(body.username || '').trim(), pw = String(body.password || '');
  need(u && pw, 400, 'Nom et code requis');
  const k1 = ip + '|' + norm(u), k2 = 'nom|' + norm(u);
  need(!tooMany(k1) && !tooMany(k2, 15, 15 * 60 * 1000), 429, 'Trop de tentatives. Réessayez dans quelques minutes.');
  const cands = findAccounts(u, body.phone).filter(a => a.cred);
  const ok = [];
  let disabled = false;
  for (const a of cands) if (verifyCred(a.cred, pw)) { if (a.active) ok.push(a); else disabled = true; }
  if (ok.length > 1) throw new HttpError(409, 'Plusieurs comptes portent ce nom : ajoutez votre numéro de téléphone');
  if (!ok.length) {
    if (disabled) throw new HttpError(403, 'Compte désactivé');
    noteFail(k1); noteFail(k2, 15 * 60 * 1000); throw new HttpError(401, 'Identifiants incorrects');
  }
  const matched = ok[0];
  attempts.delete(k1);
  if (matched.cred.scheme !== 'scrypt') matched.cred = hashPw(pw);   // montée en gamme du hachage
  const token = newSession(matched);
  persist();
  maybeBackup();
  return { token, expiresIn: SESSION_TTL, user: publicUser(matched) };
}

/* État d'un compte avant connexion : « pending » = première connexion (aucun code choisi). Ne révèle rien sur un nom inconnu. */
function authStatus(body) {
  need(isObj(body), 400, 'Requête invalide');
  const c = findAccounts(body.username, body.phone).filter(a => a.active);
  if (!c.length && FIRST_LOGIN_PHONE && !phoneKey(body.phone)) {
    const nophone = findAccounts(body.username, '').filter(a => a.active && !a.cred && !a.phoneKey);
    if (nophone.length === 1) return { status: 'pending', displayName: nophone[0].name, requiresPhone: true, noPhoneOnRecord: true };
  }
  if (!c.length) return { status: 'active' };
  if (c.length > 1) return { status: 'ambiguous' };
  const a = c[0];
  if (a.role === 'admin' || a.cred) return { status: 'active' };
  return { status: 'pending', displayName: a.name, requiresPhone: FIRST_LOGIN_PHONE };
}

function setupPin(body, ip) {
  need(isObj(body), 400, 'Requête invalide');
  const u = String(body.username || '').trim(), pin = String(body.pin || ''), phone = String(body.phone || '');
  need(u, 400, 'Nom requis');
  need(/^\d{4}$/.test(pin), 400, 'Le code doit comporter exactement 4 chiffres');
  need(!weakPin(pin), 400, 'Code trop simple : évitez 1234, 0000, 1111…');
  if (FIRST_LOGIN_PHONE) need(phoneKey(phone), 400, 'Numéro de téléphone requis pour la première connexion');
  const lk = ip + '|setup|' + norm(u);
  need(!tooMany(lk), 429, 'Trop de tentatives. Réessayez dans quelques minutes.');
  const c = findAccounts(u, FIRST_LOGIN_PHONE ? phone : '').filter(a => a.active && !a.cred);
  if (!c.length) { noteFail(lk); throw new HttpError(404, 'Aucun compte à activer pour ces informations. Vérifiez votre nom et votre numéro, ou contactez l’administration.'); }
  if (c.length > 1) throw new HttpError(409, 'Plusieurs comptes portent ce nom : contactez l’administration');
  const a = c[0];
  a.cred = hashPw(pin); a.pending = false;
  attempts.delete(lk);
  const token = newSession(a);
  persist();
  return { token, expiresIn: SESSION_TTL, user: publicUser(a) };
}

function sync(acc, body) {
  need(isObj(body) && isObj(body.state), 400, 'État manquant');
  const ctx = ctxFor(acc), posted = body.state, base = Number(body.baseRevision || 0);
  const rev = db.revision + 1;
  const prev = { messages: new Set((db.state.messages || []).map(m => String(m.id))), annonces: new Set((db.state.annonces || []).map(m => String(m.id))), absences: new Set((db.state.absences || []).map(m => String(m.id))), profile: new Map((db.state.profileRequests || []).map(r => [String(r.id), r.status])) };
  let changed = false, serverWins = false;
  if (acc.role === 'admin') {
    const seed = db.revision === 0;
    const pull = !seed && (base === 0 || base < db.adminRevision);
    if (pull) serverWins = true;
    else {
      let adminChanged = false;
      ARRAY_ADMIN.forEach(k => { if (Array.isArray(posted[k]) && posted[k].length <= MAX_RECORDS && JSON.stringify(posted[k]) !== JSON.stringify(db.state[k] || [])) { db.state[k] = posted[k]; adminChanged = true; } });
      OBJECT_ADMIN.forEach(k => { if (isObj(posted[k]) && JSON.stringify(posted[k]) !== JSON.stringify(db.state[k] || {})) { db.state[k] = posted[k]; adminChanged = true; } });
      if (adminChanged) { db.adminRevision = rev; changed = true; autoProvision(); }
      else if (seed) autoProvision();
    }
  }
  const allowDelete = acc.role === 'admin' && !serverWins;
  SHARED.forEach(k => { if (Array.isArray(posted[k]) && mergeShared(k, posted[k], ctx, base, allowDelete, rev)) changed = true; });
  if (changed) {
    db.revision = rev;
    schedulePush({ messages: (db.state.messages || []).filter(m => !prev.messages.has(String(m.id))), annonces: (db.state.annonces || []).filter(m => !prev.annonces.has(String(m.id))), absences: (db.state.absences || []).filter(m => !prev.absences.has(String(m.id))),
      profileNew: (db.state.profileRequests || []).filter(r => !prev.profile.has(String(r.id))),
      profileDecided: (db.state.profileRequests || []).filter(r => prev.profile.has(String(r.id)) && prev.profile.get(String(r.id)) === 'pending' && r.status !== 'pending') });
  }
  persist();
  maybeBackup();
  const res = { revision: db.revision, serverTime: new Date().toISOString(), state: viewFor(ctxFor(acc)) };
  if (serverWins) { res.serverWins = true; res.notice = "Un autre appareil administrateur avait modifié les données : la version du serveur a été récupérée."; }
  return res;
}

function publishMessage(acc, body) {
  need(isObj(body) && isObj(body.message) && body.message.id != null, 400, 'Message invalide');
  const ctx = ctxFor(acc), rev = db.revision + 1;
  const arr = db.state.messages || (db.state.messages = []);
  const old = arr.find(m => String(m.id) === String(body.message.id));
  const raw = Object.assign({}, body.message); delete raw._rev;
  const res = authorize('messages', old, raw, ctx);
  need(res, 403, 'Envoi non autorisé');
  if (!old) { res.sentAt = res.sentAt || new Date().toISOString(); res.deliveryStatus = 'sent'; res._rev = rev; arr.push(res); db.revision = rev; schedulePush({ messages: [res] }); }
  else if (!same(old, res)) { Object.assign(old, res, { _rev: rev }); db.revision = rev; }
  persist();
  const stored = old || res;
  return { status: stored.deliveryStatus || 'sent', message: stored };
}

function markRead(acc, id, body) {
  const ctx = ctxFor(acc), m = (db.state.messages || []).find(x => String(x.id) === String(id));
  need(m && visibleMsg(m, ctx), 404, 'Message introuvable');
  const when = (isObj(body) && body.readAt) || new Date().toISOString();
  const key = acc.role === 'admin' ? 'admin' : acc.role + ':' + acc.refId;
  m.readBy = Object.assign({}, m.readBy || {}, { [key]: when });
  const direct = !m.group && !m.groupId;
  let toMe;
  if (acc.role === 'admin') toMe = m.to === 'Administration' || m.recipientRole === 'admin';
  else if (acc.role === 'parent') toMe = m.senderRole !== 'parent' && !(ctx.me && m.from === ctx.me.name);
  else toMe = !!(ctx.me && (m.to === ctx.me.name || (m.recipientRole === acc.role && String(m.recipientId) === String(ctx.ref))));
  if (direct && toMe) { m.read = true; m.readAt = m.readAt || when; m.deliveryStatus = 'read'; }
  m._rev = db.revision = db.revision + 1;
  persist();
  return { status: m.read ? 'read' : 'delivered', message: m };
}

function syncNotifications(acc, body) {
  need(isObj(body) && Array.isArray(body.notifications), 400, 'Notifications invalides');
  const list = db.notifs[acc.id] || (db.notifs[acc.id] = []);
  const map = new Map(list.map(n => [String(n.id), n]));
  for (const n of body.notifications.slice(-300)) {
    if (!isObj(n) || n.id == null) continue;
    const k = String(n.id), o = map.get(k);
    if (!o) map.set(k, n);
    else map.set(k, Object.assign({}, o, n, { read: !!(o.read || n.read), readAt: o.readAt || n.readAt || null }));
  }
  db.notifs[acc.id] = [...map.values()].sort((a, b) => (a.id || 0) - (b.id || 0)).slice(-150);
  persist();
  return { notifications: db.notifs[acc.id], serverTime: new Date().toISOString() };
}

function changePassword(acc, body) {
  need(isObj(body), 400, 'Requête invalide');
  const cur = String(body.currentPassword || ''), next = String(body.newPassword || '');
  if (acc.role === 'admin') need(next.length >= 6 && next !== '1234', 400, 'Nouveau mot de passe trop faible (6 caractères minimum)');
  else need(/^\d{4}$/.test(next) && !weakPin(next), 400, 'Le code doit comporter 4 chiffres (évitez 1234, 0000, 1111…)');
  need(verifyCred(acc.cred, cur), 403, 'Mot de passe actuel incorrect');
  acc.cred = hashPw(next);
  persist();
  return { ok: true };
}

function resetAccess(acc, body) {
  need(acc.role === 'admin', 403, 'Accès administrateur requis');
  need(isObj(body) && ['teacher', 'parent', 'supervisor', 'staff'].includes(body.kind), 400, 'Type de compte invalide');
  const a = db.accounts[body.kind + ':' + body.id];
  need(a, 404, 'Compte introuvable : synchronisez d’abord');
  a.cred = null; a.pending = true;
  for (const [h, s] of Object.entries(db.sessions)) if (s.acc === a.id) delete db.sessions[h];
  persist();
  return { ok: true };
}

/* ---------- notifications push ---------- */
const subsOf = id => (db.push && db.push[id]) || [];
function addressed(a, m) {
  if (m.senderRole === a.role && idIs(m.senderId, a.role, a.refId)) return false;
  if (a.role === 'admin') return m.senderRole !== 'admin' && (m.recipientRole === 'admin' || m.to === 'Administration');
  if ((a.names || []).some(n => n && n === m.from)) return false;
  return visibleMsg(m, ctxFor(a));
}
function absenceFor(a, x) {
  const ctx = ctxFor(a), p = ctx.me;
  if (!p || !inClasses(ctx, x.className)) return false;
  const kids = (p.children || []).map(c => norm(typeof c === 'object' ? c.name : c)).concat(norm(p.student));
  return kids.includes(norm(x.student));
}
async function pushToAccount(a, payload) {
  let sent = 0, failed = 0;
  for (const sub of subsOf(a.id).slice()) {
    try {
      const r = await push.send(sub, payload, db.vapid, { subject: VAPID_SUBJECT });
      if (r.status >= 200 && r.status < 300) sent++;
      else { failed++; if (r.status === 404 || r.status === 410) db.push[a.id] = subsOf(a.id).filter(x => x.endpoint !== sub.endpoint); }
    } catch (e) { failed++; }
  }
  if (failed) persist();
  return { sent, failed };
}
async function notifyFresh(fresh) {
  if (!PUSH_ON || !db.vapid) return;
  const accs = Object.values(db.accounts).filter(a => a.active && subsOf(a.id).length);
  for (const a of accs) {
    const msgs = (fresh.messages || []).filter(m => addressed(a, m));
    if (msgs.length) await pushToAccount(a, { title: 'Nouveau message', body: msgs.length === 1 ? 'De ' + (msgs[0].from || 'l’établissement') : msgs.length + ' nouveaux messages', tag: 'pp-msg', page: 'messages' });
    const anAll = (fresh.annonces || []).filter(x => !(x.byAcc && x.byAcc === a.id));
    if (a.role !== 'admin' && anAll.length) { const an = anAll; await pushToAccount(a, { title: 'Nouvelle annonce', body: an.length === 1 ? String(an[0].title || 'Annonce de l’établissement').slice(0, 90) : an.length + ' nouvelles annonces', tag: 'pp-annonce', page: 'annonces' }); }
    if (a.role === 'admin' && (fresh.profileNew || []).length) await pushToAccount(a, { title: 'Demande de profil', body: (fresh.profileNew[0].parentName || 'Un parent') + ' demande une modification', tag: 'pp-profil', page: 'parents' });
    if (a.role === 'parent') for (const r of (fresh.profileDecided || [])) if (String(r.parentId) === String(a.refId)) await pushToAccount(a, { title: 'Demande de profil', body: r.status === 'approved' ? 'Votre demande a été acceptée.' : 'Votre demande a été refusée.', tag: 'pp-profil', page: 'profil' });
    if (a.role === 'parent' && (fresh.absences || []).some(x => absenceFor(a, x))) await pushToAccount(a, { title: 'Absence signalée', body: 'Une absence a été enregistrée pour votre enfant.', tag: 'pp-absence', page: 'suivi' });
  }
}
function schedulePush(fresh) {
  if (!PUSH_ON || !((fresh.messages || []).length || (fresh.annonces || []).length || (fresh.absences || []).length || (fresh.profileNew || []).length || (fresh.profileDecided || []).length)) return;
  setImmediate(() => notifyFresh(fresh).catch(e => console.error('[push]', e.message)));
}
function subscribePush(acc, body) {
  need(isObj(body) && isObj(body.subscription), 400, 'Abonnement manquant');
  const sub = body.subscription, ep = String(sub.endpoint || ''), keys = isObj(sub.keys) ? sub.keys : {};
  need(push.endpointAllowed(ep, PUSH_ALLOW_ANY), 400, 'Service de notification non pris en charge');
  const k = push.unb64u(keys.p256dh || ''), au = push.unb64u(keys.auth || '');
  need(k.length === 65 && k[0] === 4 && au.length === 16, 400, 'Clés de notification invalides');
  for (const id of Object.keys(db.push)) db.push[id] = db.push[id].filter(x => x.endpoint !== ep);
  const list = db.push[acc.id] || (db.push[acc.id] = []);
  list.push({ endpoint: ep, keys: { p256dh: keys.p256dh, auth: keys.auth }, createdAt: Date.now(), ua: String(body.ua || '').slice(0, 80) });
  while (list.length > 5) list.shift();
  persist();
  return { ok: true, devices: list.length, enabled: PUSH_ON };
}
function unsubscribePush(acc, body) {
  const ep = isObj(body) ? String(body.endpoint || '') : '';
  db.push[acc.id] = subsOf(acc.id).filter(x => x.endpoint !== ep);
  persist();
  return { ok: true };
}

/* ---------- sauvegardes automatiques ---------- */
let backupBusy = false;
async function createBackup(kind) {
  const snap = { app: SERVICE, version: VERSION, createdAt: new Date().toISOString(), revision: db.revision, state: db.state };
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(snap)));
  const meta = {
    id: snap.createdAt.replace(/\D/g, '').slice(0, 14) + '-' + crypto.randomBytes(2).toString('hex'), kind, createdAt: snap.createdAt, size: buf.length, revision: db.revision,
    counts: { parents: (db.state.parents || []).length, teachers: (db.state.teachers || []).length, messages: (db.state.messages || []).length, bulletins: (db.state.bulletins || []).length }
  };
  await store.putBackup(meta, buf);
  await store.pruneBackups(BACKUP_KEEP);
  db.lastBackupAt = Date.now();
  persist();
  return meta;
}
async function maybeBackup() {
  if (backupBusy || !db || db.revision === 0 || Date.now() - (db.lastBackupAt || 0) < BACKUP_EVERY) return;
  backupBusy = true;
  try { await createBackup('automatique'); } catch (e) { console.error('[sauvegarde]', e.message); } finally { backupBusy = false; }
}
async function restoreBackup(id) {
  const buf = await store.getBackup(id);
  need(buf, 404, 'Sauvegarde introuvable');
  let snap;
  try { snap = JSON.parse(zlib.gunzipSync(buf).toString('utf8')); } catch (e) { throw new HttpError(400, 'Sauvegarde illisible'); }
  need(isObj(snap) && isObj(snap.state), 400, 'Sauvegarde invalide');
  await createBackup('avant-restauration');
  db.state = snap.state;
  autoProvision();
  const rev = db.revision + 1;
  db.revision = rev; db.adminRevision = rev;
  persist();
  return { ok: true, revision: rev };
}

/* ---------- fichiers (bulletins PDF) ---------- */
function canReadFile(acc, id) {
  const b = (db.state.bulletins || []).find(x => x.fileId === id);
  if (!b) return false;
  if (acc.role === 'admin') return true;
  if (acc.role === 'teacher') return String(b.principalTeacherId) === String(acc.refId);
  if (acc.role === 'supervisor') return capsOf(acc).bulletins && b.kind === 'class';
  if (acc.role === 'parent') {
    return b.stage === 'sentToParents' && b.requestId != null &&
      (db.state.bulletinRequests || []).some(r => String(r.id) === String(b.requestId) && String(r.parentId) === String(acc.refId));
  }
  return false;
}
async function uploadFile(acc, body) {
  need(acc.role === 'admin' || (acc.role === 'supervisor' && capsOf(acc).bulletins), 403, 'Accès non autorisé');
  need(isObj(body) && typeof body.data === 'string' && body.data.length > 0, 400, 'Fichier manquant');
  const b64 = body.data.replace(/^data:[^,]*,/, '');
  const buf = Buffer.from(b64, 'base64');
  need(buf.length > 0 && buf.length <= MAX_FILE, 413, 'Fichier trop volumineux (maximum ' + Math.round(MAX_FILE / 1048576) + ' Mo)');
  need(buf.slice(0, 5).toString('latin1') === '%PDF-', 400, 'Le fichier doit être un PDF');
  const id = crypto.randomBytes(12).toString('hex');
  await store.putFile(id, buf);
  db.files[id] = { name: String(body.name || 'bulletin.pdf').slice(0, 120), size: buf.length, createdAt: Date.now(), kind: 'bulletin', owner: acc.id };
  persist();
  return { id, size: buf.length, name: db.files[id].name };
}
function sniffType(buf, name) {
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 3 && buf[3] === 4 && /\.docx$/i.test(String(name || ''))) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return null;
}
async function uploadAttachment(acc, body) {
  need(isObj(body) && typeof body.data === 'string' && body.data.length > 0, 400, 'Fichier manquant');
  const buf = Buffer.from(body.data.replace(/^data:[^,]*,/, ''), 'base64');
  need(buf.length > 0 && buf.length <= MAX_ATTACH, 413, 'Fichier trop volumineux (maximum ' + Math.round(MAX_ATTACH / 1048576) + ' Mo)');
  const mime = sniffType(buf, body.name);
  need(mime, 400, 'Format non accepté (PDF, JPG, PNG, WEBP ou DOCX)');
  const recent = Object.values(db.files).filter(f => f.owner === acc.id && f.kind === 'attach' && Date.now() - f.createdAt < 24 * 3600 * 1000).length;
  need(recent < 80, 429, 'Trop de fichiers envoyés aujourd’hui');
  const id = crypto.randomBytes(12).toString('hex');
  await store.putFile(id, buf);
  db.files[id] = { name: String(body.name || 'fichier').slice(0, 120), size: buf.length, mime, owner: acc.id, createdAt: Date.now(), kind: 'attach' };
  persist();
  return { id, size: buf.length, name: db.files[id].name, mime };
}
function canReadAttachment(acc, id) {
  const f = db.files[id];
  if (!f || f.kind !== 'attach') return false;
  if (acc.role === 'admin' || f.owner === acc.id) return true;
  const ctx = ctxFor(acc);
  if ((db.state.messages || []).some(m => m.attach && m.attach.fileId === id && visibleMsg(m, ctx))) return true;
  return (db.state.absences || []).some(a => a.justification && a.justification.attach && a.justification.attach.fileId === id &&
    (acc.role === 'parent' ? absenceFor(acc, a) : acc.role === 'supervisor' ? !!capsOf(acc).vie : acc.role === 'teacher' ? inClasses(ctx, a.className) : false));
}
async function gcFiles() {
  const used = new Set((db.state.bulletins || []).map(b => b.fileId).filter(Boolean));
  (db.state.messages || []).forEach(m => { if (m.attach && m.attach.fileId) used.add(m.attach.fileId); });
  (db.state.absences || []).forEach(a => { if (a.justification && a.justification.attach && a.justification.attach.fileId) used.add(a.justification.attach.fileId); });
  for (const [id, f] of Object.entries(db.files)) if (!used.has(id) && Date.now() - f.createdAt > 14 * 24 * 3600 * 1000) { delete db.files[id]; await store.delFile(id); }
}

async function route(req, res, url, body, ip) {
  const p = url.pathname, m = req.method;
  if (p === '/api/health' && m === 'GET') return { ok: true, service: SERVICE, version: VERSION, time: new Date().toISOString(), revision: db.revision };
  if (p === '/api/auth/login' && m === 'POST') return login(body, ip);
  if (p === '/api/auth/status' && m === 'POST') return authStatus(body);
  if (p === '/api/auth/setup' && m === 'POST') return setupPin(body, ip);
  if (p === '/api/push/key' && m === 'GET') return { publicKey: db.vapid ? db.vapid.publicKey : null, enabled: PUSH_ON && !!db.vapid };
  const acc = authenticate(req);
  need(acc, 401, 'Session expirée ou invalide');
  if (p === '/api/auth/logout' && m === 'POST') { const h = sha256(/^Bearer (.+)$/.exec(req.headers.authorization)[1]); delete db.sessions[h]; persist(); return { ok: true }; }
  if (p === '/api/auth/password' && m === 'POST') return changePassword(acc, body);
  if (p === '/api/push/subscribe' && m === 'POST') return subscribePush(acc, body);
  if (p === '/api/push/unsubscribe' && m === 'POST') return unsubscribePush(acc, body);
  if (p === '/api/push/test' && m === 'POST') { const r = await pushToAccount(acc, { title: 'Notifications activées ✓', body: 'Vous recevrez ici les nouveaux messages et annonces.', tag: 'pp-test', page: 'home' }); return Object.assign({ devices: subsOf(acc.id).length }, r); }
  if (p === '/api/admin/push' && m === 'GET') {
    need(acc.role === 'admin', 403, 'Accès administrateur requis');
    const by = {}; let n = 0;
    for (const [id, l] of Object.entries(db.push)) { const a = db.accounts[id]; if (a && l.length) { by[a.role] = (by[a.role] || 0) + l.length; n += l.length; } }
    return { enabled: PUSH_ON, devices: n, byRole: by };
  }
  if (p === '/api/admin/backups' && m === 'GET') {
    need(acc.role === 'admin', 403, 'Accès administrateur requis');
    return { backups: await store.listBackups(), lastBackupAt: db.lastBackupAt || 0, everyHours: Math.round(BACKUP_EVERY / 360000) / 10, keep: BACKUP_KEEP };
  }
  if (p === '/api/admin/backups' && m === 'POST') { need(acc.role === 'admin', 403, 'Accès administrateur requis'); return { backup: await createBackup('manuelle') }; }
  const bm = /^\/api\/admin\/backups\/([0-9a-z-]{10,40})(\/restore)?$/.exec(p);
  if (bm) {
    need(acc.role === 'admin', 403, 'Accès administrateur requis');
    if (m === 'POST' && bm[2]) return restoreBackup(bm[1]);
    if (m === 'GET' && !bm[2]) {
      const buf = await store.getBackup(bm[1]); need(buf, 404, 'Sauvegarde introuvable');
      return { _binary: zlib.gunzipSync(buf), _name: 'sauvegarde-portail-' + bm[1] + '.json', _type: 'application/json; charset=utf-8' };
    }
  }
  if (p === '/api/attachments' && m === 'POST') return uploadAttachment(acc, body);
  const am = /^\/api\/attachments\/([0-9a-f]{24})$/.exec(p);
  if (am && m === 'GET') {
    need(canReadAttachment(acc, am[1]), 404, 'Fichier introuvable');
    const buf = await store.getFile(am[1]); need(buf, 404, 'Fichier introuvable');
    return { _binary: buf, _name: db.files[am[1]].name, _type: db.files[am[1]].mime };
  }
  if (p === '/api/files' && m === 'POST') return uploadFile(acc, body);
  let fm = /^\/api\/files\/([0-9a-f]{24})$/.exec(p);
  if (fm && m === 'GET') {
    need(canReadFile(acc, fm[1]), 404, 'Fichier introuvable');
    const buf = await store.getFile(fm[1]); need(buf, 404, 'Fichier introuvable');
    return { _binary: buf, _name: (db.files[fm[1]] || {}).name || 'bulletin.pdf' };
  }
  if (p === '/api/sync' && m === 'POST') { const out = sync(acc, body); if (acc.role === 'admin') gcFiles().catch(() => {}); return out; }
  if (p === '/api/messages' && m === 'POST') return publishMessage(acc, body);
  let mm = /^\/api\/messages\/([^/]+)\/read$/.exec(p);
  if (mm && m === 'POST') return markRead(acc, decodeURIComponent(mm[1]), body);
  if (p === '/api/notifications/sync' && m === 'POST') return syncNotifications(acc, body);
  if (p === '/api/admin/users/reset' && m === 'POST') return resetAccess(acc, body);
  if (p === '/api/admin/users/provision' && m === 'POST') {
    need(acc.role === 'admin', 403, 'Accès administrateur requis');
    need(isObj(body) && ['teacher', 'parent', 'supervisor', 'staff'].includes(body.kind), 400, 'Type de compte invalide');
    const st = db.state;
    const rec = body.kind === 'supervisor' ? (isObj(st.supervisor) ? st.supervisor : null) : (st[body.kind === 'staff' ? 'staff' : body.kind + 's'] || []).find(x => String(x.id) === String(body.id));
    need(rec, 404, 'Compte introuvable dans les données du serveur : synchronisez d\'abord');
    const r = provision(body.kind, rec); persist();
    return { created: r.created, account: publicUser(r.account) };
  }
  throw new HttpError(404, 'Route inconnue');
}

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
function cors(req, res) {
  const o = req.headers.origin;
  if (o && (ORIGINS.includes('*') || ORIGINS.includes(o))) { res.setHeader('Access-Control-Allow-Origin', ORIGINS.includes('*') ? '*' : o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function send(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, 'Données trop volumineuses')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new HttpError(400, 'JSON invalide')); }
    });
    req.on('error', reject);
  });
}
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname); if (rel === '/') rel = '/index.html';
  if (rel === '/.well-known/assetlinks.json') {          // vérification de l'APK (Trusted Web Activity)
    let body = process.env.ASSETLINKS_JSON || '';
    if (!body) for (const f of [path.join(__dirname, 'assetlinks.json'), path.join(PUBLIC_DIR, 'assetlinks.json')]) { if (fs.existsSync(f)) { body = fs.readFileSync(f, 'utf8'); break; } }
    if (!body) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(body);
  }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  const forbidden = !HAS_PUBLIC && (path.dirname(file) !== __dirname || !ROOT_ALLOWED.has(path.basename(file)));
  if (forbidden || !file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const idx = path.join(PUBLIC_DIR, 'index.html');
    if (req.method === 'GET' && !path.extname(rel) && fs.existsSync(idx)) return sendFile(res, idx);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Introuvable');
  }
  sendFile(res, file);
}
function sendFile(res, file) {
  const ext = path.extname(file).toLowerCase(), base = path.basename(file);
  const noCache = base === 'index.html' || base === 'sw.js' || base === 'manifest.json';
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': noCache ? 'no-cache' : 'public, max-age=86400' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin');
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  const url = new URL(req.url, 'http://x');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, url);
    }
    cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const body = req.method === 'POST' ? await readBody(req) : null;
    const out = await route(req, res, url, body, ip);
    if (out && out._binary) {
      res.writeHead(200, { 'Content-Type': out._type || 'application/pdf', 'Content-Length': out._binary.length, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'attachment; filename="' + String(out._name).replace(/[^\w.\- ]/g, '_') + '"' });
      return res.end(out._binary);
    }
    send(res, 200, out);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error('[erreur]', e);
    if (!res.headersSent) { cors(req, res); send(res, status, { error: status === 500 ? 'Erreur interne du serveur' : e.message }); }
  }
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/health') console.log(req.method, url.pathname, res.statusCode, (Date.now() - t0) + 'ms');
});

async function start() {
  db = (await store.load()) || freshDb();
  ['accounts', 'sessions', 'notifs', 'state', 'files'].forEach(k => { if (!db[k]) db[k] = {}; });
  db.revision = db.revision || 0; db.adminRevision = db.adminRevision || 0;
  if (!db.push) db.push = {};
  if (!db.vapid) db.vapid = push.generateVapid();      // clés conservées dans la base : ne jamais les changer (les abonnements en dépendent)
  db.lastBackupAt = db.lastBackupAt || 0;
  ensureAdmin();
  migrateAccounts();
  persist();
  setTimeout(maybeBackup, 5000);
  setInterval(maybeBackup, 30 * 60 * 1000).unref();
  server.listen(PORT, () => console.log(`${SERVICE} ${VERSION} — port ${PORT} — stockage : ${store.kind} — révision ${db.revision}`));
}
async function stop() { console.log('Arrêt : sauvegarde des données…'); server.close(); try { await store.flush(); } catch (e) {} process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
if (require.main === module) start().catch(e => { console.error('Démarrage impossible :', e.message); process.exit(1); });
module.exports = { start, server, _db: () => db };
