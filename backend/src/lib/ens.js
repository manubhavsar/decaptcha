/**
 * Live ENSv2 resolution on Sepolia.
 *
 * NOTHING HERE IS CACHED, deliberately. The gate calls this on every request.
 * If a vouch's state were cached even for a few seconds, the human's revoke
 * would not take effect on the agent's very next call — and "revocable" would
 * be a claim rather than a demonstrated property. The extra round trip is the
 * feature.
 *
 * There are also no hard-coded vouch values anywhere in this file. Scope,
 * expiry, revocation and the credential reference are read out of the vouch
 * subname's own Permissioned Resolver on chain, every time.
 */

import {
  createPublicClient, http, keccak256, toHex, encodeAbiParameters,
  zeroAddress, isAddress,
} from 'viem';
import { sepolia } from 'viem/chains';
import { namehash, packetToBytes } from 'viem/ens';
import { readFileSync } from 'node:fs';

import { ENS_V2_SEPOLIA, VOUCH_KEYS, CHAIN_ID, explorer } from './ens-config.js';
import { authorisationTerms, verifyAuthorisation } from './authorisation.js';

const abi = (n) =>
  JSON.parse(readFileSync(new URL(`../abi/${n}.json`, import.meta.url), 'utf8'));

const RESOLVER_ABI = abi('PermissionedResolverImpl');
const UR_ABI = abi('UniversalResolverV2');

let client = null;

export function ensClient() {
  if (client) return client;
  const rpc = process.env.SEPOLIA_RPC_URL;
  if (!rpc) return null;
  client = createPublicClient({ chain: sepolia, transport: http(rpc) });
  return client;
}

export function ensStatus() {
  return {
    wired: Boolean(process.env.SEPOLIA_RPC_URL),
    chainId: CHAIN_ID,
    network: 'sepolia',
    parentName: process.env.ENS_PARENT_NAME || null,
    deployment: ENS_V2_SEPOLIA.deployedAt,
    universalResolver: ENS_V2_SEPOLIA.UniversalResolverV2,
    cached: false,
  };
}

/** DNS wire format, which is what UniversalResolverV2 takes. */
export function dnsEncode(name) {
  return toHex(packetToBytes(name));
}

/**
 * The Enhanced Access Control resource for one record of one name.
 *
 * PermissionedResolverLib.resource(node, part) = keccak256(abi.encode(node, part))
 * with part = keccak256(bytes(key)) for string-keyed records.
 *
 * This pair is why the agent provably cannot write to its own credential:
 * permissions are granted against a name AND a record type, so the human can
 * hold write on `decaptcha.revoked` for this one vouch while the agent holds
 * nothing anywhere.
 */
export function vouchResource(node, key) {
  const part = keccak256(toHex(key));
  return BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [node, part])));
}

/** Roles from PermissionedResolverLib. Nybble-packed; admin sits 128 bits up. */
export const RESOLVER_ROLES = {
  SET_TEXT: 1n << 4n,
  SET_TEXT_ADMIN: (1n << 4n) << 128n,
  SET_DATA: 1n << 36n,
  CLEAR: 1n << 32n,
};

/**
 * Reads a vouch straight off chain.
 *
 * @returns a record whose `found` is false for anything that does not resolve
 *          to a vouch — an unregistered name, a name with no resolver, or a
 *          resolver carrying none of our records. All three are treated the
 *          same by the gate: an anonymous bot.
 */
