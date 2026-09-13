/**
 * The write side: minting, revoking, and the agent's failed self-extension.
 *
 * Each vouch gets its OWN Permissioned Resolver, deployed fresh through
 * VerifiableFactory. That is the difference between a vouch being a self-owned
 * object and being a row in somebody else's table: its records, and the
 * permissions over those records, belong to it alone.
 *
 * After minting, the issuer renounces its own root roles on that resolver. So
 * the final permission state is: the human can revoke, and nobody else can
 * write anything — not the agent, and not us. That is a stronger and more
 * honest claim than "the app promises not to", and it is checkable on chain by
 * anyone.
 */

import {
  createPublicClient, createWalletClient, http, encodeFunctionData,
  zeroAddress, keccak256, toHex, concatHex,
} from 'viem';
import { sepolia } from 'viem/chains';
import { namehash } from 'viem/ens';
import { readFileSync, existsSync } from 'node:fs';

import { ENS_V2_SEPOLIA, VOUCH_KEYS, explorer } from './ens-config.js';
import { actors } from './actors.js';
import { dnsEncode } from './ens.js';

const abi = (n) => JSON.parse(readFileSync(new URL(`../abi/${n}.json`, import.meta.url), 'utf8'));
const RESOLVER_ABI = abi('PermissionedResolverImpl');
const REGISTRY_ABI = abi('UserRegistryImpl');
const FACTORY_ABI = abi('VerifiableFactory');

/** EACBaseRolesLib.ALL_ROLES — bit 0 of every nybble. */
const ALL_ROLES = BigInt('0x1111111111111111111111111111111111111111111111111111111111111111');

/** Human-readable names for the resolver's nybble-packed role bits. */
function roleLabel(bitmap) {
  const known = {
    [1n << 0n]: 'ROLE_SET_ADDR',
    [1n << 4n]: 'ROLE_SET_TEXT',
    [1n << 8n]: 'ROLE_SET_CONTENTHASH',
    [1n << 32n]: 'ROLE_CLEAR',
    [1n << 36n]: 'ROLE_SET_DATA',
  };
  return known[bitmap] ?? `role bitmap ${bitmap}`;
}

/** How long the subname outlives the vouch it carries. See step 2 of mintVouch. */
const EXPIRY_GRACE_SECONDS = 7n * 24n * 3600n;

/** Keys the human keeps write access to after the issuer steps back. */
const HUMAN_WRITABLE = [VOUCH_KEYS.revoked, VOUCH_KEYS.scope, VOUCH_KEYS.expiry];

