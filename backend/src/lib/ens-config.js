/**
 * ENSv2 Sepolia beta deployment.
 *
 * PROVENANCE — read this before changing an address.
 *
 * These are the addresses the ENS docs render, which come from
 * `contracts/docs/addresses/sepolia.md` in ensdomains/contracts-v2 pinned at
 * commit 97a5729, deployment stamped 2026-07-30.
 *
 * There is a trap here that cost real time and is worth knowing about: the
 * `contracts/deployments/sepolia/` folder on contracts-v2 **main** is a
 * different, older deployment (stamped 2026-06-29) with entirely different
 * addresses. Both sets are live on Sepolia and both have code, so a wrong
 * choice fails late and confusingly rather than immediately. The docs-pinned
 * set is the current one.
 *
 * Every address below was checked with eth_getCode against Sepolia
 * (chainId 11155111) and returned non-empty bytecode.
 */

export const CHAIN_ID = 11155111;

export const ENS_V2_SEPOLIA = {
  deployedAt: '2026-07-30T17:34:25.243Z',
  sourceCommit: '97a57293f3b4279d94b571e678edb53ce62638f4',

  /** Root of the v2 registry hierarchy. */
  RootRegistry: '0x8115186e8f2e0b0281e86ab91f0f48ba90364354',
  /** Registry holding .eth second-level names. */
  ETHRegistry: '0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2',
  /** Commit/reveal registrar for .eth names. Paid in an ERC20, not ETH. */
  ETHRegistrar: '0xa88553f454b77203b0d036a05c894d555eaaa2cc',
  StandardRentPriceOracle: '0x8914b66260eb8c4fff795650c3ae8cd335958987',
  BatchRegistrar: '0x8b16d15f3e51074d0e06f3cf4a0053f7cb92a7fb',

  /** Implementation cloned per name to give each vouch its OWN resolver. */
  PermissionedResolverImpl: '0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e',
  /** Implementation cloned to give the parent name its own child registry. */
  UserRegistryImpl: '0x624a25d67b59d587752ebec8dded8827dae52050',
  /** Deploys verifiable proxies of the two implementations above. */
  VerifiableFactory: '0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef',

  /** Read path: resolves a name and calls its resolver. */
  UniversalResolverV2: '0x4a1817d13e9cf196f471725176355c1234b63c70',
  PublicResolverV2: '0xe7b9a25607e02da8145e4eb1836ca539e53f11f7',

  /** Sepolia test payment tokens. `mint(address,uint256)` is public. */
  MockUSDC: '0x768f42455a2d082e23ceef7d51e5787c82d67a39',
  MockDAI: '0x5472c5725a00b7ba11f0794a79d08ade6f4683bd',
};

/**
 * Text-record keys that carry the vouch.
 *
 * Each key is a separate Enhanced Access Control resource, because
 * PermissionedResolver scopes permissions to `keccak256(node, part)` — a name
 * AND a record type. That is what lets the human hold write permission on the
 * revocation key while the agent holds nothing anywhere on its own record.
 */
export const VOUCH_KEYS = {
  scope: 'decaptcha.scope',        // max claims the human authorised
  expiry: 'decaptcha.expiry',      // unix seconds
  revoked: 'decaptcha.revoked',    // "1" once the human pulls it
  credential: 'decaptcha.credential', // sc11: digest of the World nullifier
  human: 'decaptcha.human',        // the accountable human's address
  agent: 'decaptcha.agent',        // the agent address this vouch is bound to
};

export function explorer(addressOrTx, kind = 'address') {
  return `https://sepolia.etherscan.io/${kind}/${addressOrTx}`;
}
