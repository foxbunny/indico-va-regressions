// Records, for either revision of the category navigator, which rows of the category-move
// navigator allow the action and with which message. Category move uses the actionOn rules
// categories.groups ("The category is already here"), categoriesDescendingFrom and
// categoriesWithoutCategoryManagementRights (indico/modules/categories/client/js/management.js).
// Selectors work on both the jQuery UI dialog and the native <dialog>; nothing is skipped on base.

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
});

async function rows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.current-category, .subcategory')]
      .filter(row => row.getClientRects().length)
      .map(row => {
        const action = row.querySelector('.category-action-button, .action-button');
        const tip = action?.querySelector('[data-tip-content]');
        return {
          current: row.classList.contains('current-category'),
          title: (row.querySelector('.title')?.textContent || '').trim(),
          disabled: Boolean(action && (action.disabled || action.classList.contains('disabled'))),
          message: (tip?.textContent || action?.getAttribute('title') || '').trim(),
        };
      })
  );
}

test('category move restrictions per row, including categories.groups', async ({page}, testInfo) => {
  await page.goto(`/category/${manifest.navigatorParentId}/manage/`);
  await page.locator('.category-management tr:has-text("Navigator source") .js-move-category').click();
  await page.locator('.current-category').first().waitFor();
  await waitForStable(page);
  const atParent = await rows(page);
  await page
    .locator('.subcategory:has-text("Navigator source") .category-drill-button, .subcategory.js-go-to:has-text("Navigator source")')
    .first()
    .click();
  await page.locator('.current-category:has-text("Navigator source")').first().waitFor();
  await waitForStable(page);
  const inSource = await rows(page);
  const result = {browser: testInfo.project.use.browserName, atParent, inSource};
  console.log(`AUDIT-ACTIONON ${JSON.stringify(result)}`);
  await testInfo.attach('actionon', {body: JSON.stringify(result, null, 2), contentType: 'application/json'});
});
