// Ad-hoc characterization probes for the category navigator (behavioural evidence).
// Selectors are chosen so that every probe runs unchanged against both revisions.
// Probes never assert; they record observations and write them to ../output/probes/.

import {Browser, BrowserContext, Page, TestInfo, request} from '@playwright/test';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

import {buildStorageStates, loadPersonas} from './auth';
import {installStabilizers} from './stabilize';

export const BASE_URL = process.env.BASE_URL || 'http://indico:8000';
export const manifest = JSON.parse(readFileSync('../output/manifest.json', 'utf8'));
const OUT_DIR = resolve('../output/probes');

export const NAV = '.ui-dialog:visible, #category-navigator';
export const NAV_CONTENT = '.categorynav';
export const SEARCH = "input[placeholder='Search']";
export const ACTION = ':is(.action-button, .category-action-button)';
export const TREE_ROW = '.category-list ul.group-list:not(.search-results-list) > li.subcategory';
export const RESULT_ROW = '.search-results-list .item';

let authReady: Promise<void> | null = null;
export function ensureAuth(): Promise<void> {
  if (!authReady) {
    authReady = buildStorageStates(BASE_URL, loadPersonas()).then(() => undefined);
  }
  return authReady;
}

export async function newCtx(
  browser: Browser,
  persona: 'anonymous' | 'participant' | 'manager' | 'admin',
  viewport = {width: 1280, height: 900},
): Promise<{ctx: BrowserContext; page: Page}> {
  await ensureAuth();
  const storageState = persona === 'anonymous' ? undefined : resolve(`../output/auth/${persona}.json`);
  const ctx = await browser.newContext({
    baseURL: BASE_URL,
    storageState,
    viewport,
    locale: 'en-GB',
    timezoneId: 'UTC',
  });
  const page = await ctx.newPage();
  await installStabilizers(page, '2026-06-15T12:00:00+00:00');
  return {ctx, page};
}

export class Recorder {
  data: Record<string, unknown> = {};
  errors: Record<string, string> = {};
  pageErrors: string[] = [];
  consoleErrors: string[] = [];
  constructor(public name: string, public testInfo: TestInfo) {}

  watch(page: Page) {
    page.on('pageerror', err => this.pageErrors.push(String(err).slice(0, 400)));
    page.on('console', msg => {
      if (msg.type() === 'error') this.consoleErrors.push(msg.text().slice(0, 400));
    });
  }

  set(key: string, value: unknown) {
    this.data[key] = value;
  }

  async step<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      const value = await fn();
      if (value !== undefined) this.data[key] = value;
      return value;
    } catch (err) {
      this.errors[key] = String(err).split('\n').slice(0, 6).join(' | ').slice(0, 600);
      return undefined;
    }
  }

  flush() {
    const browser = this.testInfo.project.use.browserName ?? 'unknown';
    mkdirSync(OUT_DIR, {recursive: true});
    const payload = {
      probe: this.name,
      browser,
      data: this.data,
      step_errors: this.errors,
      page_errors: this.pageErrors,
      console_errors: this.consoleErrors,
    };
    writeFileSync(resolve(OUT_DIR, `${this.name}__${browser}.json`), JSON.stringify(payload, null, 2));
    console.log(`OBS ${this.name} ${browser} ${JSON.stringify(payload)}`);
  }
}

// Element description evaluated in the page (pure DOM read).
export const DESC_FN = `(el) => {
  if (!el) return null;
  const cls = typeof el.className === 'string' ? el.className : '';
  const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
  return {
    tag: el.tagName ? el.tagName.toLowerCase() : String(el),
    id: el.id || undefined,
    cls: cls.slice(0, 100) || undefined,
    type: el.getAttribute && el.getAttribute('type') || undefined,
    value: el.getAttribute && el.getAttribute('value') || undefined,
    href: el.getAttribute ? el.getAttribute('href') : undefined,
    role: el.getAttribute && el.getAttribute('role') || undefined,
    title: el.getAttribute && el.getAttribute('title') || undefined,
    ariaLabel: el.getAttribute && el.getAttribute('aria-label') || undefined,
    tabindex: el.getAttribute ? el.getAttribute('tabindex') : undefined,
    disabled: el.disabled === true ? true : undefined,
    text: ((el.innerText !== undefined ? el.innerText : el.textContent) || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 90),
    inNavigator: !!(el.closest && el.closest('#category-navigator, .categorynav-dialog-content, .categorynav')),
    inNavigatorDialog: !!(el.closest && el.closest('#category-navigator, .ui-dialog:has(.categorynav-dialog-content)')),
    inAnyDialog: !!(el.closest && el.closest('.ui-dialog, dialog, [role=dialog]')),
    rect: r ? {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)} : undefined,
  };
}`;

