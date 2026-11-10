'use strict';
/* Notifications Web Push sans dépendance : VAPID (RFC 8292) + chiffrement du message (RFC 8291, aes128gcm). */
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function generateVapid() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
  return { publicKey: b64u(pub), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

function vapidHeader(vapid, endpoint, subject, now = Date.now()) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const data = header + '.' + claims;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: vapid.privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + data + '.' + b64u(sig) + ', k=' + vapid.publicKey;
}

const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

/* opts.asPrivate / opts.salt (base64url) servent uniquement aux tests avec le vecteur de la RFC 8291. */
function encryptPayload(plaintext, uaPublicB64u, authB64u, opts = {}) {
  const uaPublic = unb64u(uaPublicB64u), authSecret = unb64u(authB64u);
  const as = crypto.createECDH('prime256v1');
  if (opts.asPrivate) as.setPrivateKey(unb64u(opts.asPrivate)); else as.generateKeys();
  const asPublic = as.getPublicKey();
  const shared = as.computeSecret(uaPublic);
  const salt = opts.salt ? unb64u(opts.salt) : crypto.randomBytes(16);
  const ikm = hkdf(authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

/* Déchiffrement côté « navigateur » (utilisé par les tests). */
function decryptPayload(body, uaPrivateB64u, uaPublicB64u, authB64u) {
  const salt = body.slice(0, 16), idlen = body[20], asPublic = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const ua = crypto.createECDH('prime256v1'); ua.setPrivateKey(unb64u(uaPrivateB64u));
  const shared = ua.computeSecret(asPublic);
  const ikm = hkdf(unb64u(authB64u), shared, Buffer.concat([Buffer.from('WebPush: info\0'), unb64u(uaPublicB64u), asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.slice(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.slice(0, ct.length - 16)), d.final()]);
  return plain.slice(0, plain.lastIndexOf(2)).toString('utf8');
}

const PUSH_HOSTS = ['googleapis.com', 'mozilla.com', 'windows.com', 'apple.com'];
function endpointAllowed(endpoint, allowAny) {
  let u; try { u = new URL(endpoint); } catch (e) { return false; }
  if (allowAny) return u.protocol === 'https:' || u.protocol === 'http:';
  if (u.protocol !== 'https:') return false;
  return PUSH_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
}

function send(sub, payload, vapid, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(sub.endpoint);
    const body = encryptPayload(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, timeout: 10000,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', 'Content-Length': body.length, TTL: String(opts.ttl || 86400), Urgency: opts.urgency || 'normal', Authorization: vapidHeader(vapid, sub.endpoint, opts.subject || 'mailto:admin@example.org') }
    }, res => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 200) })); });
    req.on('timeout', () => req.destroy(new Error('délai dépassé')));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { generateVapid, vapidHeader, encryptPayload, decryptPayload, endpointAllowed, send, b64u, unb64u };
