/**
 * Background service worker — the agent's credential wallet.
 *
 * This is the piece that makes the demo honest about who holds what. The vouch
 * subname lives here, in the agent's own storage, and the agent presents it on
 * every gated request. But holding the name is all it can do: the scope,
 * expiry and revocation flag that give the name meaning live on ENSv2, under
 * permissions this extension has no way to write.
 *
 * So the agent can lose its access at any moment without ever being told, and
 * there is nothing in this file that could prevent that. That is the point.
 */

const GATE = 'http://localhost:8787';

const DEFAULT_STATE = {
  vouchName: null,
  agentAddress: null,
  lastVouch: null,    // last on-chain read, for display only — never trusted
  lastCheckedAt: null,
};

async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return { ...DEFAULT_STATE, ...(state ?? {}) };
}

async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.local.set({ state: next });
  broadcast(next);
  return next;
}

function broadcast(state) {
  // Popup and content scripts both listen. Failures are expected and ignored:
  // there is often no popup open and no matching tab.
  chrome.runtime.sendMessage({ type: 'state', state }).catch(() => {});
  chrome.tabs.query({ url: `${GATE}/*` }).then((tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'state', state }).catch(() => {});
  }).catch(() => {});
}

async function api(path, init) {
  const res = await fetch(GATE + path, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/**
 * Re-reads the vouch from Sepolia.
 *
 * Display only. The gate does its own read on every request and never trusts
 * anything this extension sends about the vouch's state — otherwise a
 * compromised agent could simply claim it had not been revoked.
 */
async function refreshVouch() {
  const { vouchName } = await getState();
  if (!vouchName) return null;
  const { body } = await api(`/api/vouch/${encodeURIComponent(vouchName)}`);
  await setState({ lastVouch: body, lastCheckedAt: new Date().toISOString() });
  return body;
}

const handlers = {
  async getState() {
    return getState();
  },

  async mintVouch({ scopeMaxClaims, ttlHours }) {
    const { status, body } = await api('/api/vouch/mint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopeMaxClaims, ttlHours }),
    });
    if (status === 200 && body.vouchName) {
      await setState({ vouchName: body.vouchName, agentAddress: body.agentAddress });
      await refreshVouch();
    }
    return { status, ...body };
  },

  async revoke() {
    const { vouchName } = await getState();
    if (!vouchName) return { error: 'Nothing to revoke.' };
    const { status, body } = await api('/api/vouch/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vouchName }),
    });
    await refreshVouch();
    return { status, ...body };
  },

  /** The agent trying to widen its own access. Expected to be refused by ENS. */
  async attemptSelfExtend() {
    const { vouchName } = await getState();
    if (!vouchName) return { error: 'No vouch held.' };
    const { status, body } = await api('/api/vouch/self-extend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vouchName }),
    });
    return { status, ...body };
  },

  async refresh() {
    return refreshVouch();
  },

  async forget() {
    await chrome.storage.local.set({ state: DEFAULT_STATE });
    broadcast(DEFAULT_STATE);
    return DEFAULT_STATE;
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  const fn = handlers[msg?.type];
  if (!fn) return false;
  fn(msg.payload ?? {})
    .then((r) => respond({ ok: true, result: r }))
    .catch((e) => respond({ ok: false, error: e.message }));
  return true; // keep the channel open for the async reply
});
