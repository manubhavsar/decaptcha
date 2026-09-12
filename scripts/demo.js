#!/usr/bin/env node
/**
 * Runs the whole argument end to end, in the order it should be pitched.
 *
 *   node scripts/demo.js
 *
 * Assumes the gate is running (npm run dev) and a vouch has been minted
 * (node scripts/mint-vouch.js --scope 2). Every chain read and write here is
 * live on Sepolia; nothing is staged.
 */

import { readFileSync, existsSync } from 'node:fs';
import { loadEnv } from '../backend/src/lib/env.js';

loadEnv();

const BASE = process.env.GATE ?? 'http://localhost:8787';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

const vouchPath = new URL('../.decaptcha-vouch.json', import.meta.url).pathname;
if (!existsSync(vouchPath)) {
  console.error(C.red('\n  Mint a vouch first:  node scripts/mint-vouch.js --scope 2\n'));
  process.exit(2);
}
const vouch = JSON.parse(readFileSync(vouchPath, 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function beat(n, title, claim) {
  console.log(`\n${C.bold(`  ${n}. ${title}`)}`);
  console.log(C.dim(`     ${claim}`));
}

function verdict(body) {
  const allowed = body.outcome === 'allow';
  console.log(`     ${allowed ? C.green('ALLOWED') : C.red('BLOCKED')} ${C.dim(body.reason ?? '')}`);
  console.log(`     ${body.detail}`);
  return allowed;
}

const post = (path, body, headers = {}) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

const asAgent = (body = {}) =>
  post('/api/claim', body, {
    'X-Decaptcha-Vouch': vouch.vouchName,
    'X-Decaptcha-Agent': vouch.agentAddress,
  });

async function main() {
  console.log(`\n${C.bold('  deCAPTCHA')} ${C.dim('— a CAPTCHA that lets real agents through')}`);
  console.log(C.dim(`  gate ${BASE}  ·  vouch ${vouch.vouchName}`));

  await post('/api/demo/reset');

  /* 1 */
  beat(1, 'An anonymous bot hits the gate',
    'No human behind it. This is what every CAPTCHA already stops.');
  verdict(await post('/api/claim', { actorLabel: 'raw-bot (anonymous)' }));

  await sleep(700);

  /* 2 */
  beat(2, 'The same script, now carrying a vouch',
    'One extra header naming an ENS subname. No API key, no allowlist.');
  verdict(await asAgent());

  await sleep(700);

  /* 3 */
  beat(3, 'It tries to claim beyond its scope',
    `The human authorised ${vouch.scopeMaxClaims}. The cap is on chain, not in the gate.`);
  for (let i = 2; i <= vouch.scopeMaxClaims + 1; i += 1) {
    const body = await asAgent();
    console.log(`     claim ${i}: ${body.outcome === 'allow' ? C.green('allowed') : C.red('blocked')} ${C.dim(body.reason ?? '')}`);
    if (body.outcome !== 'allow') { console.log(`     ${body.detail}`); break; }
  }

  await sleep(700);

  /* 4 */
  beat(4, 'The agent tries to raise its own scope',
    'Refused by ENSv2 itself, not by application logic.');
  const denial = await post('/api/vouch/self-extend', { vouchName: vouch.vouchName });
  if (denial.denied) {
    console.log(`     ${C.green('DENIED')} ${C.dim(denial.error)}`);
    console.log(`     account ${denial.agentAddress}`);
    console.log(`     lacks   ${C.yellow(denial.missingRole ?? 'the required role')}`);
    console.log(C.dim(`     ${denial.resolverUrl}`));
  } else {
    console.log(`     ${C.red('NOT DENIED')} — ${denial.detail}`);
  }

  await sleep(700);

  /* 5 */
  beat(5, 'The human revokes',
    'A real Sepolia transaction, signed by the human, watchable as it lands.');
  await post('/api/demo/reset');
  const rev = await post('/api/vouch/revoke', { vouchName: vouch.vouchName });
  if (rev.error) {
    console.log(`     ${C.red('revoke failed')} — ${rev.detail}`);
  } else {
    console.log(`     ${C.green('REVOKED')} on chain`);
    console.log(C.dim(`     ${rev.txUrl}`));
  }

  await sleep(400);

  /* 6 */
  beat(6, "The agent's very next request",
    'No cache to invalidate, because the gate never had one.');
  verdict(await asAgent());

  console.log(`\n${C.bold('  ─── that is the whole argument ───')}`);
  console.log('  Real bots still get nothing.');
  console.log('  An agent working for a real person gets through instantly.');
  console.log('  Only as much as that person allowed.');
  console.log('  And only until they say otherwise.\n');
  console.log(C.dim(`  Mint a fresh vouch to run again:  node scripts/mint-vouch.js --scope 2\n`));
}

main().catch((e) => { console.error(C.red(`\n  demo failed: ${e.message}\n`)); process.exit(1); });
