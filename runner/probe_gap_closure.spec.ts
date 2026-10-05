// Paired public-interface probes for previously unobserved navigator paths.
import {test} from '@playwright/test';

import {
  ACTION, Recorder, manifest, newCtx, openDisplay, openEventBulkMove, treeRow,
} from './probe_lib';

test.describe.configure({timeout: 180_000});

test('display action ordinary and modified activation', async ({browser}, testInfo) => {
  const rec = new Recorder('display-action-destination', testInfo);
  const {ctx, page} = await newCtx(browser, 'anonymous');
  rec.watch(page);
  await rec.step('ordinary', async () => {
    await openDisplay(page);
    const row = treeRow(page, 'Navigator destination');
    await row.hover();
    const action = row.locator(ACTION).first();
    const element = await action.evaluate(el => ({tag: el.tagName.toLowerCase(), href: el.getAttribute('href')}));
    await action.click();
    await page.waitForURL(new RegExp(`/category/${manifest.navigatorDestinationId}/`), {timeout: 10_000});
    return {element, url: page.url(), heading: await page.locator('h1').first().innerText()};
  });
  await rec.step('modified', async () => {
    await openDisplay(page);
    const row = treeRow(page, 'Navigator destination');
    await row.hover();
    const action = row.locator(ACTION).first();
    const element = await action.evaluate(el => ({tag: el.tagName.toLowerCase(), href: el.getAttribute('href')}));
    const popupPromise = ctx.waitForEvent('page', {timeout: 3000}).catch(() => null);
    await action.click({modifiers: ['Control']});
    const popup = await popupPromise;
    if (popup) {
      await popup.waitForURL(new RegExp(`/category/${manifest.navigatorDestinationId}/`), {timeout: 10_000})
        .catch(() => undefined);
    }
    return {element, currentUrl: page.url(), popupUrl: popup?.url() ?? null};
  });
  rec.flush();
  await ctx.close();
});

test('public widget deferred onAction boundary', async ({browser}, testInfo) => {
  const rec = new Recorder('deferred-widget-action', testInfo);
  const {ctx, page} = await newCtx(browser, 'admin');
  rec.watch(page);
  await page.goto(`/category/${manifest.navigatorParentId}/`);
  await rec.step('open', async () => {
    await page.evaluate(category => {
      (window as any).__callbackProbe = {events: []};
      const host = document.createElement('div');
      document.body.appendChild(host);
      (window as any).__callbackProbe.host = host;
      (window as any).jQuery(host).categorynavigator({
        category,
        openInDialog: true,
        onAction(selected) {
          (window as any).__callbackProbe.events.push(`callback:${selected.id}`);
          const deferred = (window as any).jQuery.Deferred();
          (window as any).__callbackProbe.deferred = deferred;
          return deferred.promise();
        },
      });
    }, manifest.navigatorParentId);
    await page.locator('.categorynav:visible .current-category').first().waitFor();
    return page.evaluate(() => ({
      events: (window as any).__callbackProbe.events,
      dialogs: document.querySelectorAll('dialog[open], .ui-dialog').length,
    }));
  });
  await rec.step('selection', async () => {
    const row = treeRow(page, 'Navigator destination');
    await row.hover();
    await row.locator(ACTION).first().click();
    await page.waitForTimeout(200);
    return page.evaluate(() => ({
      events: [...(window as any).__callbackProbe.events],
      deferredState: (window as any).__callbackProbe.deferred?.state(),
      navigatorVisible: [...document.querySelectorAll('.categorynav')].some(el =>
        (el as HTMLElement).getBoundingClientRect().width > 0),
    }));
  });
  await rec.step('resolve', async () => {
    await page.evaluate(() => {
      (window as any).__callbackProbe.events.push('resolve');
      (window as any).__callbackProbe.deferred?.resolve();
    });
    await page.waitForTimeout(500);
    return page.evaluate(() => ({
      events: [...(window as any).__callbackProbe.events],
      navigatorVisible: [...document.querySelectorAll('.categorynav')].some(el =>
        (el as HTMLElement).getBoundingClientRect().width > 0),
    }));
  });
  rec.flush();
  await ctx.close();
});

test('public widget rejected onAction boundary', async ({browser}, testInfo) => {
  const rec = new Recorder('rejected-widget-action', testInfo);
  const {ctx, page} = await newCtx(browser, 'admin');
  rec.watch(page);
  await page.goto(`/category/${manifest.navigatorParentId}/`);
  await rec.step('open', async () => {
    await page.evaluate(category => {
      (window as any).__rejectProbe = {events: []};
      const host = document.createElement('div');
      document.body.appendChild(host);
      (window as any).jQuery(host).categorynavigator({
        category,
        openInDialog: true,
        onAction(selected) {
          (window as any).__rejectProbe.events.push(`callback:${selected.id}`);
          const deferred = (window as any).jQuery.Deferred();
          (window as any).__rejectProbe.deferred = deferred;
          return deferred.promise();
        },
      });
    }, manifest.navigatorParentId);
    await page.locator('.categorynav:visible .current-category').first().waitFor();
    return page.evaluate(() => ({events: (window as any).__rejectProbe.events}));
  });
  await rec.step('selection', async () => {
    const row = treeRow(page, 'Navigator destination');
    await row.hover();
    await row.locator(ACTION).first().click();
    await page.waitForTimeout(200);
    return page.evaluate(() => ({
      events: [...(window as any).__rejectProbe.events],
      deferredState: (window as any).__rejectProbe.deferred?.state(),
      navigatorVisible: [...document.querySelectorAll('.categorynav')].some(el =>
        (el as HTMLElement).getBoundingClientRect().width > 0),
    }));
  });
  await rec.step('reject', async () => {
    await page.evaluate(() => {
      (window as any).__rejectProbe.events.push('reject');
      (window as any).__rejectProbe.deferred?.reject('probe-rejection');
    });
    await page.waitForTimeout(500);
    return page.evaluate(() => ({
      events: [...(window as any).__rejectProbe.events],
      deferredState: (window as any).__rejectProbe.deferred?.state(),
      navigatorVisible: [...document.querySelectorAll('.categorynav')].some(el =>
        (el as HTMLElement).getBoundingClientRect().width > 0),
    }));
  });
  rec.flush();
  await ctx.close();
});

