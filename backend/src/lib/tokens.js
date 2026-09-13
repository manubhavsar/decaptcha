/**
 * Verification tokens — the reCAPTCHA contract, kept deliberately familiar.
 *
 * A site embeds the widget. When the visitor clears the gate, the widget hands
 * the page a token. The page submits that token with its form. The site's
 * backend posts it to /api/siteverify with its secret and learns whether the
 * visitor passed — and, new here, *who was accountable* if the visitor was an
 * agent.
 *
 * Anyone who has integrated reCAPTCHA already knows this shape. That is the
 * point: the whole argument is that admitting accountable agents should be a
 * drop-in change, not a re-architecture.
 */

import crypto from 'node:crypto';

const TTL_MS = 3 * 60 * 1000;

/**
 * Demo site registry. A real deployment would keep this in a database with
 * per-site rate limits and origin allowlists; the shape is what matters here.
 */
const SITES = new Map([
  ['dcap_demo_site', {
    name: 'Demo site',
    secret: 'dcap_secret_demo_do_not_ship',
    origins: ['*'],
  }],
]);

export function knownSite(sitekey) {
  return SITES.get(sitekey) ?? null;
}

export function siteBySecret(secret) {
  for (const [sitekey, cfg] of SITES) {
    if (cfg.secret === secret) return { sitekey, ...cfg };
  }
  return null;
}

/** Tokens are single use. Consumed on siteverify, swept on expiry. */
const issued = new Map();

function sweep() {
  const now = Date.now();
  for (const [t, rec] of issued) if (rec.expiresAt <= now) issued.delete(t);
}

/**
 * @param {object} o
 * @param {string} o.sitekey
 * @param {'human'|'agent'} o.kind
 * @param {string|null} o.vouchName
 * @param {string|null} o.actingFor
 * @param {object|null} o.scope
 */
export function issueToken({ sitekey, kind, vouchName = null, actingFor = null, scope = null }) {
  sweep();
  const token = `dcap_${crypto.randomBytes(24).toString('base64url')}`;
  issued.set(token, {
    sitekey, kind, vouchName, actingFor, scope,
    issuedAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
  });
  return { token, expiresIn: Math.floor(TTL_MS / 1000) };
}

/**
 * Verifies and consumes a token. Mirrors reCAPTCHA's siteverify response, with
 * two fields it never had: whether a human or an accountable agent passed, and
 * which human is on the hook if it was an agent.
 */
export function consumeToken({ token, secret }) {
  sweep();

  const site = siteBySecret(secret);
  if (!site) return { success: false, 'error-codes': ['invalid-input-secret'] };

  const rec = issued.get(token);
  if (!rec) return { success: false, 'error-codes': ['invalid-input-response'] };

  // A token issued for one site must not validate for another.
  if (rec.sitekey !== site.sitekey) {
    return { success: false, 'error-codes': ['sitekey-mismatch'] };
  }

  issued.delete(token);

  return {
    success: true,
    challenge_ts: new Date(rec.issuedAt).toISOString(),
    hostname: site.name,
    // deCAPTCHA additions.
    kind: rec.kind,                 // 'human' | 'agent'
    acting_for: rec.actingFor,      // the accountable human, when kind is 'agent'
    vouch: rec.vouchName,           // the ENS subname presented
    scope: rec.scope,               // what that human authorised
  };
}

export function tokenStats() {
  sweep();
  return { outstanding: issued.size };
}
