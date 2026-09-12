/**
 * Integration test for the extension's background service worker.
 *
 * Loads the REAL extension/background.js — not a copy — behind a minimal Chrome
 * API shim, and drives it against the running gate and live Sepolia. That
 * catches the things a static read misses: wrong endpoint paths, message
 * plumbing that never resolves, state that fails to persist.
 *
 * Requires: the gate running (npm run dev) and an active vouch
 * (node scripts/mint-vouch.js --scope 2).
 *
 *   node --test test/extension.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const GATE = 'http://localhost:8787';

/* ------------------------------ chrome shim ------------------------------ */

let store = {};
const broadcasts = [];
let messageHandler = null;

globalThis.chrome = {
  storage: {
    local: {
      async get(key) { return key in store ? { [key]: store[key] } : {}; },
      async set(patch) { Object.assign(store, patch); },
    },
  },
  runtime: {
    async sendMessage(msg) { broadcasts.push(msg); },
    onMessage: { addListener(fn) { messageHandler = fn; } },
  },
  tabs: {
    async query() { return []; },
    async sendMessage() {},
  },
};

/** Calls the background worker the way the popup does, over its message API. */
function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const kept = messageHandler({ type, payload }, {}, (r) => {
      if (!r?.ok) return reject(new Error(r?.error ?? 'no response'));
      resolve(r.result);
    });
    if (kept !== true) reject(new Error(`handler for "${type}" did not keep the channel open`));
  });
}

/* -------------------------------- fixtures ------------------------------- */

const vouchPath = new URL('../.decaptcha-vouch.json', import.meta.url).pathname;
const fixture = existsSync(vouchPath) ? JSON.parse(readFileSync(vouchPath, 'utf8')) : null;

let gateUp = false;
try {
  gateUp = (await fetch(`${GATE}/api/health`).then((r) => r.ok).catch(() => false));
} catch { /* handled below */ }

const skip = !gateUp ? 'gate is not running on :8787' : !fixture ? 'no vouch minted' : false;

await import('../extension/background.js');

/* --------------------------------- tests --------------------------------- */

test('background registers a message handler that keeps the channel open', () => {
  assert.equal(typeof messageHandler, 'function');
});

test('unknown message types are declined rather than hanging the caller', () => {
  const kept = messageHandler({ type: 'no-such-handler' }, {}, () => {});
  assert.notEqual(kept, true, 'must not claim an async reply it will never send');
});

test('getState returns the full default shape before anything is stored', async () => {
  store = {};
  const s = await send('getState');
  assert.deepEqual(Object.keys(s).sort(),
    ['agentAddress', 'credential', 'lastCheckedAt', 'lastVouch', 'vouchName']);
  assert.equal(s.vouchName, null);
});

test('refresh is a no-op with no vouch held, rather than an error', { skip }, async () => {
  store = {};
  assert.equal(await send('refresh'), null);
});

test('refresh reads the vouch live and persists it', { skip }, async () => {
  store = { state: { vouchName: fixture.vouchName, agentAddress: fixture.agentAddress } };
  const v = await send('refresh');

  assert.equal(v.found, true, 'the minted vouch should resolve on Sepolia');
  assert.equal(v.name, fixture.vouchName);
  assert.equal(v.cached, false, 'the gate must never serve a cached vouch');
  assert.ok(v.scopeMaxClaims >= 1);

  const s = await send('getState');
  assert.equal(s.lastVouch.name, fixture.vouchName);
  assert.ok(s.lastCheckedAt, 'the read time is recorded so the UI can show staleness');
});

test('refresh carries the on-chain permission table the popup renders', { skip }, async () => {
  store = { state: { vouchName: fixture.vouchName } };
  const v = await send('refresh');

  const rows = v.permissions?.rows ?? [];
  assert.equal(rows.length, 6, 'three records for each of two accounts');

  const agentRows = rows.filter((r) => r.account.startsWith('agent'));
  const humanRows = rows.filter((r) => r.account.startsWith('human'));
  assert.ok(agentRows.length && humanRows.length);
  assert.ok(agentRows.every((r) => r.canWrite === false),
    'the agent must hold no write role anywhere on its own credential');
  assert.ok(humanRows.every((r) => r.canWrite === true),
    'the human must be able to revoke');
});

test('the agent self-extension is refused by ENS, not by the extension', { skip }, async () => {
  store = { state: { vouchName: fixture.vouchName } };
  const out = await send('attemptSelfExtend');

  assert.equal(out.denied, true);
  assert.equal(out.error, 'EACUnauthorizedAccountRoles',
    'the refusal must come from ENSv2 Enhanced Access Control');
  assert.equal(out.missingRole, 'ROLE_SET_TEXT');
  assert.equal(out.agentAddress.toLowerCase(), fixture.agentAddress.toLowerCase());
});

test('actions that need a vouch fail cleanly when none is held', { skip: !gateUp && skip }, async () => {
  store = {};
  assert.match((await send('revoke')).error, /Nothing to revoke/);
  assert.match((await send('attemptSelfExtend')).error, /No vouch held/);
  assert.match((await send('mintVouch', { scopeMaxClaims: 1 })).error, /No Selfie Check credential/);
});

test('forget clears the credential completely', async () => {
  store = { state: { vouchName: 'x.eth', credential: { credentialRef: 'sc11:abc' } } };
  const s = await send('forget');
  assert.equal(s.vouchName, null);
  assert.equal(s.credential, null);
  assert.equal((await send('getState')).vouchName, null);
});

test('state changes are broadcast so popup and badge stay in step', async () => {
  broadcasts.length = 0;
  store = {};
  await send('forget');
  assert.ok(broadcasts.some((b) => b.type === 'state'));
});
