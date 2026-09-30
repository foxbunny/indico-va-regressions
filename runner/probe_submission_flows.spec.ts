// Paired host-form probes for category choices made through the navigator.
// Run each test on a fresh seeded stack when comparing database outcomes.
import {Page, test} from '@playwright/test';

import {
  ACTION, Recorder, manifest, newCtx, openCloneWizardStep3, openTemplateCloneDialog, waitNavigator,
} from './probe_lib';

test.describe.configure({timeout: 240_000});

async function selectDestination(page: Page, trigger = '#categorynav-button-category', field = '#category') {
  await page.locator(trigger).click();
  await waitNavigator(page);
  const navigator = page.locator('.categorynav:visible').last();
  const fixtures = navigator.locator('.subcategory:has(.title:text-is("Navigator fixtures"))');
  for (let i = 0; i < 5; i++) {
    if (await fixtures.waitFor({state: 'visible', timeout: 5000}).then(() => true, () => false)) {
      break;
    }
    const up = navigator.locator('.current-category .navigate-up:visible');
    if (!(await up.count())) {
      throw new Error('Navigator fixtures was not found and there is no parent category');
    }
    await up.first().click({timeout: 10000});
  }
  if (!(await fixtures.isVisible())) {
    throw new Error('Navigator fixtures was not found after navigating up');
  }
  await fixtures.locator('.title').first().click({timeout: 10000});
  const destination = navigator.locator('.subcategory:has(.title:text-is("Navigator destination"))');
  await destination.hover({timeout: 10000});
  await destination.locator(ACTION).first().click({timeout: 10000});
  return page.locator(field).inputValue();
}

test('event creation submission after category selection', async ({browser}, testInfo) => {
  const rec = new Recorder('event-creation-submit', testInfo);
  const {ctx, page} = await newCtx(browser, 'admin');
  rec.watch(page);
  await rec.step('submission', async () => {
    await page.goto('/#create-event:conference');
    await page.locator('#categorynav-button-event-creation-category').waitFor({state: 'visible'});
    const selectedCategory = await selectDestination(page, '#categorynav-button-event-creation-category',
      '#event-creation-category');
    const form = page.getByRole('dialog', {name: 'Create new conference'}).locator('form');
    const action = await form.evaluate(el => (el as HTMLFormElement).action);
    await form.locator('input[name="event-creation-title"]').fill('Navigator submission probe');
    const responsePromise = page.waitForResponse(r => r.request().method() === 'POST' && r.url() === action);
    await form.locator('input[type="submit"]').click();
    const response = await responsePromise;
    await page.waitForURL(/\/event\/\d+\/manage\/?/, {timeout: 10000}).catch(() => undefined);
    return {
      selectedCategory, action, postStatus: response.status(), postUrl: response.url(),
      postBody: response.request().postData(), responseBody: (await response.text().catch(() => '')).slice(0, 600),
      pageUrl: page.url(),
    };
  });
  rec.flush();
  await ctx.close();
});

test('event clone submission after category selection', async ({browser}, testInfo) => {
  const rec = new Recorder('event-clone-submit', testInfo);
  const {ctx, page} = await newCtx(browser, 'admin');
  rec.watch(page);
  await rec.step('submission', async () => {
    await openCloneWizardStep3(page);
    const selectedCategory = await selectDestination(page);
    await page.locator('button[name="step"][value="4"]').click();
    const finalButton = page.locator('button[name="step"][value="5"]');
    await finalButton.waitFor({state: 'visible'});
    const finalForm = await page.locator('.ui-dialog:visible form').last().evaluate(form => ({
      action: (form as HTMLFormElement).action,
      fields: [...(form as HTMLFormElement).elements].filter(el => el.getAttribute('name')).map(el => ({
        name: el.getAttribute('name'), value: (el as HTMLInputElement).value,
      })),
    }));
    const responsePromise = page.waitForResponse(r => r.request().method() === 'POST' &&
      r.url().includes('/clone') && r.request().postData()?.includes('step=5') === true);
    await finalButton.click();
    const response = await responsePromise;
    await page.waitForURL(/\/event\/\d+\/manage\/?/, {timeout: 10000}).catch(() => undefined);
    return {
      selectedCategory, finalForm, postStatus: response.status(), postUrl: response.url(),
      postBody: response.request().postData(), responseBody: (await response.text().catch(() => '')).slice(0, 600),
      pageUrl: page.url(),
    };
  });
  rec.flush();
  await ctx.close();
});

test('designer template clone submission after category selection', async ({browser}, testInfo) => {
  const rec = new Recorder('template-clone-submit', testInfo);
  const {ctx, page} = await newCtx(browser, 'admin');
  rec.watch(page);
  await rec.step('submission', async () => {
    await openTemplateCloneDialog(page);
    const selectedCategory = await selectDestination(page);
    const form = page.locator('.ui-dialog:visible form').last();
    const action = await form.getAttribute('action');
    const responsePromise = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/clone'));
    await form.getByRole('button', {name: 'Clone', exact: true}).click();
    const response = await responsePromise;
    await page.goto(`/category/${manifest.navigatorDestinationId}/manage/designer/`);
    return {
      selectedCategory, action, postStatus: response.status(), postUrl: response.url(),
      postBody: response.request().postData(), responseBody: (await response.text().catch(() => '')).slice(0, 600),
      destinationHasCopy: await page.getByText('(copy)', {exact: false}).count(),
    };
  });
  rec.flush();
  await ctx.close();
});
