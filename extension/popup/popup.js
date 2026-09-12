/**
 * Popup — the human's side of the vouch.
 *
 * Everything shown about a live vouch is read back from ENSv2 rather than from
 * anything the popup remembers, including the permission table. When the human
 * revokes, the popup does not optimistically flip to "revoked": it waits for
 * the chain read to say so. Otherwise the UI would be asserting a property the
 * demo is supposed to prove.
 */

const $ = (id) => document.getElementById(id);
const send = (type, payload = {}) =>
  chrome.runtime.sendMessage({ type, payload }).then((r) => {
    if (!r?.ok) throw new Error(r?.error ?? 'Extension call failed');
    return r.result;
  });

const VIEWS = ['view-start', 'view-check', 'view-mint', 'view-vouch'];
function show(id) { VIEWS.forEach((v) => { $(v).hidden = v !== id; }); }

function notice(el, text, kind = '') {
  el.className = `notice ${kind}`.trim();
  el.textContent = text;
  el.hidden = false;
}

/* --------------------------------- chain --------------------------------- */

async function loadChainChip() {
  try {
    const r = await fetch('http://localhost:8787/api/drop').then((x) => x.json());
    const b = r.vouchBackend;
    $('chain').textContent = b.wired ? `sepolia · ${b.chainId}` : 'chain offline';
  } catch {
    $('chain').textContent = 'gate offline';
  }
}

async function loadWorldStatus() {
  try {
    const s = await fetch('http://localhost:8787/api/world/status').then((x) => x.json());
    if (s.devBypass) {
      notice($('world-unavailable'),
        'Dev bypass is on. Selfie Checks will be SIMULATED and marked as such. Turn off WORLD_DEV_BYPASS for the real demo.', 'warn');
    } else if (!s.configured) {
      notice($('world-unavailable'),
        `World ID not configured yet: missing ${s.missing.join(', ')}. Selfie Check needs the Beta feature flag AND sandbox tester access — two separate approvals.`, 'bad');
      $('begin').disabled = true;
    }
  } catch { /* the gate being down is already reported in the chip */ }
}

/* ----------------------------- selfie check ------------------------------ */

let polling = null;

async function beginCheck() {
  show('view-check');
  $('sim-note').hidden = true;
  $('check-status').textContent = 'Starting…';

  let started;
  try {
    started = await send('startSelfieCheck', { signal: `vouch-${Date.now()}` });
  } catch (e) {
    show('view-start');
    return notice($('world-unavailable'), e.message, 'bad');
  }

  if (started.error === 'world_not_configured') {
    show('view-start');
    return notice($('world-unavailable'),
      `World ID not configured: missing ${(started.missing ?? []).join(', ')}.`, 'bad');
  }

  if (started.simulated) {
    $('qr').removeAttribute('src');
    notice($('sim-note'), started.warning, 'warn');
  } else {
    $('qr').src = started.qrDataUrl;
  }
  $('check-status').textContent = 'Waiting for your phone…';

  clearInterval(polling);
  polling = setInterval(async () => {
    const out = await send('pollSelfieCheck', { requestId: started.requestId });
    if (out.state === 'pending') return;
    clearInterval(polling);

    if (out.state === 'verified') {
      show('view-mint');
      return;
    }
    show('view-start');
    notice($('world-unavailable'), out.error ?? 'Selfie Check failed.', 'bad');
  }, 1500);
}

/* -------------------------------- minting -------------------------------- */

/* Minting is three Sepolia transactions and takes about 45 seconds. The
   backend pushes each step onto the gate's live log, so the popup follows that
   rather than showing an invented progress bar. */
function followMintProgress(el) {
  const started = Date.now();
  let latest = 'Starting…';

  const es = new EventSource('http://localhost:8787/api/stream');
  es.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'gate' && msg.entry.reason === 'vouch_minting') latest = msg.entry.detail;
  };

  const tick = setInterval(() => {
    notice(el, `${latest}  ·  ${Math.round((Date.now() - started) / 1000)}s`);
  }, 500);

  return () => { clearInterval(tick); es.close(); };
}

