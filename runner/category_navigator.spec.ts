import {expect, test} from '@playwright/test';
import {readFileSync} from 'node:fs';

import {installStabilizers, waitForStable} from './stabilize';

const manifest = JSON.parse(readFileSync('../output/manifest.json', 'utf8'));
const baseline = process.env.NAVIGATOR_BASELINE === '1';
test.use({
  baseURL: process.env.BASE_URL || 'http://indico:8000',
  storageState: '../output/auth/admin.json',
  viewport: {width: 1280, height: 900},
});

test.beforeEach(async ({page}) => {
  await installStabilizers(page, '2026-06-15T12:00:00+00:00');
});

async function openCategoryMove(page) {
  await page.goto(`/category/${manifest.navigatorParentId}/manage/`);
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.category-management tr:has-text("Navigator source") .js-move-category').click();
  await expect(page.locator('.current-category')).toBeVisible();
}

test('category move geometry', async ({page}, testInfo) => {
  await openCategoryMove(page);
  await waitForStable(page);
  const dialog = page.locator(baseline ? '.ui-dialog:visible' : '#category-navigator');
  const geometry = {
    dialog: await dialog.boundingBox(),
    list: await page.locator('.category-list').boundingBox(),
    row: await page.locator('.current-category').boundingBox(),
    subtitle: await page.getByText('Select new category parent for the category', {exact: true}).boundingBox(),
  };
  console.log(JSON.stringify({baseline, browser: testInfo.project.use.browserName, geometry}));
  await testInfo.attach('geometry', {body: JSON.stringify(geometry, null, 2), contentType: 'application/json'});
});

test('native modality, whole-dialog focus, keyboard containment and Escape restoration', async ({page, browserName}) => {
  test.skip(baseline);
  await page.goto(`/category/${manifest.navigatorParentId}/`);
  await page.locator('#navigate-button').click();
  const dialog = page.locator('#category-navigator');
  await expect(page.locator('#category-navigator:modal')).toBeVisible();
  await expect(dialog).toBeFocused();
  await page.locator('#navigate-button').evaluate((el: HTMLElement) => el.focus());
  await expect(dialog).toBeFocused();
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    const {nodes} = await cdp.send('Accessibility.getFullAXTree');
    const node = nodes.find(n => n.role?.value === 'dialog');
    expect(node?.properties?.some(p => p.name === 'modal' && p.value.value === true)).toBe(true);
    await cdp.detach();
  }
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press(i < 12 ? 'Tab' : 'Shift+Tab');
    expect(await page.evaluate(() => document.activeElement === document.body ||
      Boolean(document.activeElement?.closest('#category-navigator')))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#navigate-button')).toBeFocused();
});

test('category confirmation cancel and Escape restore the native modal', async ({page}) => {
  test.skip(baseline);
  await openCategoryMove(page);
  for (const cancelWithEscape of [false, true]) {
    await page.locator('.subcategory:has-text("Navigator destination") .category-action-button').click();
    const prompt = page.locator('.ui-dialog:has-text("Confirm action")');
    await expect(prompt).toBeVisible();
    await expect(page.locator('#category-navigator')).toBeHidden();
    if (cancelWithEscape) {
      await page.keyboard.press('Escape');
    } else {
      await prompt.getByRole('button', {name: 'Cancel', exact: true}).click();
    }
    await expect(page.locator('#category-navigator:modal')).toBeFocused();
  }
  await page.locator('.close-bar-button').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#category-navigator')).toHaveCount(0);
});

