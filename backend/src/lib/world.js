/**
 * World ID — Selfie Check (Beta) integration.
 *
 * WHY SELFIE CHECK, IN WORLD'S OWN TERMS
 * --------------------------------------
 * World documents Selfie Check as a medium-assurance credential for *liveness
 * detection, abuse resistance, and continuity*, explicitly not a
 * one-person-one-account guarantee and carrying no numeric Sybil score.
 *
 * deCAPTCHA uses it as an **abuse-prevention signal**, which is the use it is
 * built for. The claim we make on the strength of a passed Selfie Check is
 * narrow and bounded: "a live human took responsibility for this agent, for
 * this many actions, until this expiry, and can revoke it." We never claim the
 * human is unique, and the gate never needs that. Because the resulting vouch
 * is scope-capped and revocable, a medium-assurance credential is the right
 * assurance level for the job rather than a compromise on a higher one.
 *
 * The 90-day inactivity window on the credential is also a natural ceiling on
 * how long a vouch should be allowed to outlive its check.
 *
 * SHAPE OF THE INTEGRATION
 * ------------------------
 * The RP signing key must never leave the server, so everything here runs in
 * the backend. The Chrome extension popup only ever sees a connector URI to
 * render as a QR code, and polls for the outcome. Docs reference:
 * https://docs.world.org/world-id/idkit/integrate
 */

import crypto from 'node:crypto';
import { IDKit, selfieCheckLegacy } from '@worldcoin/idkit-core';
import { signRequest } from '@worldcoin/idkit-core/signing';

const VERIFY_BASE = 'https://developer.world.org/api/v4/verify';

/** Sandbox proofs are still verified against the production verify endpoint. */
export function worldConfig() {
  return {
    appId: process.env.WORLD_APP_ID ?? '',
    rpId: process.env.WORLD_RP_ID ?? '',
    signingKey: process.env.WORLD_RP_SIGNING_KEY ?? '',
    action: process.env.WORLD_ACTION ?? 'vouch-for-my-agent',
    environment: process.env.WORLD_ENVIRONMENT ?? 'sandbox',
    // Build aid only. Lets steps 3-7 be developed while the two World access
    // approvals are pending. Every credential it produces is marked simulated
    // and says so in the UI and the gate log. Must be off for the demo.
    devBypass: process.env.WORLD_DEV_BYPASS === '1',
  };
}

export function worldStatus() {
  const c = worldConfig();
  const missing = [];
  if (!c.appId) missing.push('WORLD_APP_ID');
  if (!c.rpId) missing.push('WORLD_RP_ID');
  if (!c.signingKey) missing.push('WORLD_RP_SIGNING_KEY');

  return {
    configured: missing.length === 0,
    missing,
    action: c.action,
    environment: c.environment,
    credential: 'selfieCheckLegacy',
    credentialId: 11,
    devBypass: c.devBypass,
    hint: missing.length
      ? 'Create an app at developer.world.org, then request the Selfie Check (Beta) feature flag AND sandbox tester access. Both are separate approvals.'
      : null,
  };
}

/* --------------------------- nullifier registry --------------------------- */

/**
 * World's docs recommend storing nullifiers with a UNIQUE (action, nullifier)
 * constraint so a proof cannot be replayed. In-memory here because this is a
 * demo; the uniqueness semantics are the part that matters and they are
 * enforced identically.
 */
const seenNullifiers = new Map(); // `${action}:${nullifier}` -> record

function nullifierKey(action, nullifier) {
  return `${action}:${normaliseNullifier(nullifier)}`;
}

/** Hex casing varies; docs advise converting to decimal before storing. */
function normaliseNullifier(n) {
  if (n == null) return '';
  const s = String(Array.isArray(n) ? n[0] : n);
  if (s.startsWith('0x') || s.startsWith('0X')) {
    try { return BigInt(s).toString(10); } catch { return s.toLowerCase(); }
  }
  return s;
}

export function nullifierSeen(action, nullifier) {
  return seenNullifiers.has(nullifierKey(action, nullifier));
}

export function rememberNullifier(action, nullifier, record) {
  seenNullifiers.set(nullifierKey(action, nullifier), { at: new Date().toISOString(), ...record });
}

export function forgetNullifiers() {
  seenNullifiers.clear();
}

/**
 * Pulls the nullifier out of an IDKit result.
 *
 * selfieCheckLegacy is still on World ID 3.0 while the surrounding docs
 * describe 4.0 response shapes, so this reads both rather than trusting one.
 */
export function extractNullifier(result) {
  if (!result || typeof result !== 'object') return null;
  const responses = result.responses ?? result.response ?? [];
  const first = Array.isArray(responses) ? responses[0] : responses;
  return (
    first?.nullifier ??
    first?.session_nullifier ??
    result.nullifier ??
    result.nullifier_hash ??
    null
  );
}

/* ------------------------------ the flow ---------------------------------- */

const pending = new Map(); // requestId -> { request, signal, startedAt, result }

class WorldNotReady extends Error {
  constructor(status) {
    super(`World ID is not configured: missing ${status.missing.join(', ')}`);
    this.name = 'WorldNotReady';
    this.status = status;
  }
}

/**
 * Begins a Selfie Check. Returns what the popup needs to show a QR code.
 *
 * @param {object} o
 * @param {string} o.signal  Binds the proof to this request so it cannot be
 *                           lifted and replayed against a different vouch.
 */
