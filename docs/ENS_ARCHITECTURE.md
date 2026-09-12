# How the vouch works on ENSv2

The design, and why each ENS primitive is load-bearing rather than decorative.
Verified against `ensdomains/contracts-v2` at the commit the ENS docs pin
(`97a5729`, Sepolia deployment stamped 2026-07-30).

## The claim

A vouch is an ENSv2 subname. Everything that makes it *accountable* — how much
the agent may do, until when, and whether it still counts — lives on-chain in
that subname's own resolver, under permissions the agent cannot touch.

Nothing about a vouch is cached in the backend. The gate resolves it live on
every request, which is the only way the human's revoke can take effect on the
agent's very next call.

## The shape

```
          <parent>.eth              registered on the ETHRegistry
                │                   its subregistry: a UserRegistry clone
                │
      ┌─────────┴─────────┐
 agent1.<parent>.eth   agent2.<parent>.eth
      │                     │
 own PermissionedResolver   own PermissionedResolver
```

Each vouch subname gets its **own** resolver — a `PermissionedResolverImpl`
clone deployed through `VerifiableFactory` — rather than sharing one. That is
what makes a vouch self-owned: its records and its permissions travel with it,
and revoking one cannot touch another.

## The records

| Text key | Meaning |
| --- | --- |
| `decaptcha.scope` | how many claims the human authorised |
| `decaptcha.expiry` | unix seconds |
| `decaptcha.revoked` | `"1"` once the human pulls it |
| `decaptcha.credential` | digest of the World Selfie Check credential |
| `decaptcha.human` | the accountable human's address |
| `decaptcha.agent` | the agent address this vouch is bound to |

`decaptcha.credential` is a one-way digest, never the raw World nullifier. The
subname is public on Sepolia, and publishing a raw nullifier there would let
anyone link every action that human's agents ever take.

## Why the agent provably cannot write to its own credential

This is the part that is genuinely enforced by ENS rather than by our code.

`PermissionedResolver` uses **Enhanced Access Control**, a nybble-packed
role system where permissions are scoped to a *resource*. The resource is not
the resolver and not even the name — it is:

```solidity
resource = keccak256(node, part)   // PermissionedResolverLib.resource
```

A name **and** a record type. So `ROLE_SET_TEXT` can be granted on
`(vouchNode, partHash("decaptcha.scope"))` specifically.

We grant the human's address `ROLE_SET_TEXT` on the vouch's record resources.
We grant the agent's address nothing, anywhere. When the agent tries to raise
its own scope or push out its own expiry, the resolver reverts on the
permission check before any record is touched. The denial comes out of ENSv2,
not out of an `if` statement in `gate.js` — which is exactly the difference
between an access-control system and a policy suggestion.

Roles come from `PermissionedResolverLib`; the registry-side roles
(`ROLE_RENEW`, `ROLE_SET_RESOLVER`, `ROLE_SET_SUBREGISTRY`, …) come from
`RegistryRolesLib`. Admin roles sit 128 bits above their regular counterpart,
so the right to *grant* a permission is itself a separate permission.

## Against the ENS track's three properties

- **Expiring.** Two layers. `decaptcha.expiry` bounds the vouch, and the
  subname's own registry expiry bounds the name. The gate rejects on either.
- **Revocable.** The human writes `decaptcha.revoked = "1"` to the vouch's own
  resolver. It is an ordinary Sepolia transaction, watchable on Etherscan as it
  lands, and the gate sees it on the agent's next request because it never
  caches.
- **Non-transferable.** The vouch names the agent it was minted for in
  `decaptcha.agent`, and the gate checks the presenter against it. Handing the
  name to a different agent does not hand over the access.

The bonus the track names — *agents as namespaces, each with their own identity
and permissions* — is the literal architecture here: one subname per agent, one
resolver per subname, one permission set per record.

## Registration notes for Sepolia

- The `.eth` registrar is **commit/reveal**: `commit(hash)`, wait
  `MIN_COMMITMENT_AGE`, then `register(...)`.
- Registration is priced in an **ERC20, not ETH**. On Sepolia that is a mock
  token whose `mint(address,uint256)` is public and unpermissioned, so it costs
  nothing real. Sepolia ETH is still needed for gas.
- **Two ENSv2 deployments are live on Sepolia at once.** The `deployments/`
  folder on contracts-v2 `main` is an older set (2026-06-29) than the one the
  docs render (2026-07-30). Both have bytecode, so picking wrong fails late and
  confusingly. Addresses and this warning are recorded in
  `backend/src/lib/ens-config.js`; `scripts/preflight.js` re-checks them live.
