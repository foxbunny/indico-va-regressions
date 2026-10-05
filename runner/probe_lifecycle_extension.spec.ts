// Paired probes for category-count dismissal and a shared tooltip reconnect.
import {test} from '@playwright/test';

import {Recorder, manifest, newCtx, openDisplay} from './probe_lib';

test.describe.configure({timeout: 180_000});

test('category statistics input and dismissal lifecycle', async ({browser}, testInfo) => {
  const rec = new Recorder('category-stats-lifecycle', testInfo);
  const {ctx, page} = await newCtx(browser, 'admin');
  rec.watch(page);
  await openDisplay(page, manifest.navigatorParentId);
  const details = page.locator('.subcategory .stats-details').first();
  const summary = details.locator('> summary');
  const legacy = page.locator('.subcategory .stats.icon-list').first();
  const state = async () => ({
    nativeDisclosure: await details.count() > 0,
    open: await details.count() ? await details.evaluate(el => (el as HTMLDetailsElement).open) : null,
    legacyTitle: await legacy.count() ? await legacy.getAttribute('title') : null,
    activeTag: await page.evaluate(() => document.activeElement?.tagName.toLowerCase()),
    navigatorVisible: await page.locator('.categorynav:visible').count() > 0,
  });
  await rec.step('initial', state);
  if (await details.count()) {
    await rec.step('click-open', async () => {
      await summary.click();
      return state();
    });
    await rec.step('scroll', async () => {
      await page.mouse.wheel(0, 160);
      await page.waitForTimeout(200);
      return state();
    });
    await rec.step('escape', async () => {
      await summary.focus();
      await page.keyboard.press('Escape');
      return state();
    });
    await rec.step('keyboard-space', async () => {
      await summary.focus();
      await page.keyboard.press('Space');
      return state();
    });
    await rec.step('outside-pointer', async () => {
      await page.locator('.current-category .title').first().click();
      return state();
    });
    await rec.step('focus-departure', async () => {
      await summary.focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      return state();
    });
  } else {
    await rec.step('legacy-hover', async () => {
      await legacy.hover();
      return state();
    });
    await rec.step('legacy-keyboard', async () => {
      await legacy.focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('Escape');
      return state();
    });
  }
  rec.flush();
  await ctx.close();
});

test('sibling tooltip disconnect and reconnect', async ({browser}, testInfo) => {
  const rec = new Recorder('sibling-tooltip-reconnect', testInfo);
  const {ctx, page} = await newCtx(browser, 'anonymous');
  rec.watch(page);
  await page.goto('/');
  const tip = page.locator('#category-calendar-link ind-with-tooltip');
  await rec.step('initial-hover', async () => {
    await tip.hover();
    await page.waitForTimeout(800);
    return {shown: await tip.getAttribute('shown'), text: await tip.innerText()};
  });
  await rec.step('disconnect-reconnect', async () => {
    await tip.evaluate(el => {
      const parent = el.parentNode;
      const next = el.nextSibling;
      el.remove();
      parent?.insertBefore(el, next);
    });
    return {connected: await tip.evaluate(el => el.isConnected), shown: await tip.getAttribute('shown')};
  });
  await rec.step('reconnected-hover', async () => {
    await page.mouse.move(5, 5);
    await tip.hover();
    await page.waitForTimeout(800);
    return {shown: await tip.getAttribute('shown'), text: await tip.innerText()};
  });
  rec.flush();
  await ctx.close();
});