test('Escape closes nested picker without closing the event clone form', async ({page}) => {
  test.skip(baseline);
  await page.goto(`/event/${manifest.conferenceEventId}/manage/`);
  await page.locator('button[data-ajax-dialog][title="Clone event"]').click();
  await page.locator('input[name="repeatability"][value="once"]').click();
  await page.locator('button[name="step"][value="2"]').click();
  await page.locator('button[name="step"][value="3"]').click();
  const trigger = page.locator('#categorynav-button-category');
  await trigger.click();
  await expect(page.locator('#category-navigator:modal')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#category-navigator')).toHaveCount(0);
  await expect(trigger).toBeVisible();
  await expect(trigger).toBeFocused();
});

test('event move confirmation remains actionable after leaving the native modal', async ({page}) => {
  test.skip(baseline);
  await page.goto(`/event/${manifest.conferenceEventId}/manage/`);
  await page.locator('#event-action-menu-actions-target').click();
  await page.locator('[title="Move event to another category"]').first().click();
  await page.locator('.navigate-up').click();
  await page.locator('.subcategory:has-text("Navigator fixtures") .category-action-button').click();
  const prompt = page.locator('.ui.modal:has-text("Confirm event move")');
  await expect(prompt).toBeVisible();
  await expect(page.locator('#category-navigator')).toHaveCount(0);
  await prompt.getByRole('button', {name: 'Confirm', exact: true}).click({trial: true});
  await prompt.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(prompt).toBeHidden();
});

test('parent Space activation preserves header height and backdrop click closes', async ({page}) => {
  test.skip(baseline);
  await page.goto(`/category/${manifest.navigatorParentId}/`);
  await page.locator('#navigate-button').click();
  await expect(page.locator('.current-category .breadcrumbs')).toBeVisible();
  const childRow = await page.locator('.current-category').boundingBox();
  const titleBox = await page.locator('.current-category > .title-wrapper').boundingBox();
  const parentButton = page.locator('.navigate-up');
  const parentBox = await parentButton.boundingBox();
  expect(Math.abs(parentBox!.height - titleBox!.height)).toBeLessThan(0.1);
  await parentButton.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.current-category h3')).toHaveText('Indico Visual Regression Root');
  await expect(page.locator('.current-category .breadcrumbs')).toHaveCount(0);
  const rootRow = await page.locator('.current-category').boundingBox();
  expect(Math.abs(rootRow!.height - childRow!.height)).toBeLessThan(1);
  await page.mouse.click(10, 450);
  await expect(page.locator('#category-navigator')).toHaveCount(0);
});

test('stats info disclosure toggles by click and keyboard and Escape keeps the dialog open', async ({page, browserName}) => {
  test.skip(baseline);
  await page.goto(`/category/${manifest.navigatorParentId}/`);
  await page.locator('#navigate-button').click();
  const details = page.locator('.subcategory .stats-details').first();
  const summary = details.locator('> summary');
  const content = details.locator('.stats-details-content');
  await expect(summary).toHaveAccessibleName('Category statistics');
  await expect(content).toBeHidden();

  await summary.click();
  await expect(details).toHaveAttribute('open', '');
  await expect(details).toHaveAttribute('data-positioned', '');
  await expect(content).toHaveCSS('opacity', '1');
  await expect(content).toHaveText(/\d+ categor(y|ies)\d+ events?/);
  const summaryBox = await summary.boundingBox();
  const contentBox = await content.boundingBox();
  expect(Math.abs(contentBox!.y + contentBox!.height - summaryBox!.y)).toBeLessThan(1);
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    const {nodes} = await cdp.send('Accessibility.getFullAXTree');
    const node = nodes.find(n => n.name?.value === 'Category statistics' && !n.ignored);
    expect(node?.properties?.some(p => p.name === 'expanded' && p.value.value === true)).toBe(true);
    await cdp.detach();
  }
  await summary.click();
  await expect(details).not.toHaveAttribute('open', '');

  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(details).toHaveAttribute('open', '');
  await page.keyboard.press('Enter');
  await expect(details).not.toHaveAttribute('open', '');

  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(details).not.toHaveAttribute('open', '');
  await expect(page.locator('#category-navigator:modal')).toBeVisible();
  await expect(summary).toBeFocused();

  await summary.click();
  await expect(details).toHaveAttribute('open', '');
  await page.locator('#category-navigator h3').first().click();
  await expect(details).not.toHaveAttribute('open', '');

  // Firefox and Safari on macOS do not focus the summary on click
  await summary.click();
  await summary.evaluate((el: HTMLElement) => el.blur());
  await expect(details).toHaveAttribute('open', '');
  await content.click();
  await expect(details).toHaveAttribute('open', '');
  await page.locator('.subcategory .stats > span[aria-hidden="true"]:not(.icon-list)').nth(1).click();
  await expect(details).not.toHaveAttribute('open', '');
});

test('focus stays in the navigator when the activated control disappears', async ({page}) => {
  test.skip(baseline);
  await page.goto(`/category/${manifest.navigatorParentId}/`);
  await page.locator('#navigate-button').click();
  const dialog = page.locator('#category-navigator');
  const focusInsideDialog = () =>
    page.evaluate(() => document.getElementById('category-navigator').contains(document.activeElement));

  await dialog.locator('.category-drill-button:has-text("Navigator destination")').click();
  await expect(dialog.locator('.current-category .title')).toHaveText('Navigator destination');
  expect(await focusInsideDialog()).toBe(true);

  await dialog.locator('.placeholder-actions button:has-text("navigate up")').click();
  await expect(dialog.locator('.current-category .title')).toHaveText('Navigator fixtures');
  expect(await focusInsideDialog()).toBe(true);
});

test('Tab and Shift+Tab wrap inside the navigator', async ({page}) => {
  test.skip(baseline);
  await page.goto(`/category/${manifest.navigatorParentId}/`);
  await page.locator('#navigate-button').click();
  const dialog = page.locator('#category-navigator');
  await expect(dialog).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(dialog.locator('.close-bar-button')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.locator('button[value="close"]')).toBeFocused();
});

test('a rejected action after confirmation brings the navigator back', async ({page}) => {
  test.skip(baseline);
  await page.goto(`/category/${manifest.navigatorParentId}/`);
  await page.evaluate(parentId => {
    $('<div>').categorynavigator({
      openInDialog: true,
      category: parentId,
      confirmation: true,
      onAction: () => $.Deferred().reject(),
    });
  }, manifest.navigatorParentId);
  const dialog = page.locator('#category-navigator');
  await dialog.locator('.subcategory:has-text("Navigator destination") .category-action-button').click();
  await page.locator('.ui-dialog:visible button:has-text("OK")').click();
  await expect(page.locator('#category-navigator:modal')).toBeVisible();
});
