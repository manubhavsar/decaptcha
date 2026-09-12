#!/usr/bin/env node
/**
 * Registers the parent name that all vouches are minted under, and gives it its
 * own child registry so we can issue subnames.
 *
 * Four on-chain steps, all on Sepolia, none of them costing real money:
 *
 *   1. mint the mock payment token (its mint() is public and unpermissioned)
 *   2. approve the registrar to spend it
 *   3. deploy a UserRegistry clone — the parent's own child registry
 *   4. commit / wait / register, with that registry as the subregistry
 *
 * Step 3 before step 4 matters: `register()` takes the subregistry as an
 * argument, so the child registry has to exist first. Without it the parent
 * name could hold records but could never issue subnames, which is the whole
 * point of the parent.
 *
 *   node scripts/register-parent.js [--years 1]
 */

import {
  createPublicClient, createWalletClient, http, parseUnits, formatUnits,
  encodeFunctionData, zeroAddress, keccak256, toHex,
} from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { ENS_V2_SEPOLIA, explorer } from '../backend/src/lib/ens-config.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const step = (n, s) => console.log(`\n${C.bold(`  [${n}]`)} ${s}`);
const ok = (s) => console.log(`  ${C.green('✓')} ${s}`);
const info = (s) => console.log(`    ${C.dim(s)}`);

