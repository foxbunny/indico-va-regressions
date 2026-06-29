import {Page} from '@playwright/test';

const STABILIZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  *::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
`;

const LOADER_SELECTORS = [
  '.loading',
  '.spinner',
  '.ui.loader.active',
  '.ui.dimmer.active',
  '[aria-busy="true"]',
];

export async function installStabilizers(page: Page, frozenIso: string): Promise<void> {
  await page.addInitScript(([css, frozen]) => {
    const inject = () => {
      const style = document.createElement('style');
      style.textContent = css as string;
      document.head?.appendChild(style);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', inject, {once: true});
    } else {
      inject();
    }
    const realDate = Date;
    const frozenMs = new realDate(frozen as string).getTime();
    const driftStart = realDate.now();
    class FrozenDate extends realDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        if (args.length === 0) {
          super(frozenMs);
        } else {
          // @ts-expect-error spread to Date constructor
          super(...args);
        }
      }
      static now() {
        return frozenMs + (realDate.now() - driftStart);
      }
    }
    // @ts-expect-error replace global Date
    globalThis.Date = FrozenDate;
  }, [STABILIZE_CSS, frozenIso] as const);
}

// The suite talks to Indico over plain http, so navigator.clipboard is absent
// (it needs a secure context). Some UI only renders when it exists — e.g. the
// iCal export popup's "Copy to clipboard" button. Defining the property from an
// addInitScript did not stick, so instead we patch the document HTML as it
// arrives over the wire and inject an inline <script> at the very top of <head>.
// That script runs before any page script (React included) and gives
// navigator.clipboard a stub, so those controls render and can be captured.
const CLIPBOARD_STUB_TAG =
  '<script data-regression-clipboard-stub>' +
  '(function(){try{if(!navigator.clipboard){' +
  "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{" +
  'writeText:function(){return Promise.resolve();},' +
  "readText:function(){return Promise.resolve('');}}});" +
  '}}catch(e){}})();' +
  '</script>';

export async function installClipboardStub(page: Page): Promise<void> {
  await page.route('**/*', async route => {
    // Serve every request through route.fetch()+fulfill (the canonical body-
    // rewrite pattern). We tried passing sub-resources through with
    // continue()/fallback() and every one failed with net::ERR_FAILED once the
    // route was registered — browser-side pass-through is broken here, but the
    // Node-side route.fetch() reaches Indico fine. So we fetch in Node and serve
    // the bytes back: binary assets are returned untouched; only the HTML
    // document gets the clipboard <script> injected.
    let response;
    try {
      response = await route.fetch();
    } catch {
      return route.fallback();
    }
    const contentType = response.headers()['content-type'] ?? '';
    const isHtmlDoc =
      route.request().resourceType() === 'document' && contentType.includes('text/html');
    if (!isHtmlDoc) {
      return route.fulfill({response});
    }
    let body = await response.text();
    if (/<head[^>]*>/i.test(body)) {
      body = body.replace(/<head([^>]*)>/i, `<head$1>${CLIPBOARD_STUB_TAG}`);
    } else {
      body = CLIPBOARD_STUB_TAG + body;
    }
    const headers = {...response.headers()};
    // The original headers may advertise gzip and a stale length for the
    // pre-edit body; drop both so the browser reads our plaintext correctly.
    delete headers['content-encoding'];
    delete headers['content-length'];
    // Indico's CSP only allows inline scripts carrying a per-response nonce, so
    // our injected <script> would be blocked. Drop the policy on the captured
    // document — we're not testing CSP, and removing it only permits our stub
    // (Indico's own nonced scripts keep working either way).
    delete headers['content-security-policy'];
    delete headers['content-security-policy-report-only'];
    return route.fulfill({response, body, headers});
  });
}

export async function waitForStable(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  try {
    await page.waitForLoadState('networkidle', {timeout: 10_000});
  } catch {
    // some Indico pages keep long-poll connections open; ignore the timeout.
  }
  await page.waitForFunction(
    (selectors: string[]) =>
      document.fonts.ready.then(() => true) &&
      selectors.every(sel => document.querySelectorAll(sel).length === 0),
    LOADER_SELECTORS,
    {timeout: 5_000}
  ).catch(() => {});
  // Park the synthetic cursor outside the viewport so nothing keeps :hover.
  // (0, 0) lands on the top-left element (logo/skip-link/header); negative
  // coords put the pointer off-screen, and both Chromium and Firefox dispatch
  // the mouseout that clears any prior hover. The OS cursor isn't captured in
  // screenshots, so only the :hover CSS state matters here.
  await page.mouse.move(-10, -10);
}
