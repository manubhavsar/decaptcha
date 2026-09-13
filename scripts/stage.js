#!/usr/bin/env node
/**
 * Sets up a clean take. Run this before every recording attempt.
 *
 *   node scripts/stage.js
 *
 * Resets the inventory and gate log, mints a fresh vouch, and prints the exact
 * commands for the recording in order. Takes about a minute, almost all of it
 * waiting for Sepolia.
 */

import { loadEnv } from '../backend/src/lib/env.js';

loadEnv();

const BASE = process.env.GATE ?? 'http://localhost:8787';
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const { mintVouch } = await import('../backend/src/lib/ens-write.js');
const { explorer } = await import('../backend/src/lib/ens-config.js');

if (!(await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false))) {
  console.error(C.red(`\n  The gate is not running. Start it first:  npm run dev\n`));
  process.exit(1);
}

console.log(`\n${C.bold('  Staging a take')}\n`);

await fetch(`${BASE}/api/demo/reset`, { method: 'POST' });
console.log(`  ${C.green('✓')} inventory back to 50, gate log cleared`);

// Scope 2 is the right number for a recording: one claim lands, the second
// lands, the third gets capped. Scope 1 makes the cap look like an off-by-one.
const out = await mintVouch({
  credential: { credentialRef: `sc11:stage-${Date.now().toString(36)}` },
  scopeMaxClaims: 2,
  ttlHours: 24,
  onStep: ({ step, of, detail }) => console.log(`  ${C.dim(`[${step}/${of}]`)} ${detail}`),
});

// Minting logs to the same stream the demo page renders, so clear it again —
// the recording should open on an empty log, not on setup noise.
await fetch(`${BASE}/api/demo/reset`, { method: 'POST' });

console.log(`  ${C.green('✓')} fresh vouch ${C.cyan(out.vouchName)}`);
console.log(`  ${C.dim(out.resolverUrl)}\n`);

console.log(C.bold('  Ready. Have these on screen:'));
console.log(`    1. this terminal`);
console.log(`    2. ${BASE}`);
console.log(`    3. ${out.resolverUrl}`);
console.log(`\n${C.bold('  Then run, in order:')}`);
console.log(`    ${C.cyan('node bots/raw-bot.js')}          ${C.dim('bot gets nothing')}`);
console.log(`    ${C.cyan('node bots/vouched-agent.js --claims 3')}  ${C.dim('through, through, capped')}`);
console.log(`    ${C.cyan('node scripts/demo.js')}          ${C.dim('or just run all six beats')}`);
console.log(`\n  ${C.dim('Re-run this script between takes.')}\n`);
