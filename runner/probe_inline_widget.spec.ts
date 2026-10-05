import {test} from '@playwright/test';

import {manifest, newCtx, Recorder} from './probe_lib';

test('public inline categorynavigator widget API', async ({browser}, testInfo) => {
  const {ctx, page} = await newCtx(browser, 'admin');
  const rec = new Recorder('inline-widget-api', testInfo);
  rec.watch(page);
  await page.goto(`/category/${manifest.navigatorParentId}/`);
  rec.set('widgetAvailable', await page.evaluate(() => typeof (window as any).jQuery.fn.categorynavigator));
  await rec.step('create', async () => {
    await page.evaluate(categoryId => {
      const host = document.createElement('div');
      host.id = 'inline-navigator-probe';
      document.body.appendChild(host);
      (window as any).jQuery(host).categorynavigator({category: categoryId, openInDialog: false});
    }, manifest.navigatorParentId);
    await page.locator('#inline-navigator-probe .current-category').waitFor();
    return page.locator('#inline-navigator-probe').evaluate(host => ({
      htmlClass: host.firstElementChild?.className,
      category: host.querySelector('.current-category')?.textContent?.trim().slice(0, 120),
      dialogCount: host.querySelectorAll('dialog, [role=dialog]').length,
    }));
  });
  await rec.step('goToCategory', async () => {
    await page.evaluate(categoryId => {
      (window as any).jQuery('#inline-navigator-probe').categorynavigator('goToCategory', categoryId);
    }, manifest.navigatorDestinationId);
    await page.waitForFunction(() =>
      document.querySelector('#inline-navigator-probe .current-category .title')?.textContent?.includes('Navigator destination')
    );
    return page.locator('#inline-navigator-probe .current-category .title').first().innerText();
  });
  await rec.step('searchCategories', async () => {
    await page.evaluate(() => {
      (window as any).jQuery('#inline-navigator-probe').categorynavigator('searchCategories', 'Navigator');
    });
    await page.locator('#inline-navigator-probe .search-results-list .item').first().waitFor();
    return page.locator('#inline-navigator-probe').evaluate(host => ({
      input: (host.querySelector("input[placeholder='Search']") as HTMLInputElement)?.value,
      resultCount: host.querySelectorAll('.search-results-list .item').length,
    }));
  });
  await rec.step('destroy', async () => {
    await page.evaluate(() => {
      (window as any).jQuery('#inline-navigator-probe').categorynavigator('destroy');
    });
    return page.locator('#inline-navigator-probe').evaluate(host => ({
      childCount: host.children.length,
      navigatorCount: host.querySelectorAll('.categorynav').length,
    }));
  });
  rec.flush();
  await ctx.close();
});