test('role access and real denied management routes', async ({browser}, testInfo) => {
  const rec = new Recorder('role-authorization-matrix', testInfo);
  for (const persona of ['anonymous', 'participant', 'manager', 'admin'] as const) {
    await rec.step(persona, async () => {
      const {ctx, page} = await newCtx(browser, persona);
      rec.watch(page);
      const routes = [];
      for (const path of [
        `/category/${manifest.navigatorParentId}/`,
        `/category/${manifest.navigatorParentId}/manage/`,
        `/event/${manifest.conferenceEventId}/manage/`,
      ]) {
        const response = await page.goto(path);
        routes.push({path, status: response?.status(), finalUrl: page.url(),
          navigatorTrigger: await page.locator('#navigate-button').count(),
          moveControls: await page.locator('.js-move-category, #event-action-menu-actions-target').count()});
      }
      await ctx.close();
      return routes;
    });
  }
  rec.flush();
});

test('bulk event move confirmed result', async ({browser}, testInfo) => {
  const rec = new Recorder('bulk-event-move-submit', testInfo);
  const {ctx, page} = await newCtx(browser, 'admin');
  rec.watch(page);
  const posts = [];
  page.on('response', response => {
    if (response.request().method() === 'POST' && !response.url().includes('info-from')) {
      posts.push({url: response.url(), status: response.status(), body: response.request().postData()});
    }
  });
  await rec.step('open', async () => {
    await openEventBulkMove(page);
    return {url: page.url(), title: await page.locator('.current-category .title').first().innerText(),
      rows: await page.locator('.subcategory .title').allInnerTexts()};
  });
  await rec.step('confirm', async () => {
    const navigator = page.locator('.categorynav:visible').last();
    while (!(await navigator.locator('.subcategory:has(.title:text-is("Navigator fixtures"))').count()) &&
           await navigator.locator('.current-category .navigate-up').count()) {
      await navigator.locator('.current-category .navigate-up').first().click();
      await page.waitForTimeout(400);
    }
    const row = treeRow(page, 'Navigator fixtures');
    await row.hover();
    await row.locator(ACTION).first().click();
    const modal = page.locator('.ui.modal:visible');
    const prompt = await modal.count() ? modal : page.locator('.ui-dialog:visible').last();
    const promptText = await prompt.innerText().catch(() => '');
    await prompt.getByRole('button', {name: /Confirm|OK|Yes|Move/}).first().click();
    await page.waitForTimeout(2500);
    return {promptText, url: page.url(), posts, bodyText: (await page.locator('body').innerText()).slice(0, 300)};
  });
  rec.flush();
  await ctx.close();
});

test('bulk category move confirmed result', async ({browser}, testInfo) => {
  const rec = new Recorder('bulk-category-move-submit', testInfo);
  const {ctx, page} = await newCtx(browser, 'admin');
  rec.watch(page);
  const posts = [];
  page.on('response', response => {
    if (response.request().method() === 'POST' && !response.url().includes('info-from')) {
      posts.push({url: response.url(), status: response.status(), body: response.request().postData()});
    }
  });
  await rec.step('open', async () => {
    await page.goto(`/category/${manifest.navigatorParentId}/manage/`);
    for (const name of ['Navigator source', 'Navigator private']) {
      await page.locator(`.category-management tr:has-text("${name}") input[name='category_id']`).first().click();
    }
    await page.locator('.js-bulk-move-category').click();
    await page.locator('.current-category').first().waitFor();
    return {selected: ['Navigator source', 'Navigator private'],
      title: await page.locator('.current-category .title').first().innerText()};
  });
  await rec.step('confirm', async () => {
    const row = treeRow(page, 'Navigator destination');
    await row.hover();
    await row.locator(ACTION).first().click();
    const modal = page.locator('.ui.modal:visible');
    const prompt = await modal.count() ? modal : page.locator('.ui-dialog:visible').last();
    const promptText = await prompt.innerText().catch(() => '');
    await prompt.getByRole('button', {name: /Confirm|OK|Yes|Move/}).first().click();
    await page.waitForTimeout(2500);
    return {promptText, url: page.url(), posts,
      bodyText: (await page.locator('body').innerText()).slice(0, 300)};
  });
  rec.flush();
  await ctx.close();
});
