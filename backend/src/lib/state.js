/**
 * In-memory demo state: the scarce inventory, the claim ledger, and the gate
 * event log that the UI streams.
 *
 * Deliberately not a database. Everything here is demo-scenario state that
 * should reset between runs; the parts that must be durable and independently
 * verifiable (the vouch itself — scope, expiry, revocation) live on-chain in
 * ENSv2, not in this file. See lib/vouch.js.
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export const DROP = {
  id: 'ethonline-2026-pass',
  name: 'ETHOnline 2026 Founders Pass',
  blurb: 'Limited edition. One per person. No exceptions, no bots.',
  total: 50,
};

const listeners = new EventEmitter();
listeners.setMaxListeners(50);

let claims = [];
let log = [];

export function remaining() {
  return DROP.total - claims.length;
}

export function claimCount() {
  return claims.length;
}

export function allClaims() {
  return [...claims];
}

/** Claims already made by a given actor identity (an ENS vouch name, or a human id). */
export function claimsBy(actorId) {
  return claims.filter((c) => c.actorId === actorId);
}

export function recordClaim({ actorId, actorKind, actingFor, label }) {
  const claim = {
    serial: claims.length + 1,
    id: crypto.randomUUID(),
    actorId,
    actorKind,
    actingFor: actingFor ?? null,
    label,
    at: new Date().toISOString(),
  };
  claims.push(claim);
  return claim;
}

/**
 * Append to the gate log. Every gate decision lands here so the demo page can
 * show, live, *why* each request was allowed or blocked — which is the whole
 * pitch. `outcome` is one of allow | challenge | block.
 */
export function logEvent(event) {
  const entry = {
    seq: log.length + 1,
    at: new Date().toISOString(),
    ...event,
  };
  log.push(entry);
  if (log.length > 200) log = log.slice(-200);
  listeners.emit('event', entry);
  return entry;
}

export function recentLog(limit = 50) {
  return log.slice(-limit);
}

export function onEvent(fn) {
  listeners.on('event', fn);
  return () => listeners.off('event', fn);
}

export function resetDemo() {
  claims = [];
  log = [];
  listeners.emit('reset', {});
  logEvent({
    outcome: 'info',
    reason: 'demo_reset',
    detail: 'Demo state reset. Inventory restored, claim ledger cleared.',
    actor: 'operator',
  });
}
