/**
 * Runs in the extension's isolated world on the demo gate.
 *
 * Two jobs: hand the vouch to the page-world patch in inject.js, and show a
 * badge so the gate's verdict is visible on the page rather than only in a
 * terminal. The badge reflects what the *gate* decided; it never asserts a
 * vouch is valid on the extension's own say-so.
 */

const BADGE_ID = 'decaptcha-badge';

const STATES = {
  none: { cls: 'none', dot: '○', title: 'No vouch', sub: 'Requests go through the CAPTCHA like any anonymous bot.' },
  held: { cls: 'held', dot: '◐', title: 'Vouch held', sub: 'Will be presented on the next claim.' },
  vouched: { cls: 'vouched', dot: '●', title: 'Vouched', sub: 'Admitted — a verified human is accountable.' },
  blocked: { cls: 'blocked', dot: '●', title: 'Blocked', sub: 'The gate refused this request.' },
  revoked: { cls: 'revoked', dot: '●', title: 'Revoked', sub: 'The human pulled this vouch. Access ended.' },
};

function badge() {
  let el = document.getElementById(BADGE_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = BADGE_ID;
  el.innerHTML = `
    <span class="dc-dot"></span>
    <div class="dc-text"><div class="dc-title"></div><div class="dc-sub"></div></div>
    <div class="dc-name"></div>`;
  document.documentElement.appendChild(el);
  return el;
}

function paint(stateKey, { vouchName, detail } = {}) {
  const s = STATES[stateKey] ?? STATES.none;
  const el = badge();
  el.className = `dc-${s.cls}`;
  el.querySelector('.dc-dot').textContent = s.dot;
  el.querySelector('.dc-title').textContent = s.title;
  el.querySelector('.dc-sub').textContent = detail ?? s.sub;
  el.querySelector('.dc-name').textContent = vouchName ?? '';
}

function sendVouch(state) {
  window.postMessage({
    __decaptcha: 'vouch',
    vouch: state.vouchName ? { vouchName: state.vouchName, agentAddress: state.agentAddress } : null,
  }, '*');
}

function applyState(state) {
  sendVouch(state);
  const v = state.lastVouch;
  if (!state.vouchName) return paint('none');
  if (v?.revoked) return paint('revoked', { vouchName: state.vouchName });
  paint('held', { vouchName: state.vouchName });
}

/* React to the gate's actual verdicts, streamed from the backend. The badge
   follows the gate rather than guessing, so a scope cap or a revoke shows up
   here the moment the gate enforces it. */
function watchGate() {
  const es = new EventSource('http://localhost:8787/api/stream');
  es.onmessage = async (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type !== 'gate') return;
    const { state } = await chrome.storage.local.get('state');
    if (!state?.vouchName || msg.entry.vouchName !== state.vouchName) return;

    if (msg.entry.outcome === 'allow') {
      paint('vouched', { vouchName: state.vouchName, detail: msg.entry.detail });
    } else if (msg.entry.reason === 'vouch_revoked') {
      paint('revoked', { vouchName: state.vouchName, detail: msg.entry.detail });
    } else {
      paint('blocked', { vouchName: state.vouchName, detail: msg.entry.detail });
    }
  };
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'state') applyState(msg.state);
});

chrome.storage.local.get('state').then(({ state }) => applyState(state ?? {}));
watchGate();
