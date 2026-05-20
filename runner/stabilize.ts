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
  await page.mouse.move(0, 0);
}