export async function active(page: Page) {
  return page.evaluate(`(${DESC_FN})(document.activeElement)`);
}

export async function describe(page: Page, selector: string) {
  const loc = page.locator(selector).first();
  if (!(await loc.count())) return null;
  // Pass the description source as an argument and build the function in the page.
  return loc.evaluate((el, src) => new Function(`return ${src}`)()(el), DESC_FN);
}

export async function describeAll(page: Page, selector: string, limit = 30) {
  const loc = page.locator(selector);
  const n = Math.min(await loc.count(), limit);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(await loc.nth(i).evaluate((el, src) => new Function(`return ${src}`)()(el), DESC_FN));
  }
  return out;
}

export async function dialogs(page: Page) {
  return page.evaluate(() => {
    const vis = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    return [...document.querySelectorAll('.ui-dialog, dialog, [role=dialog], [role=alertdialog], .ui.modal')].map(d => ({
      tag: d.tagName.toLowerCase(),
      id: d.id || undefined,
      cls: (d.className || '').toString().slice(0, 80),
      role: d.getAttribute('role') || undefined,
      ariaModal: d.getAttribute('aria-modal') || undefined,
      ariaLabelledby: d.getAttribute('aria-labelledby') || undefined,
      ariaDescribedby: d.getAttribute('aria-describedby') || undefined,
      open: (d as HTMLDialogElement).open,
      isModal: d.matches(':modal'),
      visible: vis(d),
      heading: (d.querySelector('h1,h2,h3,.ui-dialog-title,.header') as HTMLElement | null)?.innerText?.trim().slice(0, 80),
      containsNavigator: !!d.querySelector('.categorynav'),
    }));
  });
}

export async function navigatorCount(page: Page) {
  return page.evaluate(() => {
    const vis = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const els = [...document.querySelectorAll('.categorynav')];
    return {inDom: els.length, visible: els.filter(vis).length};
  });
}

export async function visibleTooltips(page: Page) {
  return page.evaluate(() => {
    const vis = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    };
    const out: string[] = [];
    document.querySelectorAll('.qtip').forEach(q => {
      if (vis(q) && q.getAttribute('aria-hidden') !== 'true') out.push(`qtip:${(q as HTMLElement).innerText.trim()}`);
    });
    document.querySelectorAll('ind-with-tooltip[shown] [data-tip-content]').forEach(t => {
      out.push(`ind-with-tooltip:${(t as HTMLElement).innerText.trim()}`);
    });
    document.querySelectorAll('[role=tooltip]').forEach(t => {
      if (vis(t)) out.push(`role-tooltip:${(t as HTMLElement).innerText.trim()}`);
    });
    return out;
  });
}

// Chromium only: accessibility node of the element returned by a JS expression.
export async function axOf(page: Page, expression: string) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.getDocument', {depth: 0});
    const {result} = await cdp.send('Runtime.evaluate', {expression});
    if (!result.objectId) return null;
    const {nodeId} = await cdp.send('DOM.requestNode', {objectId: result.objectId});
    const {nodes} = await cdp.send('Accessibility.getPartialAXTree', {nodeId, fetchRelatives: false});
    const n: any = nodes[0];
    if (!n) return null;
    const props: Record<string, unknown> = {};
    for (const p of n.properties ?? []) props[p.name] = p.value?.value;
    return {
      ignored: n.ignored,
      role: n.role?.value,
      name: n.name?.value,
      description: n.description?.value,
      props,
    };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// Chromium only: dialog and heading nodes of the whole page AX tree.