async function mint() {
  $('mint').disabled = true;
  notice($('mint-status'), 'Starting…');
  const stopFollowing = followMintProgress($('mint-status'));
  try {
    const out = await send('mintVouch', {
      scopeMaxClaims: Number($('scope').value),
      ttlHours: Number($('ttl').value),
    });
    if (out.error) throw new Error(out.detail ?? out.error);
    await renderVouch();
  } catch (e) {
    notice($('mint-status'), e.message, 'bad');
  } finally {
    stopFollowing();
    $('mint').disabled = false;
  }
}

/* ------------------------------- live vouch ------------------------------ */

function fact(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.className = kind;
}

async function renderVouch() {
  const state = await send('getState');
  if (!state.vouchName) return show('view-start');

  show('view-vouch');
  $('vouch-name').textContent = state.vouchName;

  const v = await send('refresh');

  if (!v?.found) {
    fact('f-status', v?.reason ?? 'not found', 'bad');
    return;
  }

  fact('f-scope', `${v.scopeMaxClaims} claim${v.scopeMaxClaims === 1 ? '' : 's'}`);
  fact('f-expiry', v.expiresAt ? new Date(v.expiresAt).toLocaleString() : '—',
    v.expired ? 'bad' : '');
  fact('f-cred', v.credentialRef ?? '—');

  if (v.revoked) fact('f-status', 'revoked', 'bad');
  else if (v.expired) fact('f-status', 'expired', 'bad');
  else fact('f-status', 'active', 'ok');

  if (v.resolverUrl) $('explorer').href = v.resolverUrl;

  renderPermissions(v.permissions);
}

/* The proof, read from the chain: the agent holds no write role anywhere on
   its own credential. */
function renderPermissions(perm) {
  const ul = $('perm-rows');
  ul.innerHTML = '';
  if (!perm?.rows?.length) {
    ul.innerHTML = '<li class="who">Permission data unavailable.</li>';
    return;
  }
  for (const row of perm.rows) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="who"></span><code></code><span></span>';
    li.children[0].textContent = row.account;
    li.children[1].textContent = row.key.replace('decaptcha.', '');
    li.children[2].textContent = row.canWrite ? 'can write' : 'no access';
    li.children[2].className = row.canWrite ? 'yes' : 'no';
    ul.appendChild(li);
  }
}

/* -------------------------------- actions -------------------------------- */

async function revoke() {
  $('revoke').disabled = true;
  notice($('action-status'), 'Writing revocation to the vouch resolver on Sepolia…');
  try {
    const out = await send('revoke');
    if (out.error) throw new Error(out.detail ?? out.error);
    notice($('action-status'),
      `Revoked. Transaction ${out.txHash}. The agent's next request is blocked.`, 'good');
    await renderVouch();
  } catch (e) {
    notice($('action-status'), e.message, 'bad');
  } finally {
    $('revoke').disabled = false;
  }
}

async function selfExtend() {
  $('self-extend').disabled = true;
  notice($('action-status'), 'Agent is attempting to raise its own scope…');
  try {
    const out = await send('attemptSelfExtend');
    if (out.denied) {
      notice($('action-status'),
        `Denied by ENSv2, not by app logic. ${out.detail}`, 'good');
    } else {
      notice($('action-status'),
        `Unexpected: the write was not refused. ${out.detail ?? ''}`, 'bad');
    }
  } catch (e) {
    notice($('action-status'), e.message, 'bad');
  } finally {
    $('self-extend').disabled = false;
  }
}

/* -------------------------------- wiring --------------------------------- */

$('begin').onclick = beginCheck;
$('cancel-check').onclick = () => { clearInterval(polling); show('view-start'); };
$('mint').onclick = mint;
$('revoke').onclick = revoke;
$('self-extend').onclick = selfExtend;
$('forget').onclick = async () => { await send('forget'); show('view-start'); };

chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'state') renderVouch(); });

(async () => {
  loadChainChip();
  await loadWorldStatus();
  const state = await send('getState');
  if (state.vouchName) renderVouch();
  else if (state.credential) show('view-mint');
  else show('view-start');
})();
