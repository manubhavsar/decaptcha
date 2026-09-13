/**
 * The three accounts the demo needs, and why they must be three.
 *
 *   deployer — owns decaptcha.eth, mints vouches, pays gas
 *   human    — the person who signs the authorisation and vouches for the agent
 *   agent    — the AI agent holding the credential
 *
 * If the human and the agent shared an address, the two accountability beats
 * would be meaningless: "the agent cannot widen its own scope" only proves
 * something when the agent is a genuinely different account that genuinely
 * lacks the role. So the agent gets its own key, its own gas, and its own
 * failed transaction that anyone can look up on Etherscan.
 *
 * The human and agent keys are derived deterministically from the deployer key
 * so the demo is reproducible from a single secret — re-running setup gives the
 * same addresses rather than orphaning the previous vouches.
 */

import { keccak256, toHex, concatHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

function derive(rootKey, role) {
  return keccak256(concatHex([rootKey, toHex(`decaptcha:${role}`)]));
}

export function actors() {
  const root = process.env.DEPLOYER_PRIVATE_KEY;
  if (!root) throw new Error('DEPLOYER_PRIVATE_KEY is not set.');
  const rootKey = root.startsWith('0x') ? root : `0x${root}`;

  const humanKey = derive(rootKey, 'human');
  const agentKey = derive(rootKey, 'agent');

  return {
    deployer: { key: rootKey, account: privateKeyToAccount(rootKey), role: 'deployer' },
    human: { key: humanKey, account: privateKeyToAccount(humanKey), role: 'human' },
    agent: { key: agentKey, account: privateKeyToAccount(agentKey), role: 'agent' },
  };
}

export function actorAddresses() {
  const a = actors();
  return {
    deployer: a.deployer.account.address,
    human: a.human.account.address,
    agent: a.agent.account.address,
  };
}
