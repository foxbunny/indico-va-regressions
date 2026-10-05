// Records, for either revision of the category navigator, every ARIA/role attribute inside the
// open navigator, the focus indicator of each Tab stop, and the text contrast of visible text.
// Selectors work on both the jQuery UI dialog and the native <dialog>, and nothing is skipped
// on the base revision, so the output of two runs can be compared directly.

import {test} from '@playwright/test';
import {readFileSync} from 'node:fs';

import {installStabilizers, waitForStable} from './stabilize';

const manifest = JSON.parse(readFileSync('../output/manifest.json', 'utf8'));

test.use({
  baseURL: process.env.BASE_URL || 'http://indico:8000',
  storageState: '../output/auth/admin.json',
  viewport: {width: 1280, height: 900},
});

test.beforeEach(async ({page}) => {
  await installStabilizers(page, '2026-06-15T12:00:00+00:00');
  await page.addInitScript(() => {
    (window as any).__findNavigator = () =>
      document.querySelector('#category-navigator') ||
      [...document.querySelectorAll('.ui-dialog')].find(d => (d as HTMLElement).offsetParent !== null);
  });
});

const entryPoints = [
  {
    name: 'display',
    open: async page => {
      await page.goto(`/category/${manifest.navigatorParentId}/`);
      await page.locator('#navigate-button').click();
    },
  },
  {
    name: 'category-move',
    open: async page => {
      await page.goto(`/category/${manifest.navigatorParentId}/manage/`);
      await page.locator('.category-management tr:has-text("Navigator source") .js-move-category').click();
    },
  },
  {
    name: 'display-search',
    open: async page => {
      await page.goto(`/category/${manifest.navigatorParentId}/`);
      await page.locator('#navigate-button').click();
      await page.locator("input[placeholder='Search']").fill('Navigator');
      await page.locator('.search-results-list .item').first().waitFor();
    },
  },
];

async function openNavigator(page, entry) {
  await entry.open(page);
  if (entry.name !== 'display-search') {
    await page.locator('.current-category').first().waitFor();
  }
  await page.evaluate(() => document.fonts.ready);
  await waitForStable(page);
}

for (const entry of entryPoints) {
  test(`semantic attributes and tooltip structure (${entry.name})`, async ({page}, testInfo) => {
    await openNavigator(page, entry);
    const snapshot = await page.evaluate(() => {
      const root = (window as any).__findNavigator();
      const elements = [root, ...root.querySelectorAll('*')];
      const attributes = elements.flatMap(el =>
        [...el.attributes]
          .filter(attr => attr.name === 'role' || attr.name.startsWith('aria-'))
          .map(attr => ({
            tag: el.tagName.toLowerCase(),
            className: typeof el.className === 'string' ? el.className : '',
            name: attr.name,
            value: attr.value,
            referencedIdExists: attr.name.match(/^aria-(labelledby|describedby|controls|owns)$/)
              ? attr.value.split(/\s+/).map(id => Boolean(document.getElementById(id)))
              : null,
          }))
      );
      const titles = elements
        .filter(el => el.hasAttribute('title'))
        .map(el => ({tag: el.tagName.toLowerCase(), title: el.getAttribute('title')}));
      const tooltips = [...root.querySelectorAll('ind-with-tooltip')].map(host => {
        const control = host.querySelector('button, a, label');
        return {
          controlTag: control?.tagName.toLowerCase() ?? null,
          controlIsChild: Boolean(control && control.parentElement === host),
          tipInsideControl: Boolean(control?.querySelector('[data-tip-content]')),
          text: control?.querySelector('[data-tip-content]')?.textContent?.trim() ?? null,
        };
      });
      return {attributes, titles, tooltips};
    });
    const result = {entry: entry.name, browser: testInfo.project.use.browserName, ...snapshot};
    console.log(`AUDIT-ARIA ${JSON.stringify(result)}`);
    await testInfo.attach('aria-attributes', {body: JSON.stringify(result, null, 2), contentType: 'application/json'});
  });

  test(`focus indicator of each Tab stop (${entry.name})`, async ({page}, testInfo) => {
    await openNavigator(page, entry);
    const stops = [];
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const el = document.activeElement;
        const dialog = (window as any).__findNavigator();
        const style = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          className: typeof el.className === 'string' ? el.className : '',
          text: (el.innerText || el.value || '').trim().slice(0, 60),
          insideDialog: Boolean(dialog && dialog.contains(el)),
          focusVisible: el.matches(':focus-visible'),
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          outlineColor: style.outlineColor,
          boxShadow: style.boxShadow,
        };
      });
      stops.push(stop);
    }
    const result = {entry: entry.name, browser: testInfo.project.use.browserName, stops};
    console.log(`AUDIT-FOCUS ${JSON.stringify(result)}`);
    await testInfo.attach('focus-indicators', {body: JSON.stringify(result, null, 2), contentType: 'application/json'});
  });

  test(`text contrast of visible text (${entry.name})`, async ({page}, testInfo) => {
    await openNavigator(page, entry);
    const samples = await page.evaluate(() => {
      const parse = value => {
        const m = value.match(/rgba?\(([^)]+)\)/);
        if (!m) {
          return null;
        }
        const [r, g, b, a = '1'] = m[1].split(/[ ,/]+/).filter(Boolean);
        return {r: +r, g: +g, b: +b, a: +a};
      };
      const luminance = ({r, g, b}) => {
        const channel = c => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      const background = el => {
        for (let node = el; node; node = node.parentElement) {
          const bg = parse(getComputedStyle(node).backgroundColor);
          if (bg && bg.a > 0) {
            return bg;
          }
        }
        return {r: 255, g: 255, b: 255, a: 1};
      };
      const root = (window as any).__findNavigator();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const seen = new Set();
      const out = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node.parentElement;
        const text = node.textContent.trim();
        if (!text || seen.has(el)) {
          continue;
        }
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (!rect.width || !rect.height || style.visibility === 'hidden' || +style.opacity === 0) {
          continue;
        }
        seen.add(el);
        const fg = parse(style.color);
        const bg = background(el);
        const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
        out.push({
          text: text.slice(0, 60),
          tag: el.tagName.toLowerCase(),
          className: typeof el.className === 'string' ? el.className : '',
          color: style.color,
          background: `rgb(${bg.r}, ${bg.g}, ${bg.b})`,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
        });
      }
      return out;
    });
    const result = {entry: entry.name, browser: testInfo.project.use.browserName, samples};
    console.log(`AUDIT-CONTRAST ${JSON.stringify(result)}`);
    await testInfo.attach('text-contrast', {body: JSON.stringify(result, null, 2), contentType: 'application/json'});
  });
}
