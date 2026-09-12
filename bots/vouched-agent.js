#!/usr/bin/env node
/**
 * vouched-agent — the SAME script as raw-bot, carrying a vouch.
 *
 * That is the point of the comparison, so this file deliberately does nothing
 * clever: it posts to the same endpoint with the same shape, and the only
 * difference is one header naming an ENS subname. It has no special access, no
 * API key, and no way to raise its own limits.
 *
 *   node bots/vouched-agent.js [--claims 2]
 */

import { readFileSync, existsSync } from 'node:fs';

const BASE = process.env.GATE ?? 'http://localhost:8787';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const vouchPath = new URL('../.decaptcha-vouch.json', import.meta.url).pathname;
if (!existsSync(vouchPath)) {
  console.error(C.red('\n  No vouch found. Mint one first:  node scripts/mint-vouch.js\n'));
  process.exit(2);
}
const vouch = JSON.parse(readFileSync(vouchPath, 'utf8'));

const i = process.argv.indexOf('--claims');
const attempts = i === -1 ? 2 : Number(process.argv[i + 1]);

async function claim(n) {
  const res = await fetch(`${BASE}/api/claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'user-agent': 'vouched-agent/1.0',
      'X-Decaptcha-Vouch': vouch.vouchName,
      'X-Decaptcha-Agent': vouch.agentAddress,
    },
    body: JSON.stringify({ actorLabel: 'agent (vouched)' }),
  });
  const body = await res.json();

  const allowed = body.outcome === 'allow';
  console.log(`  attempt ${n}: ${allowed ? C.green('ALLOWED') : C.red('BLOCKED')}  ${C.dim(body.reason ?? '')}`);
  console.log(`             ${body.detail}`);
  return body;
}

console.log(`\n${C.bold('  vouched-agent')} ${C.dim('— same script as raw-bot, one header different')}`);
console.log(C.dim(`  credential: ${vouch.vouchName}`));
console.log(C.dim(`  agent addr: ${vouch.agentAddress}\n`));

let allowed = 0;
for (let n = 1; n <= attempts; n += 1) {
  const r = await claim(n);
  if (r.outcome === 'allow') allowed += 1;
  console.log();
}

console.log(C.bold('  ─── result ───'));
console.log(`  ${allowed} of ${attempts} attempts allowed.`);
console.log(C.dim('  The cap is not this script\'s choice, and not the gate\'s policy —'));
console.log(C.dim('  it is the number the human wrote into the vouch on Sepolia.\n'));