export async function axDialogsAndHeadings(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Accessibility.enable');
    const {nodes} = await cdp.send('Accessibility.getFullAXTree');
    const pick = (n: any) => {
      const props: Record<string, unknown> = {};
      for (const p of n.properties ?? []) props[p.name] = p.value?.value;
      return {role: n.role?.value, name: n.name?.value, description: n.description?.value, props};
    };
    return {
      dialogs: (nodes as any[]).filter(n => !n.ignored && ['dialog', 'alertdialog'].includes(n.role?.value)).map(pick),
      headings: (nodes as any[]).filter(n => !n.ignored && n.role?.value === 'heading').map(pick),
    };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

export async function ariaSnapshot(page: Page, selector: string) {
  const loc = page.locator(selector).first();
  if (!(await loc.count())) return null;
  return loc.ariaSnapshot({timeout: 5000});
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function waitNavigator(page: Page) {
  await page.locator('.current-category').first().waitFor({state: 'visible', timeout: 20_000});
  await page.waitForTimeout(700);
}

// --- entry points ---------------------------------------------------------

export async function openDisplay(page: Page, categoryId: number = manifest.navigatorParentId) {
  await page.goto(`/category/${categoryId}/`);
  await page.locator('#navigate-button').click();
  await waitNavigator(page);
}

export async function openCategoryMove(page: Page) {
  await page.goto(`/category/${manifest.navigatorParentId}/manage/`);
  await page.locator('.category-management tr:has-text("Navigator source") .js-move-category').click();
  await waitNavigator(page);
}

export async function openCategoryBulkMove(page: Page) {
  await page.goto(`/category/${manifest.navigatorParentId}/manage/`);
  await page.locator("input[name='category_id']").nth(0).click();
  await page.locator("input[name='category_id']").nth(1).click();
  await page.locator('.js-bulk-move-category').click();
  await waitNavigator(page);
}

export async function openEventMove(page: Page) {
  await page.goto(`/event/${manifest.conferenceEventId}/manage/`);
  await page.locator('#event-action-menu-actions-target').click();
  await page.locator("[title='Move event to another category']").first().click();
  await waitNavigator(page);
}

export async function openEventBulkMove(page: Page) {
  await page.goto(`/category/${manifest.childCategoryId}/manage/`);
  await page.locator("input[name='event_id']").nth(0).click();
  await page.locator('#js-move-events-to-subcategory-container .icon-transmission').click();
  await waitNavigator(page);
}

export async function openPublish(page: Page) {
  await page.goto(`/event/${manifest.regformEventId}/manage/`);
  await page.locator("[title='Publish event to a category']").click();
  await waitNavigator(page);
}

export async function openCreation(page: Page) {
  await page.goto('/#create-event:lecture');
  await page.locator('#categorynav-button-event-creation-category').click();
  await waitNavigator(page);
}

export async function openCloneWizardStep3(page: Page) {
  await page.goto(`/event/${manifest.conferenceEventId}/manage/`);
  await page.locator('button[data-ajax-dialog][title="Clone event"]').click();
  await page.locator("input[name='repeatability'][value='once']").click();
  await page.locator("button[name='step'][value='2']").click();
  await page.locator("button[name='step'][value='3']").click();
  await page.locator('#categorynav-button-category').waitFor({state: 'visible'});
}

export async function openClone(page: Page) {
  await openCloneWizardStep3(page);
  await page.locator('#categorynav-button-category').click();
  await waitNavigator(page);
}

export async function openTemplateCloneDialog(page: Page) {
  await page.goto(`/category/${manifest.navigatorParentId}/manage/designer/`);
  await page.locator("[data-href$='/clone']").first().click();
  await page.locator('#categorynav-button-category').waitFor({state: 'visible'});
}

export async function openTemplate(page: Page) {
  await openTemplateCloneDialog(page);
  await page.locator('#categorynav-button-category').click();
  await waitNavigator(page);
}

// Row helpers that work on both revisions.
export function treeRow(page: Page, title: string) {
  return page.locator(`${TREE_ROW}:has(.title:text-is("${title}"))`).first();
}

export async function drillInto(page: Page, title: string) {
  // base: click on the li.js-go-to row; changed: click the drill button.
  const row = treeRow(page, title);
  await row.locator('.title').first().click();
}

export async function clickRowAction(page: Page, rowLocator: ReturnType<Page['locator']>) {
  await rowLocator.hover();
  await rowLocator.locator(ACTION).first().click();
}

export function captureRequests(page: Page) {
  const log: {t: number; method: string; url: string; body?: string | null}[] = [];
  const t0 = Date.now();
  page.on('request', req => {
    const url = req.url();
    if (/\/category\/(\d+\/info(-from)?|search)|\/move|\/category\/\d+\/manage\/move/.test(url) || req.resourceType() === 'document') {
      log.push({t: Date.now() - t0, method: req.method(), url: url.replace(BASE_URL, ''), body: req.postData()});
    }
  });
  return log;
}

export async function delayRoute(page: Page, predicate: (url: URL) => boolean, ms: number, fulfillWith?: {status: number; body: string}) {
  await page.route(predicate, async route => {
    await sleep(ms);
    try {
      if (fulfillWith) {
        await route.fulfill({status: fulfillWith.status, contentType: 'application/json', body: fulfillWith.body});
      } else {
        const response = await route.fetch();
        await route.fulfill({response});
      }
    } catch {
      // request aborted by the page
    }
  });
}
