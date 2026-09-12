#!/usr/bin/env node
/**
 * preflight — check the Sepolia setup before any ENS work is attempted.
 *
 * Every ENSv2 address this project uses is checked live here rather than
 * trusted from a table. Two different ENSv2 deployments are live on Sepolia
 * simultaneously (see lib/ens-config.js), so "the address had code" is not
 * enough on its own — but an address with *no* code is a guaranteed dead end,
 * and catching that here beats debugging a silent revert later.
 *
 *   node scripts/preflight.js            check the current .env
 *   node scripts/preflight.js --new-key  also generate a fresh burner key
 */

import 'node:process';
import { createPublicClient, http, formatEther, getContract } from 'viem';
import { sepolia } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readFileSync, existsSync } from 'node:fs';
import { ENS_V2_SEPOLIA, CHAIN_ID, explorer } from '../backend/src/lib/ens-config.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const ok = (s) => console.log(`  ${C.green('✓')} ${s}`);
const bad = (s) => console.log(`  ${C.red('✗')} ${s}`);
const warn = (s) => console.log(`  ${C.yellow('!')} ${s}`);

/* Minimal .env loader — avoids a dependency for four variables. */
function loadEnv() {
  const path = new URL('../.env', import.meta.url).pathname;
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];

async function main() {
  loadEnv();
  let failures = 0;

  if (process.argv.includes('--new-key')) {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    console.log(`\n${C.bold('  Fresh burner wallet')}`);
    console.log(`  address:     ${C.bold(acct.address)}`);
    console.log(`  private key: ${pk}`);
    console.log(C.yellow('\n  Put the private key in .env as DEPLOYER_PRIVATE_KEY.'));
    console.log(C.dim('  This key is for Sepolia testnet only. Never fund it with anything real.'));
    console.log(C.dim('  .env is gitignored; keep it that way.\n'));
    return;
  }

  console.log(`\n${C.bold('  deCAPTCHA preflight')} ${C.dim('— Sepolia readiness')}\n`);

  /* ---- 1. RPC ---------------------------------------------------------- */
  console.log(C.bold('  RPC'));
  const rpc = process.env.SEPOLIA_RPC_URL;
  if (!rpc) {
    bad('SEPOLIA_RPC_URL is not set. Get a free Sepolia endpoint from Alchemy or Infura.');
    console.log(C.dim('\n  Copy .env.example to .env and fill it in.\n'));
    process.exit(1);
  }

  const client = createPublicClient({ chain: sepolia, transport: http(rpc) });

  let chainId;
  try {
    chainId = await client.getChainId();
  } catch (e) {
    bad(`Could not reach the RPC: ${e.shortMessage ?? e.message}`);
    process.exit(1);
  }

  if (chainId !== CHAIN_ID) {
    bad(`Wrong network. Expected Sepolia (${CHAIN_ID}), got ${chainId}.`);
    failures += 1;
  } else {
    const block = await client.getBlockNumber();
    ok(`Sepolia reachable, at block ${block}`);
  }

  /* ---- 2. Wallet ------------------------------------------------------- */
  console.log(`\n${C.bold('  Wallet')}`);
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) {
    bad('DEPLOYER_PRIVATE_KEY is not set.');
    console.log(C.dim('      Generate a throwaway one:  node scripts/preflight.js --new-key'));
    failures += 1;
  } else {
    let acct;
    try {
      acct = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
    } catch {
      bad('DEPLOYER_PRIVATE_KEY is not a valid private key (expect 32 bytes of hex).');
      failures += 1;
    }
    if (acct) {
      const bal = await client.getBalance({ address: acct.address });
      const eth = Number(formatEther(bal));
      console.log(`    ${acct.address}`);
      if (eth === 0) {
        bad('No Sepolia ETH. You need gas.');
        console.log(C.dim('      Faucets: https://sepoliafaucet.com  ·  https://www.alchemy.com/faucets/ethereum-sepolia'));
        failures += 1;
      } else if (eth < 0.02) {
        warn(`Only ${eth.toFixed(4)} SepoliaETH. Enough to start, top up if registration fails.`);
      } else {
        ok(`${eth.toFixed(4)} SepoliaETH for gas`);
      }

      // Registration is paid in an ERC20, not ETH. On Sepolia that is a mock
      // token whose mint() is public, so this costs nothing real.
      try {
        const usdc = getContract({ address: ENS_V2_SEPOLIA.MockUSDC, abi: ERC20_ABI, client });
        const [raw, dec, sym] = await Promise.all([
          usdc.read.balanceOf([acct.address]), usdc.read.decimals(), usdc.read.symbol(),
        ]);
        const amount = Number(raw) / 10 ** Number(dec);
        if (amount === 0) {
          warn(`0 ${sym}. Name registration is priced in ${sym}, not ETH.`);
          console.log(C.dim('      Its mint() is public and free — the register script will mint for you.'));
        } else {
          ok(`${amount} ${sym} (test token, free to mint)`);
        }
      } catch (e) {
        warn(`Could not read the mock payment token: ${e.shortMessage ?? e.message}`);
      }
    }
  }

  /* ---- 3. ENSv2 contracts --------------------------------------------- */
  console.log(`\n${C.bold('  ENSv2 contracts')} ${C.dim(`(deployment ${ENS_V2_SEPOLIA.deployedAt.slice(0, 10)})`)}`);
  const names = Object.keys(ENS_V2_SEPOLIA).filter((k) => /^0x/.test(String(ENS_V2_SEPOLIA[k])));
  const codes = await Promise.all(
    names.map((n) => client.getBytecode({ address: ENS_V2_SEPOLIA[n] }).catch(() => null)),
  );

  let missing = 0;
  names.forEach((n, i) => {
    const size = codes[i] ? (codes[i].length - 2) / 2 : 0;
    if (size === 0) { bad(`${n} has no code at ${ENS_V2_SEPOLIA[n]}`); missing += 1; }
  });
  if (missing === 0) {
    ok(`all ${names.length} addresses have live bytecode on Sepolia`);
    console.log(C.dim(`      e.g. ${explorer(ENS_V2_SEPOLIA.PermissionedResolverImpl)}`));
  } else {
    failures += missing;
    console.log(C.dim('      Two ENSv2 deployments are live on Sepolia at once — see lib/ens-config.js.'));
  }

  /* ---- 4. Parent name -------------------------------------------------- */
  console.log(`\n${C.bold('  Vouch namespace')}`);
  if (!process.env.ENS_PARENT_NAME) {
    warn('ENS_PARENT_NAME is not set yet. Pick one, then run the register script.');
  } else {
    ok(`vouches will be minted under ${C.bold(process.env.ENS_PARENT_NAME)}`);
  }

  /* ---- verdict --------------------------------------------------------- */
  console.log();
  if (failures === 0) {
    console.log(`  ${C.green('READY')} — Sepolia setup checks out.\n`);
    process.exit(0);
  }
  console.log(`  ${C.red('NOT READY')} — ${failures} thing${failures === 1 ? '' : 's'} to fix above.\n`);
  process.exit(1);
}

main().catch((e) => { console.error(C.red(`\n  preflight crashed: ${e.stack}\n`)); process.exit(2); });