export async function startSelfieCheck({ signal }) {
  const c = worldConfig();
  const status = worldStatus();

  if (c.devBypass) return startSimulated({ signal });
  if (!status.configured) throw new WorldNotReady(status);

  const rpSig = signRequest({ signingKeyHex: c.signingKey, action: c.action });

  const request = await IDKit.request({
    app_id: c.appId,
    action: c.action,
    environment: c.environment,
    // Required, and it must be true here. Selfie Check only issues World ID 3.0
    // proofs; `false` means "accept v4 only", which this credential can never
    // satisfy. Omitting it throws outright — the SDK rejects the request before
    // it reaches the bridge. Worth pinning down because the docs' Selfie Check
    // sample omits this field while the proofOfHuman and passport samples set
    // it, so copying the Selfie Check snippet verbatim does not run.
    allow_legacy_proofs: true,
    rp_context: {
      rp_id: c.rpId,
      nonce: rpSig.nonce,
      created_at: rpSig.createdAt,
      expires_at: rpSig.expiresAt,
      signature: rpSig.sig,
    },
  }).preset(selfieCheckLegacy({ signal }));

  pending.set(request.requestId, { request, signal, startedAt: Date.now(), simulated: false });

  return {
    requestId: request.requestId,
    connectorURI: request.connectorURI,
    environment: c.environment,
    action: c.action,
    simulated: false,
  };
}

/**
 * Polls a Selfie Check once. When it completes, the proof is forwarded to the
 * Developer Portal byte-for-byte and the nullifier is checked for replay.
 *
 * @returns {{state: 'pending'} | {state: 'failed', error: string} | {state: 'verified', credential: object}}
 */
export async function pollSelfieCheck(requestId) {
  const entry = pending.get(requestId);
  if (!entry) return { state: 'failed', error: 'Unknown or expired verification request.' };
  if (entry.simulated) return pollSimulated(entry, requestId);

  const c = worldConfig();
  let status;
  try {
    status = await entry.request.pollOnce();
  } catch (e) {
    return { state: 'failed', error: `Could not reach the World bridge: ${e.message}` };
  }

  const state = String(status?.state ?? status?.status ?? '').toLowerCase();
  if (state !== 'completed' && state !== 'confirmed' && !status?.result) {
    return { state: 'pending', worldState: state || 'awaiting_scan' };
  }

  const idkitResponse = status.result ?? status.response ?? status;

  // Forward as-is. Docs are explicit: no field remapping.
  const res = await fetch(`${VERIFY_BASE}/${c.rpId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(idkitResponse),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return {
      state: 'failed',
      error: `World rejected the proof (HTTP ${res.status}). ${detail.slice(0, 300)}`,
    };
  }

  const nullifier = extractNullifier(idkitResponse);
  if (!nullifier) {
    return { state: 'failed', error: 'Proof verified but carried no nullifier; refusing to issue a vouch.' };
  }
  if (nullifierSeen(c.action, nullifier)) {
    return {
      state: 'failed',
      error: 'This credential has already been used for this action. Replay refused.',
    };
  }
  rememberNullifier(c.action, nullifier, { signal: entry.signal });

  pending.delete(requestId);

  return { state: 'verified', credential: buildCredential({ nullifier, signal: entry.signal, simulated: false }) };
}

/**
 * The reference we put on-chain. Deliberately a one-way digest of the
 * nullifier, never the nullifier itself: the vouch subname is public on
 * Sepolia, and publishing a raw World nullifier there would let anyone link
 * every action that human's agents ever take. The digest still lets us prove
 * two vouches came from the same credential when we need to.
 */
export function buildCredential({ nullifier, signal, simulated }) {
  const norm = normaliseNullifier(nullifier);
  const ref = crypto.createHash('sha256').update(`decaptcha:v1:${norm}`).digest('hex').slice(0, 32);
  return {
    credential: 'selfieCheckLegacy',
    credentialId: 11,
    purpose: 'abuse-prevention',
    verifiedAt: new Date().toISOString(),
    credentialRef: `sc11:${ref}`,
    signal,
    simulated: Boolean(simulated),
  };
}

/* ----------------------------- dev bypass --------------------------------- */
/* Off unless WORLD_DEV_BYPASS=1. Produces credentials marked simulated so the
   UI, the gate log and the on-chain record all say so. It exists only so the
   ENS work in steps 3-6 is not blocked behind two pending approvals. */

function startSimulated({ signal }) {
  const requestId = `sim_${crypto.randomUUID()}`;
  pending.set(requestId, { signal, startedAt: Date.now(), simulated: true });
  return {
    requestId,
    connectorURI: null,
    environment: 'simulated',
    action: worldConfig().action,
    simulated: true,
    warning: 'SIMULATED Selfie Check. Not a real World credential. Build aid only.',
  };
}

function pollSimulated(entry, requestId) {
  // A beat of latency so the UI's waiting state is exercised honestly.
  if (Date.now() - entry.startedAt < 1200) return { state: 'pending', worldState: 'simulated_capture' };
  pending.delete(requestId);
  const nullifier = `0x${crypto.randomBytes(32).toString('hex')}`;
  rememberNullifier(worldConfig().action, nullifier, { signal: entry.signal, simulated: true });
  return {
    state: 'verified',
    credential: buildCredential({ nullifier, signal: entry.signal, simulated: true }),
  };
}