function deployment() {
  const path = new URL('../../../.decaptcha-deploy.json', import.meta.url).pathname;
  if (!existsSync(path)) {
    throw new Error('Parent name not registered yet. Run: node scripts/register-parent.js');
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function clients(actorKey = 'deployer') {
  const a = actors();
  const transport = http(process.env.SEPOLIA_RPC_URL);
  return {
    pub: createPublicClient({ chain: sepolia, transport }),
    wallet: createWalletClient({ account: a[actorKey].account, chain: sepolia, transport }),
    actors: a,
  };
}

export function vouchWriteStatus() {
  try {
    const d = deployment();
    const a = actors();
    return {
      ready: true,
      parent: d.parent,
      parentRegistry: d.parentRegistry,
      deployer: a.deployer.account.address,
      human: a.human.account.address,
      agent: a.agent.account.address,
    };
  } catch (e) {
    return { ready: false, error: e.message };
  }
}

/**
 * Mints one vouch.
 *
 * Three transactions, in an order that matters:
 *   1. deploy the vouch's own resolver, pre-populated in the same call
 *      (PermissionedResolver skips permission checks while initializing, so
 *      the records can be written before anyone holds a role over them)
 *   2. register the subname in the parent's registry, pointed at that resolver
 *   3. grant the human their write access and renounce ours, batched
 *
 * Three transactions rather than four: the grants and the renunciation both
 * target this resolver, so one multicall covers them. Within that batch the
 * renunciation must come last, since granting needs the roles being given up.
 */
export async function mintVouch({ credential, scopeMaxClaims = 1, ttlHours = 24, onStep = () => {} }) {
  const d = deployment();
  const { pub, wallet, actors: a } = clients('deployer');

  const label = `agent${Date.now().toString(36)}`;
  const fullName = `${label}.${d.parent}`;
  const node = namehash(fullName);
  const dnsName = dnsEncode(fullName);

  const expirySeconds = Math.floor(Date.now() / 1000) + ttlHours * 3600;

  const records = {
    [VOUCH_KEYS.scope]: String(scopeMaxClaims),
    [VOUCH_KEYS.expiry]: String(expirySeconds),
    [VOUCH_KEYS.revoked]: '0',
    [VOUCH_KEYS.credential]: credential?.credentialRef ?? '',
    [VOUCH_KEYS.human]: a.human.account.address,
    [VOUCH_KEYS.agent]: a.agent.account.address,
  };

  /* 1. the vouch's own resolver, populated in the same transaction */
  onStep({ step: 1, of: 3, detail: 'Deploying this vouch its own Permissioned Resolver' });

  const setters = Object.entries(records).map(([key, value]) =>
    encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setText', args: [node, key, value] }));

  const initData = encodeFunctionData({
    abi: RESOLVER_ABI, functionName: 'initialize',
    args: [a.deployer.account.address, ALL_ROLES, setters],
  });
  const salt = BigInt(keccak256(concatHex([toHex(fullName), toHex('resolver')])));

  const { result: resolverAddress } = await pub.simulateContract({
    address: ENS_V2_SEPOLIA.VerifiableFactory, abi: FACTORY_ABI,
    account: a.deployer.account, functionName: 'deployProxy',
    args: [ENS_V2_SEPOLIA.PermissionedResolverImpl, salt, initData],
  });
  const h1 = await wallet.writeContract({
    address: ENS_V2_SEPOLIA.VerifiableFactory, abi: FACTORY_ABI, functionName: 'deployProxy',
    args: [ENS_V2_SEPOLIA.PermissionedResolverImpl, salt, initData],
  });
  await pub.waitForTransactionReceipt({ hash: h1 });

  /* 2. the subname itself, owned by the human, pointed at that resolver */
  onStep({ step: 2, of: 3, detail: `Registering ${fullName}`, resolverAddress });

  // The subname's REGISTRY expiry deliberately outlives the vouch's own expiry.
  //
  // Setting them equal looks tidy and is wrong. When the registry expiry lands
  // the name stops resolving at all, so the gate sees "no resolver" and reports
  // an unknown vouch — indistinguishable from a name that never existed. The
  // agent is correctly blocked either way, but nobody can tell *why*, and the
  // vouch_expired branch never runs.
  //
  // With a grace period the two layers stack properly: the vouch expires first
  // and the gate can still read the record and say so, then the name itself
  // lapses later as a backstop.
  const registryExpiry = BigInt(expirySeconds) + EXPIRY_GRACE_SECONDS;

  const h2 = await wallet.writeContract({
    address: d.parentRegistry, abi: REGISTRY_ABI, functionName: 'register',
    args: [label, a.human.account.address, zeroAddress, resolverAddress,
           ALL_ROLES, registryExpiry],
  });
  await pub.waitForTransactionReceipt({ hash: h2 });

  /* 3. the human's write access, then the issuer steps back — one transaction.
        Both target this resolver, and multicall preserves the caller, so the
        grants and the renunciation can share a block. Ordering inside the
        batch matters: granting requires the very roles being given up, so the
        renunciation has to come last. */
  onStep({ step: 3, of: 3, detail: 'Granting the human write access, then renouncing our own' });

  const finalise = [
    ...HUMAN_WRITABLE.map((key) => encodeFunctionData({
      abi: RESOLVER_ABI, functionName: 'authorizeTextRoles',
      args: [dnsName, key, a.human.account.address, true],
    })),
    encodeFunctionData({
      abi: RESOLVER_ABI, functionName: 'revokeRootRoles',
      args: [ALL_ROLES, a.deployer.account.address],
    }),
  ];
  const h3 = await wallet.writeContract({
    address: resolverAddress, abi: RESOLVER_ABI, functionName: 'multicall', args: [finalise],
  });
  await pub.waitForTransactionReceipt({ hash: h3 });

  return {
    vouchName: fullName,
    node,
    resolverAddress,
    resolverUrl: explorer(resolverAddress),
    humanAddress: a.human.account.address,
    agentAddress: a.agent.account.address,
    scopeMaxClaims,
    expiresAt: new Date(expirySeconds * 1000).toISOString(),
    nameExpiresAt: new Date(Number(registryExpiry) * 1000).toISOString(),
    txs: { deployResolver: h1, registerSubname: h2, grantAndRenounce: h3 },
  };
}

/**
 * The human revokes. An ordinary Sepolia transaction, signed by the human's
 * own key, watchable on Etherscan as it lands.
 */
export async function revokeVouch({ vouchName, resolverAddress }) {
  const { pub, wallet } = clients('human');
  const node = namehash(vouchName);

  const hash = await wallet.writeContract({
    address: resolverAddress, abi: RESOLVER_ABI, functionName: 'setText',
    args: [node, VOUCH_KEYS.revoked, '1'],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });

  return { ok: receipt.status === 'success', txHash: hash, txUrl: explorer(hash, 'tx') };
}

/**
 * The agent tries to widen its own access.
 *
 * We simulate rather than send, because the point is the refusal and a
 * simulation surfaces the actual revert reason instead of an out-of-gas
 * receipt. The refusal comes from ENSv2's Enhanced Access Control, not from
 * anything in this codebase — which is the entire claim being demonstrated.
 */
export async function attemptSelfExtend({ vouchName, resolverAddress, newScope = '999' }) {
  const { pub, actors: a } = clients('agent');
  const node = namehash(vouchName);

  try {
    await pub.simulateContract({
      address: resolverAddress, abi: RESOLVER_ABI, functionName: 'setText',
      account: a.agent.account,
      args: [node, VOUCH_KEYS.scope, newScope],
    });
    return {
      denied: false,
      detail: 'The write was NOT refused. The permission model is not doing its job.',
    };
  } catch (e) {
    // Dig out the decoded custom error. EnhancedAccessControl reverts with
    // EACUnauthorizedAccountRoles(resource, roleBitmap, account), which names
    // the account and the exact role it lacks — far better evidence than a
    // generic "reverted", so it is worth unwrapping viem's error chain for.
    let err = e;
    let decoded = null;
    for (let i = 0; i < 6 && err; i += 1) {
      if (err.data?.errorName) { decoded = err.data; break; }
      err = err.cause;
    }

    const roleName = decoded?.args?.[1] !== undefined
      ? roleLabel(BigInt(decoded.args[1])) : null;

    return {
      denied: true,
      by: 'ENSv2 EnhancedAccessControl',
      error: decoded?.errorName ?? 'revert',
      agentAddress: a.agent.account.address,
      attempted: `setText(${VOUCH_KEYS.scope} = ${newScope})`,
      missingRole: roleName,
      resource: decoded?.args?.[0] ? String(decoded.args[0]) : null,
      detail: decoded?.errorName === 'EACUnauthorizedAccountRoles'
        ? `ENSv2 reverted with ${decoded.errorName}: account ${decoded.args[2]} does not hold ${roleName ?? 'the required role'} on this record. The refusal is the protocol's, not the app's.`
        : `ENSv2 refused the write: ${e.shortMessage ?? e.message}`,
      resolverUrl: explorer(resolverAddress),
    };
  }
}
