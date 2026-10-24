'use strict';
/* Portail Parents — serveur central (CST Manjo). Aucune dépendance obligatoire (pg seulement avec DATABASE_URL). */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createStore } = require('./store');

const VERSION = '1.0.0';
const SERVICE = 'portail-parents-server';
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = (Number(process.env.MAX_BODY_MB) || 30) * 1024 * 1024;
const SESSION_TTL = 12 * 3600;                        // secondes (le client attend 43200)
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ---------- jeux de clés synchronisées ---------- */
const ARRAY_ADMIN = ['teachers', 'parents', 'classes', 'subjects', 'sequences', 'templates', 'events', 'annonces', 'students'];
const OBJECT_ADMIN = ['classPrincipals', 'supervisor', 'profiles', 'smsSettings', 'whatsappSettings'];
const SHARED = ['messages', 'bulletins', 'bulletinRequests', 'bulletinHistory', 'grades', 'absences'];
const MAX_RECORDS = 60000;

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
function freshDb() { return { revision: 0, adminRevision: 0, state: {}, accounts: {}, sessions: {}, notifs: {}, createdAt: new Date().toISOString() }; }
const persist = () => store.save(db);

/* ---------- comptes ---------- */
function usernamesFor(kind, rec) {
  const u = new Set();
  const add = v => { const n = norm(v); if (n) u.add(n); };
  if (kind === 'teacher') { add(rec.name); add(rec.email); }
  if (kind === 'parent') add(rec.name);
  if (kind === 'supervisor') { add(rec.username || 'surveillant'); add(rec.name); u.add('surveillant'); }
  const pk = phoneKey(rec.phone); if (pk) u.add('tel:' + pk);
  return [...u];
}
function credFromRecord(kind, rec) {
  const pw = rec.password;
  if (pw && /^[0-9a-f]{64}$/i.test(pw)) return { scheme: 'cst-sha256', hash: pw.toLowerCase() };
  if (pw && kind === 'parent' && phoneKey(pw) && phoneKey(pw) === phoneKey(rec.phone)) return { scheme: 'phone', hash: phoneKey(pw) };
  if (pw) return { scheme: 'plain', hash: String(pw) };
  if (kind === 'parent' && phoneKey(rec.phone)) return { scheme: 'phone', hash: phoneKey(rec.phone) };
  return null;
}
function provision(kind, rec) {
  if (!rec || rec.id == null) return null;
  const id = kind + ':' + rec.id;
  let acc = db.accounts[id], created = false;
  if (!acc) { acc = db.accounts[id] = { id, role: kind, refId: rec.id, cred: null, srcHash: null }; created = true; }
  acc.name = rec.name || acc.name || kind;
  acc.usernames = usernamesFor(kind, rec);
  acc.active = rec.active !== false;
  const src = rec.password || ('phone:' + phoneKey(rec.phone));
  if (created || acc.srcHash !== src) {
    const c = credFromRecord(kind, rec);
    if (c) { acc.cred = c; acc.srcHash = src; }
  }
  return { created, account: acc };
}
function autoProvision() {
  const st = db.state, keep = new Set(['admin']);
  (st.teachers || []).forEach(t => { const r = provision('teacher', t); if (r) keep.add(r.account.id); });
  (st.parents || []).forEach(p => { const r = provision('parent', p); if (r) keep.add(r.account.id); });
  if (isObj(st.supervisor) && st.supervisor.id != null) { const r = provision('supervisor', st.supervisor); if (r) keep.add(r.account.id); }
  for (const id of Object.keys(db.accounts)) if (!keep.has(id)) { delete db.accounts[id]; delete db.notifs[id]; }
  for (const [h, s] of Object.entries(db.sessions)) if (!db.accounts[s.acc]) delete db.sessions[h];
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
function tooMany(key) { const a = attempts.get(key); return a && a.n >= 8 && Date.now() - a.t < 10 * 60 * 1000; }
function noteFail(key) { const a = attempts.get(key); if (!a || Date.now() - a.t > 10 * 60 * 1000) attempts.set(key, { n: 1, t: Date.now() }); else a.n++; }
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
  return { id: acc.role === 'admin' ? 'admin' : acc.refId, role: acc.role, username: (acc.usernames || []).find(u => !u.startsWith('tel:')) || acc.id, name: acc.name };
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
  } else if (acc.role === 'supervisor') ctx.me = isObj(st.supervisor) ? st.supervisor : null;
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
      (m.recipientRole === 'teacher' && String(m.recipientId) === String(me.id)) ||
      (m.senderRole === 'teacher' && String(m.senderId) === String(me.id));
  }
  if (ctx.role === 'supervisor') {
    return m.recipientRole === 'supervisor' || m.senderRole === 'supervisor' || (me && (m.to === me.name || m.from === me.name)) || m.group === 'ALL';
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

/* Renvoie l'enregistrement fusionné, ou null si l'écriture n'est pas autorisée. */
function authorize(key, old, raw, ctx) {
  const role = ctx.role, ref = ctx.ref;
  if (role === 'admin') return mergeRecord(key, old, raw);
  switch (key) {
    case 'messages': {
      if (old) { if (!visibleMsg(old, ctx)) return null; return mergeRecord(key, old, pick(raw, MUT_MSG)); }
      if (raw.senderRole && (raw.senderRole !== role || String(raw.senderId) !== String(ref))) return null;
      if (role === 'parent' && (raw.group || raw.groupId)) return null;
      if (role === 'teacher' && raw.group && (raw.group === 'ALL' || !inClasses(ctx, raw.group))) return null;
      if (role === 'teacher' && raw.parentId != null && !(db.state.parents || []).some(p => String(p.id) === String(raw.parentId))) return null;
      if (!visibleMsg(raw, ctx)) return null;
      return Object.assign({}, raw);
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
      if (role === 'teacher' && old && String(old.principalTeacherId) === String(ref)) return mergeRecord(key, old, pick(raw, ['stage', 'forwardedAt', 'forwardedBy']));
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
      if (role === 'parent') { if (old && inClasses(ctx, old.className)) return mergeRecord(key, old, pick(raw, ['justification', 'status'])); return null; }
      if (role === 'supervisor') return mergeRecord(key, old, raw);
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
    out.bulletins = A('bulletins').filter(b => b.stage === 'sentToParents' && inClasses(ctx, b.className) && (b.requestId == null || reqIds.has(String(b.requestId))));
    out.bulletinHistory = A('bulletinHistory').filter(h => String(h.parentId) === String(ctx.ref));
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
    out.supervisor = ctx.me ? noPw(ctx.me) : {};
    out.teachers = A('teachers').map(teacherPub);
    out.parents = A('parents').map(noPw);
    out.students = A('students');
    out.absences = A('absences');
    out.grades = A('grades');
    out.bulletinRequests = []; out.bulletins = []; out.bulletinHistory = [];
  }
  return out;
}

/* ---------- gestion des routes ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const need = (c, status, msg) => { if (!c) throw new HttpError(status, msg); };

function login(body, ip) {
  need(isObj(body), 400, 'Requête invalide');
  const u = String(body.username || '').trim(), pw = String(body.password || '');
  need(u && pw, 400, 'Identifiant et mot de passe requis');
  const limitKey = ip + '|' + norm(u);
  need(!tooMany(limitKey), 429, 'Trop de tentatives. Réessayez dans 10 minutes.');
  const keys = [norm(u)];
  if (phoneKey(u)) keys.push('tel:' + phoneKey(u));
  const cands = Object.values(db.accounts).filter(a => a.usernames.some(x => keys.includes(x)));
  let matched = null, disabled = false;
  for (const a of cands) {
    if (verifyCred(a.cred, pw)) { if (a.active) { matched = a; break; } disabled = true; }
  }
  if (!matched) {
    if (disabled) throw new HttpError(403, 'Compte désactivé');
    noteFail(limitKey); throw new HttpError(401, 'Identifiants incorrects');
  }
  attempts.delete(limitKey);
  if (matched.cred.scheme !== 'scrypt') matched.cred = hashPw(pw);   // montée en gamme du hachage
  const token = newSession(matched);
  persist();
  return { token, expiresIn: SESSION_TTL, user: publicUser(matched) };
}

function sync(acc, body) {
  need(isObj(body) && isObj(body.state), 400, 'État manquant');
  const ctx = ctxFor(acc), posted = body.state, base = Number(body.baseRevision || 0);
  const rev = db.revision + 1;
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
  if (changed) db.revision = rev;
  persist();
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
  if (!old) { res.sentAt = res.sentAt || new Date().toISOString(); res.deliveryStatus = 'sent'; res._rev = rev; arr.push(res); db.revision = rev; }
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
  need(next.length >= 6 && next !== '1234', 400, 'Nouveau mot de passe trop faible (6 caractères minimum)');
  need(verifyCred(acc.cred, cur), 403, 'Mot de passe actuel incorrect');
  acc.cred = hashPw(next);
  persist();
  return { ok: true };
}

async function route(req, res, url, body, ip) {
  const p = url.pathname, m = req.method;
  if (p === '/api/health' && m === 'GET') return { ok: true, service: SERVICE, version: VERSION, time: new Date().toISOString(), revision: db.revision };
  if (p === '/api/auth/login' && m === 'POST') return login(body, ip);
  const acc = authenticate(req);
  need(acc, 401, 'Session expirée ou invalide');
  if (p === '/api/auth/logout' && m === 'POST') { const h = sha256(/^Bearer (.+)$/.exec(req.headers.authorization)[1]); delete db.sessions[h]; persist(); return { ok: true }; }
  if (p === '/api/auth/password' && m === 'POST') return changePassword(acc, body);
  if (p === '/api/sync' && m === 'POST') return sync(acc, body);
  if (p === '/api/messages' && m === 'POST') return publishMessage(acc, body);
  let mm = /^\/api\/messages\/([^/]+)\/read$/.exec(p);
  if (mm && m === 'POST') return markRead(acc, decodeURIComponent(mm[1]), body);
  if (p === '/api/notifications/sync' && m === 'POST') return syncNotifications(acc, body);
  if (p === '/api/admin/users/provision' && m === 'POST') {
    need(acc.role === 'admin', 403, 'Accès administrateur requis');
    need(isObj(body) && ['teacher', 'parent', 'supervisor'].includes(body.kind), 400, 'Type de compte invalide');
    const st = db.state;
    const rec = body.kind === 'supervisor' ? (isObj(st.supervisor) ? st.supervisor : null) : (st[body.kind + 's'] || []).find(x => String(x.id) === String(body.id));
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
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
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
  ['accounts', 'sessions', 'notifs', 'state'].forEach(k => { if (!db[k]) db[k] = {}; });
  db.revision = db.revision || 0; db.adminRevision = db.adminRevision || 0;
  ensureAdmin();
  server.listen(PORT, () => console.log(`${SERVICE} ${VERSION} — port ${PORT} — stockage : ${store.kind} — révision ${db.revision}`));
}
async function stop() { console.log('Arrêt : sauvegarde des données…'); server.close(); try { await store.flush(); } catch (e) {} process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
if (require.main === module) start().catch(e => { console.error('Démarrage impossible :', e.message); process.exit(1); });
module.exports = { start, server, _db: () => db };
