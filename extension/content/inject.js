/**
 * Runs in the PAGE's world (manifest `"world": "MAIN"`), not the extension's.
 *
 * Its only job is to attach the vouch to requests the page makes to the gate.
 * That mirrors how this would really work: the site is not modified and knows
 * nothing about vouches, exactly as the demo page's own code shows — the agent
 * side presents the credential from outside.
 *
 * A content script in the default isolated world cannot do this, because
 * patching window.fetch there would only patch the extension's copy.
 */

(() => {
  let vouch = null; // { vouchName, agentAddress }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.__decaptcha !== 'vouch') return;
    vouch = e.data.vouch;
  });

  const nativeFetch = window.fetch;

  window.fetch = function decaptchaFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url ?? '';

    if (vouch?.vouchName && url.includes('/api/claim')) {
      const headers = new Headers(init.headers ?? (typeof input !== 'string' ? input.headers : undefined));
      headers.set('X-Decaptcha-Vouch', vouch.vouchName);
      if (vouch.agentAddress) headers.set('X-Decaptcha-Agent', vouch.agentAddress);

      window.postMessage({ __decaptcha: 'presented', vouchName: vouch.vouchName }, '*');
      return nativeFetch(input, { ...init, headers });
    }

    return nativeFetch(input, init);
  };
})();
