/**
 * The vouch is self-verifying, and these tests are what that claim rests on.
 *
 * A signature that exists is worth nothing; a signature that *binds the terms*
 * is the whole point. If any of these pass when they should fail, an agent
 * could carry a vouch claiming more scope than its human ever agreed to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { authorisationTerms, verifyAuthorisation } from '../backend/src/lib/authorisation.js';

const human = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({ account: human, chain: sepolia, transport: http('http://unused') });

const TERMS = {
  vouchName: 'agent1.decaptcha.eth',
  agentAddress: '0x58B84C789BdCD74c6D339B5f7745384c0a0D82ee',
  scopeMaxClaims: 2,
  expiresAt: 1789000000,
};

const terms = authorisationTerms(TERMS);
const signature = await wallet.signMessage({ message: terms });

const check = (over = {}, sig = signature, signer = human.address) =>
  verifyAuthorisation({ terms: authorisationTerms({ ...TERMS, ...over }), signature: sig, expectedSigner: signer });

test('the terms are readable, so the signer can see what they agreed to', () => {
  assert.match(terms, /I authorise the agent at 0x58B84C78/);
  assert.match(terms, /at most 2 verifications/);
  assert.match(terms, /I can revoke this at any time/);
  assert.ok(!/[0-9a-f]{64}/.test(terms), 'no opaque hashes a human could not read');
});

test('an honest signature verifies', async () => {
  const r = await check();
  assert.equal(r.valid, true);
  assert.equal(r.signer.toLowerCase(), human.address.toLowerCase());
});

test('raising the scope breaks the signature', async () => {
  assert.equal((await check({ scopeMaxClaims: 999 })).valid, false);
});

test('extending the expiry breaks the signature', async () => {
  assert.equal((await check({ expiresAt: TERMS.expiresAt + 31536000 })).valid, false);
});

test('pointing the vouch at another agent breaks the signature', async () => {
  assert.equal((await check({ agentAddress: '0x000000000000000000000000000000000000dEaD' })).valid, false);
});

test('renaming the vouch breaks the signature', async () => {
  assert.equal((await check({ vouchName: 'someone-else.decaptcha.eth' })).valid, false);
});

test('a signature from another account does not count', async () => {
  const r = await check({}, signature, stranger.address);
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'signer_mismatch');
});

test('a forged signature is rejected rather than crashing', async () => {
  const r = await check({}, `0x${'11'.repeat(65)}`);
  assert.equal(r.valid, false);
  assert.match(r.reason, /unrecoverable/);
});

test('a missing signature is rejected', async () => {
  assert.equal((await verifyAuthorisation({ terms, signature: null, expectedSigner: human.address })).reason,
    'no_signature');
});

test('a record with no human named on it cannot be authorised', async () => {
  assert.equal((await verifyAuthorisation({ terms, signature, expectedSigner: null })).reason,
    'no_human_on_record');
});
