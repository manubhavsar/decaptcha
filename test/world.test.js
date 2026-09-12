/**
 * What can be tested before the two World access approvals land.
 *
 * Run: node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  worldStatus, startSelfieCheck, pollSelfieCheck,
  extractNullifier, nullifierSeen, rememberNullifier, forgetNullifiers,
  buildCredential,
} from '../backend/src/lib/world.js';

test('reports exactly which credentials are missing, rather than failing vaguely', () => {
  delete process.env.WORLD_APP_ID;
  delete process.env.WORLD_RP_ID;
  delete process.env.WORLD_RP_SIGNING_KEY;
  const s = worldStatus();
  assert.equal(s.configured, false);
  assert.deepEqual(s.missing, ['WORLD_APP_ID', 'WORLD_RP_ID', 'WORLD_RP_SIGNING_KEY']);
  assert.match(s.hint, /separate approvals/);
});

test('refuses to start a Selfie Check when unconfigured instead of pretending', async () => {
  delete process.env.WORLD_DEV_BYPASS;
  await assert.rejects(() => startSelfieCheck({ signal: 'x' }), (e) => e.name === 'WorldNotReady');
});

test('reads the nullifier from both World ID 3.0 and 4.0 response shapes', () => {
  // selfieCheckLegacy is still on 3.0 while the surrounding docs show 4.0.
  assert.equal(extractNullifier({ responses: [{ nullifier: '0x2a' }] }), '0x2a');
  assert.equal(extractNullifier({ responses: [{ session_nullifier: ['0x2b'] }] })[0], '0x2b');
  assert.equal(extractNullifier({ nullifier_hash: '0x2c' }), '0x2c');
  assert.equal(extractNullifier(null), null);
});

test('nullifier uniqueness ignores hex casing and the 0x prefix', () => {
  forgetNullifiers();
  rememberNullifier('act', '0xABCDEF', {});
  assert.ok(nullifierSeen('act', '0xabcdef'), 'casing must not create a second identity');
  assert.ok(nullifierSeen('act', '11259375'), 'decimal form is the same nullifier');
  assert.ok(!nullifierSeen('other-action', '0xABCDEF'), 'uniqueness is scoped per action');
});

test('the on-chain credential reference does not leak the World nullifier', () => {
  const nullifier = '0xdeadbeefcafe';
  const c = buildCredential({ nullifier, signal: 's', simulated: false });
  const blob = JSON.stringify(c).toLowerCase();
  assert.ok(!blob.includes('deadbeefcafe'), 'raw nullifier must never reach a public Sepolia record');
  assert.ok(!blob.includes(BigInt(nullifier).toString(10)), 'nor its decimal form');
  assert.match(c.credentialRef, /^sc11:[0-9a-f]{32}$/);
  assert.equal(c.purpose, 'abuse-prevention');
});

test('the same credential always yields the same reference, so reuse is detectable', () => {
  const a = buildCredential({ nullifier: '0xAB', signal: 'one', simulated: false });
  const b = buildCredential({ nullifier: '0xab', signal: 'two', simulated: false });
  assert.equal(a.credentialRef, b.credentialRef);
});

test('dev bypass is off by default and marks everything it produces as simulated', async () => {
  process.env.WORLD_DEV_BYPASS = '1';
  forgetNullifiers();
  const start = await startSelfieCheck({ signal: 'dev' });
  assert.equal(start.simulated, true);
  assert.match(start.warning, /SIMULATED/);

  assert.equal((await pollSelfieCheck(start.requestId)).state, 'pending');
  await new Promise((r) => setTimeout(r, 1300));

  const done = await pollSelfieCheck(start.requestId);
  assert.equal(done.state, 'verified');
  assert.equal(done.credential.simulated, true);
  delete process.env.WORLD_DEV_BYPASS;
});

test('an unknown request id fails rather than hanging forever', async () => {
  const out = await pollSelfieCheck('nope');
  assert.equal(out.state, 'failed');
});
