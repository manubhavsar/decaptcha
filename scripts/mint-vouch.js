#!/usr/bin/env node
/**
 * Mints one vouch under the registered parent name, live on Sepolia.
 *
 *   node scripts/mint-vouch.js [--scope 1] [--hours 24]
 */

import { createPublicClient, createWalletClient, http, parseEther, formatEther } from 'viem';
import { sepolia } from 'viem/chains';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function loadEnv() {
  const path = new URL('../.env', import.meta.url).pathname;
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const { actors } = await import('../backend/src/lib/actors.js');
const { mintVouch } = await import('../backend/src/lib/ens-write.js');
const { readVouch } = await import('../backend/src/lib/ens.js');
const { explorer } = await import('../backend/src/lib/ens-config.js');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};

/** The human signs their own revoke, so they need their own gas. */
async function fundHuman() {
  const a = actors();
  const transport = http(process.env.SEPOLIA_RPC_URL);
  const pub = createPublicClient({ chain: sepolia, transport });
  const bal = await pub.getBalance({ address: a.human.account.address });
  if (bal >= parseEther('0.004')) {
    console.log(`  ${C.green('✓')} human already funded (${formatEther(bal)} ETH)`);
    return;
  }
  const wallet = createWalletClient({ account: a.deployer.account, chain: sepolia, transport });
  const hash = await wallet.sendTransaction({ to: a.human.account.address, value: parseEther('0.008') });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${C.green('✓')} funded the human with 0.008 ETH for their revoke  ${C.dim(explorer(hash, 'tx'))}`);
}

async function main() {
  const scope = arg('scope', 1);
  const hours = arg('hours', 24);
  const a = actors();

  console.log(`\n${C.bold('  Minting a vouch')} ${C.dim('on ENSv2 Sepolia')}`);
  console.log(C.dim(`  human ${a.human.account.address}`));
  console.log(C.dim(`  agent ${a.agent.account.address}\n`));

  await fundHuman();

  const credential = {
    credentialRef: `sc11:pending-${Date.now().toString(36)}`,
    simulated: true,
  };
  console.log(C.dim(`  credential ref: ${credential.credentialRef} (placeholder until World access lands)\n`));

  const out = await mintVouch({
    credential, scopeMaxClaims: scope, ttlHours: hours,
    onStep: ({ step, of, detail }) => console.log(`  ${C.bold(`[${step}/${of}]`)} ${detail}`),
  });

  console.log(`\n  ${C.green('MINTED')} ${C.bold(out.vouchName)}`);
  console.log(`  resolver ${C.cyan(out.resolverAddress)}`);
  console.log(C.dim(`  ${out.resolverUrl}`));
  for (const [k, v] of Object.entries(out.txs)) console.log(C.dim(`  ${k.padEnd(16)} ${explorer(v, 'tx')}`));

  /* Read it back the way the gate will: live, uncached, through the resolver. */
  console.log(`\n${C.bold('  Reading it back from chain')}`);
  const v = await readVouch(out.vouchName);
  console.log(`  found=${v.found} scope=${v.scopeMaxClaims} revoked=${v.revoked} expired=${v.expired}`);
  console.log(`  expires ${v.expiresAt}`);
  console.log(`  credential ${v.credentialRef}`);
  console.log(C.dim(`  read in ${v.latencyMs}ms, no cache\n`));

  const path = new URL('../.decaptcha-vouch.json', import.meta.url).pathname;
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(C.dim(`  wrote ${path}\n`));
}

main().catch((e) => {
  console.error(`\n  ${C.red('failed')}: ${e.shortMessage ?? e.message}`);
  if (e.metaMessages) console.error(C.dim('  ' + e.metaMessages.slice(0, 5).join('\n  ')));
  console.error();
  process.exit(1);
});
