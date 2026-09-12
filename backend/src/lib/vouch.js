/**
 * Vouch resolution — now live against ENSv2 on Sepolia.
 *
 * This module is deliberately thin. It exists so the gate has one place to ask
 * "is there a valid vouch behind this request?", and so that place is provably
 * a chain read rather than a lookup in our own state.
 *
 * There are no hard-coded vouch values here. Scope, expiry, revocation status
 * and the credential reference all come out of the vouch subname's own
 * Permissioned Resolver on every call — see lib/ens.js for why nothing is
 * cached.
 */

import { readVouch, ensStatus, canWriteRecord } from './ens.js';
import { VOUCH_KEYS } from './ens-config.js';

export async function resolveVouch(name) {
  return readVouch(name);
}

export function vouchBackendStatus() {
  const s = ensStatus();
  return {
    wired: s.wired,
    source: s.wired ? 'ensv2-sepolia' : 'not-configured',
    chainId: s.chainId,
    parentName: s.parentName,
    cached: false,
    note: s.wired
      ? 'Vouches are read live from ENSv2 on Sepolia on every request.'
      : 'SEPOLIA_RPC_URL is not set; every presented vouch resolves to nothing.',
  };
}

/**
 * Proof, straight from the chain, that the agent has no write permission on
 * its own credential. Powers the accountability beat in the UI: we show the
 * judges the permission check itself, not our interpretation of it.
 */
export async function permissionReport(vouch) {
  if (!vouch?.found || !vouch.resolverAddress) return null;

  const accounts = [
    { label: 'human (voucher)', address: vouch.humanAddress },
    { label: 'agent (credential holder)', address: vouch.agentAddress },
  ].filter((a) => a.address);

  const keys = [VOUCH_KEYS.scope, VOUCH_KEYS.expiry, VOUCH_KEYS.revoked];
  const rows = [];

  for (const a of accounts) {
    for (const key of keys) {
      rows.push({
        account: a.label,
        address: a.address,
        key,
        canWrite: await canWriteRecord({
          resolverAddress: vouch.resolverAddress,
          node: vouch.node,
          key,
          account: a.address,
        }),
      });
    }
  }

  return { resolverAddress: vouch.resolverAddress, resolverUrl: vouch.resolverUrl, rows };
}