export async function readVouch(name) {
  const c = ensClient();
  if (!c) {
    return { found: false, name, source: 'not-configured', error: 'SEPOLIA_RPC_URL is not set.' };
  }

  const startedAt = Date.now();
  const node = namehash(name);

  let resolverAddress;
  try {
    const [addr] = await c.readContract({
      address: ENS_V2_SEPOLIA.UniversalResolverV2,
      abi: UR_ABI,
      functionName: 'findResolver',
      args: [dnsEncode(name)],
    });
    resolverAddress = addr;
  } catch (e) {
    return { found: false, name, source: 'ensv2-sepolia', error: `Resolution failed: ${e.shortMessage ?? e.message}` };
  }

  if (!resolverAddress || resolverAddress === zeroAddress) {
    return {
      found: false, name, node, source: 'ensv2-sepolia',
      reason: 'no_resolver',
      detail: 'Name has no resolver on ENSv2 Sepolia.',
      latencyMs: Date.now() - startedAt,
    };
  }

  const keys = Object.values(VOUCH_KEYS);
  const results = await c.multicall({
    contracts: keys.map((key) => ({
      address: resolverAddress, abi: RESOLVER_ABI, functionName: 'text', args: [node, key],
    })),
    allowFailure: true,
  });

  const rec = {};
  keys.forEach((key, i) => {
    rec[key] = results[i].status === 'success' ? (results[i].result ?? '') : '';
  });

  const scopeRaw = rec[VOUCH_KEYS.scope];
  const expiryRaw = rec[VOUCH_KEYS.expiry];

  // A resolver with no scope record is not a vouch, whatever else it holds.
  if (!scopeRaw) {
    return {
      found: false, name, node, resolverAddress, source: 'ensv2-sepolia',
      reason: 'not_a_vouch',
      detail: `${name} resolves, but carries no ${VOUCH_KEYS.scope} record.`,
      latencyMs: Date.now() - startedAt,
    };
  }

  const scopeMaxClaims = Number.parseInt(scopeRaw, 10);
  const expirySeconds = Number.parseInt(expiryRaw || '0', 10);
  const revoked = rec[VOUCH_KEYS.revoked] === '1';
  const nowSeconds = Math.floor(Date.now() / 1000);
  const human = rec[VOUCH_KEYS.human];
  const agent = rec[VOUCH_KEYS.agent];

  // Verify the human's authorisation from chain data alone. Nothing here trusts
  // the server that minted the vouch — the signature either recovers to the
  // address on the record or it does not.
  const authorisation = await verifyAuthorisation({
    terms: authorisationTerms({
      vouchName: name,
      agentAddress: agent,
      scopeMaxClaims,
      expiresAt: expirySeconds,
    }),
    signature: rec[VOUCH_KEYS.auth] || null,
    expectedSigner: isAddress(human) ? human : null,
  });

  return {
    found: true,
    name,
    node,
    resolverAddress,
    resolverUrl: explorer(resolverAddress),
    source: 'ensv2-sepolia',
    scopeMaxClaims: Number.isFinite(scopeMaxClaims) ? scopeMaxClaims : 0,
    expiresAt: expirySeconds ? new Date(expirySeconds * 1000).toISOString() : null,
    expired: Boolean(expirySeconds) && expirySeconds <= nowSeconds,
    revoked,
    authorised: authorisation.valid,
    authorisation,
    humanAddress: isAddress(human) ? human : null,
    humanLabel: isAddress(human) ? `${human.slice(0, 6)}…${human.slice(-4)}` : 'a verified human',
    agentAddress: isAddress(agent) ? agent : null,
    latencyMs: Date.now() - startedAt,
    cached: false,
  };
}

/**
 * Asks the chain, not our code, whether an account may write a given record.
 *
 * Used for the accountability beat: we show the judges that the agent's own
 * address returns false here, and that its write therefore reverts inside
 * ENSv2's permission check rather than being turned away by the gate.
 */
export async function canWriteRecords({ resolverAddress, node, checks }) {
  const c = ensClient();
  if (!c) return checks.map(() => null);

  const results = await c.multicall({
    contracts: checks.map(({ account, key }) => ({
      address: resolverAddress,
      abi: RESOLVER_ABI,
      functionName: 'hasRoles',
      args: [vouchResource(node, key), RESOLVER_ROLES.SET_TEXT, account],
    })),
    allowFailure: true,
  });

  return results.map((r) => (r.status === 'success' ? Boolean(r.result) : null));
}

/** Single-cell convenience wrapper over {@link canWriteRecords}. */
export async function canWriteRecord({ resolverAddress, node, key, account }) {
  const [only] = await canWriteRecords({ resolverAddress, node, checks: [{ account, key }] });
  return only;
}
