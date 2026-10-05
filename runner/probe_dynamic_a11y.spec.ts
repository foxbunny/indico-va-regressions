// Paired browser-visible accessibility states for the public navigator controls.
import {Page, test} from '@playwright/test';

import {ACTION, Recorder, manifest, newCtx, openDisplay, openEventMove, treeRow} from './probe_lib';

test.describe.configure({timeout: 180_000});

async function state(page: Page) {
  const navigator = page.locator('.categorynav:visible').last();
  return {
    navigatorTree: await navigator.count() ? await navigator.ariaSnapshot({timeout: 3000}).catch(() => '') : '',
    dialogs: await page.locator('dialog:visible, .ui-dialog:visible, .ui.modal:visible')
      .allInnerTexts().then(texts => texts.map(text => text.replace(/\s+/g, ' ').slice(0, 350))),
    focus: await page.evaluate(() => ({
      tag: document.activeElement?.tagName.toLowerCase(),
      text: ((document.activeElement as HTMLElement)?.innerText ||
        (document.activeElement as HTMLInputElement)?.value || '').trim().slice(0, 80),
      insideNavigator: Boolean(document.activeElement?.closest('.categorynav')),
    })),
  };
}

async function tabStops(page: Page, count = 12) {
  const stops = [];
  for (let index = 0; index < count; index++) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const computed = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || (el as HTMLInputElement).value || '').trim().slice(0, 60),
        inNavigator: Boolean(el.closest('.categorynav')),
        focusVisible: el.matches(':focus-visible'),
        outline: `${computed.outlineStyle} ${computed.outlineWidth}`,
      };
    }));
  }
  return stops;
}

test('search results, empty results, and HTTP error accessible states', async ({browser}, testInfo) => {
  const rec = new Recorder('dynamic-search-a11y', testInfo);
  const {ctx, page} = await newCtx(browser, 'anonymous');
  rec.watch(page);
  await openDisplay(page);
  await rec.step('results', async () => {
    await page.locator("input[placeholder='Search']").fill('Navigator');
    await page.locator('.search-results-list .item').first().waitFor();
    return {state: await state(page), stops: await tabStops(page)};
  });
  await rec.step('empty', async () => {
    await page.locator("input[placeholder='Search']").fill('NonExistentCategoryQuery');
    await page.locator('.categorynav .placeholder:visible').first().waitFor();
    return {state: await state(page), stops: await tabStops(page)};
  });
  await rec.step('http403', async () => {
    await page.route('**/category/search?*', route => route.fulfill({
      status: 403, contentType: 'application/json',
      body: JSON.stringify({error: {title: 'Injected 403', message: 'probe'}}),
    }));
    await page.locator("input[placeholder='Search']").fill('UniqueErrorProbeQuery');
    await page.getByText('Injected 403').first().waitFor({timeout: 8000});
    return state(page);
  });
  rec.flush();
  await ctx.close();
});

test('loading, move confirmation, and focus return states', async ({browser}, testInfo) => {
  const rec = new Recorder('dynamic-move-a11y', testInfo);
  const {ctx, page} = await newCtx(browser, 'admin');
  rec.watch(page);
  await rec.step('loading', async () => {
    const infoPath = new RegExp(`/category/${manifest.navigatorParentId}/info(?:\\?.*)?$`);
    await page.route(infoPath, async route => {
      await new Promise(resolve => setTimeout(resolve, 1200));
      await route.continue().catch(() => undefined);
    });
    await page.goto(`/category/${manifest.navigatorParentId}/`);
    await page.locator('#navigate-button').click();
    await page.locator('.categorynav:visible .loading, .categorynav:visible .spinner')
      .first().waitFor({timeout: 2000}).catch(() => undefined);
    const during = await state(page);
    await page.locator('.current-category').first().waitFor();
    const after = await state(page);
    await page.unroute(infoPath);
    return {during, after};
  });
  await rec.step('confirmation', async () => {
    await openEventMove(page);
    await page.locator('.current-category .navigate-up').first().click();
    const row = treeRow(page, 'Navigator fixtures');
    await row.hover();
    await row.locator(ACTION).first().click();
    const prompt = page.locator('.ui.modal:visible, .ui-dialog:visible:has-text("Confirm event move")').last();
    await prompt.waitFor();
    return {state: await state(page), promptTree: await prompt.ariaSnapshot(), stops: await tabStops(page, 5)};
  });
  await rec.step('cancel', async () => {
    await page.getByRole('button', {name: 'Cancel', exact: true}).last().click();
    await page.waitForTimeout(300);
    return state(page);
  });
  rec.flush();
  await ctx.close();
});