function loadEnv() {
  const path = new URL('../.env', import.meta.url).pathname;
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const abi = (n) => JSON.parse(readFileSync(new URL(`../backend/src/abi/${n}.json`, import.meta.url), 'utf8'));

/** EACBaseRolesLib.ALL_ROLES — bit 0 of every nybble. */
const ALL_ROLES = BigInt('0x1111111111111111111111111111111111111111111111111111111111111111');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  loadEnv();

  const years = Number(process.argv[process.argv.indexOf('--years') + 1]) || 1;
  const parent = process.env.ENS_PARENT_NAME;
  if (!parent?.endsWith('.eth')) throw new Error('ENS_PARENT_NAME must be set to a .eth name in .env');
  const label = parent.replace(/\.eth$/, '');

  const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
  const transport = http(process.env.SEPOLIA_RPC_URL);
  const pub = createPublicClient({ chain: sepolia, transport });
  const wallet = createWalletClient({ account, chain: sepolia, transport });

  console.log(`\n${C.bold('  Registering ' + parent)} ${C.dim('on ENSv2 Sepolia')}`);
  console.log(C.dim(`  owner: ${account.address}`));

  const REG = { address: ENS_V2_SEPOLIA.ETHRegistrar, abi: abi('ETHRegistrar') };
  const ORACLE = { address: ENS_V2_SEPOLIA.StandardRentPriceOracle, abi: abi('StandardRentPriceOracle') };
  const USDC = { address: ENS_V2_SEPOLIA.MockUSDC, abi: abi('MockUSDC') };
  const FACTORY = { address: ENS_V2_SEPOLIA.VerifiableFactory, abi: abi('VerifiableFactory') };

  const existing = await pub.readContract({
    address: ENS_V2_SEPOLIA.ETHRegistry, abi: abi('ETHRegistry'),
    functionName: 'getResolver', args: [label],
  }).catch(() => zeroAddress);
  if (existing !== zeroAddress) {
    console.log(`\n  ${C.red('Already registered')} — ${parent} resolves to ${existing}.`);
    console.log(C.dim('  Pick a different ENS_PARENT_NAME, or reuse this one if it is yours.\n'));
    process.exit(1);
  }

  const duration = BigInt(years) * 365n * 86400n;
  const now = (await pub.getBlock()).timestamp;
  const [base, premium] = await pub.readContract({
    ...ORACLE, functionName: 'getRegisterPrice',
    args: [label, now, duration, ENS_V2_SEPOLIA.MockUSDC],
  });
  const price = base + premium;
  info(`price: ${formatUnits(price, 6)} USDC for ${years} year(s) — test token, free to mint`);

  /* -- 1. mint ---------------------------------------------------------- */
  step(1, 'Minting the mock payment token');
  const need = price * 2n;
  const held = await pub.readContract({ ...USDC, functionName: 'balanceOf', args: [account.address] });
  if (held < need) {
    const h = await wallet.writeContract({ ...USDC, functionName: 'mint', args: [account.address, parseUnits('1000', 6)] });
    await pub.waitForTransactionReceipt({ hash: h });
    ok(`minted 1000 USDC  ${C.dim(explorer(h, 'tx'))}`);
  } else {
    ok(`already holding ${formatUnits(held, 6)} USDC`);
  }

  /* -- 2. approve -------------------------------------------------------- */
  step(2, 'Approving the registrar');
  const allowance = await pub.readContract({ ...USDC, functionName: 'allowance', args: [account.address, ENS_V2_SEPOLIA.ETHRegistrar] });
  if (allowance < price) {
    const h = await wallet.writeContract({ ...USDC, functionName: 'approve', args: [ENS_V2_SEPOLIA.ETHRegistrar, parseUnits('1000', 6)] });
    await pub.waitForTransactionReceipt({ hash: h });
    ok(`approved  ${C.dim(explorer(h, 'tx'))}`);
  } else {
    ok('allowance already sufficient');
  }

  /* -- 3. the parent's own child registry -------------------------------- */
  step(3, "Deploying the parent's own child registry");
  info('a UserRegistry clone, so this name can issue vouch subnames');
  const initData = encodeFunctionData({
    abi: abi('UserRegistryImpl'), functionName: 'initialize',
    args: [account.address, ALL_ROLES],
  });
  const salt = BigInt(keccak256(toHex(`decaptcha:${parent}`)));

  const { result: registryAddress } = await pub.simulateContract({
    ...FACTORY, account, functionName: 'deployProxy',
    args: [ENS_V2_SEPOLIA.UserRegistryImpl, salt, initData],
  });
  const deployHash = await wallet.writeContract({
    ...FACTORY, functionName: 'deployProxy',
    args: [ENS_V2_SEPOLIA.UserRegistryImpl, salt, initData],
  });
  await pub.waitForTransactionReceipt({ hash: deployHash });
  ok(`registry at ${C.cyan(registryAddress)}`);
  info(explorer(registryAddress));

  /* -- 4. commit / wait / register --------------------------------------- */
  step(4, 'Commit, wait, register');
  const secret = keccak256(toHex(`decaptcha-secret-${Date.now()}-${Math.random()}`));

  const commitment = await pub.readContract({
    ...REG, functionName: 'makeCommitment',
    args: [label, account.address, secret, registryAddress, zeroAddress, duration, `0x${'00'.repeat(32)}`],
  });

  const commitHash = await wallet.writeContract({ ...REG, functionName: 'commit', args: [commitment] });
  await pub.waitForTransactionReceipt({ hash: commitHash });
  ok(`committed  ${C.dim(explorer(commitHash, 'tx'))}`);

  const minAge = await pub.readContract({ ...REG, functionName: 'MIN_COMMITMENT_AGE' });
  const waitMs = (Number(minAge) + 8) * 1000;
  info(`commit/reveal: waiting ${Math.round(waitMs / 1000)}s for the commitment to age`);
  for (let left = Math.round(waitMs / 1000); left > 0; left -= 5) {
    process.stdout.write(`\r    ${C.dim(`${left}s…   `)}`);
    await sleep(Math.min(5000, left * 1000));
  }
  process.stdout.write('\r                    \r');

  // Resolver is left unset: each vouch subname gets its OWN Permissioned
  // Resolver at mint time, which is what makes a vouch self-owned.
  const registerHash = await wallet.writeContract({
    ...REG, functionName: 'register',
    args: [label, account.address, secret, registryAddress, zeroAddress, duration,
           ENS_V2_SEPOLIA.MockUSDC, `0x${'00'.repeat(32)}`],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: registerHash });
  if (receipt.status !== 'success') throw new Error(`register reverted: ${registerHash}`);
  ok(`registered  ${C.dim(explorer(registerHash, 'tx'))}`);

  /* -- verify ------------------------------------------------------------ */
  const sub = await pub.readContract({
    address: ENS_V2_SEPOLIA.ETHRegistry, abi: abi('ETHRegistry'),
    functionName: 'getSubregistry', args: [label],
  });

  console.log(`\n  ${C.green('DONE')} — ${C.bold(parent)} is registered.`);
  console.log(`  child registry: ${sub}`);
  console.log(C.dim(`  ${explorer(registerHash, 'tx')}\n`));

  const out = new URL('../.decaptcha-deploy.json', import.meta.url).pathname;
  writeFileSync(out, JSON.stringify({
    parent, label, owner: account.address,
    parentRegistry: sub, registryFromFactory: registryAddress,
    registerTx: registerHash, registeredAt: new Date().toISOString(),
    durationYears: years,
  }, null, 2) + '\n');
  console.log(C.dim(`  wrote ${out}\n`));
}

main().catch((e) => {
  console.error(`\n  ${C.red('failed')}: ${e.shortMessage ?? e.message}`);
  if (e.metaMessages) console.error(C.dim('  ' + e.metaMessages.slice(0, 4).join('\n  ')));
  console.error();
  process.exit(1);
});
