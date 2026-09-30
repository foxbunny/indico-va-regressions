// Drive a page with real X input while Orca listens, and record what Orca says after each step.
//
// Usage (inside the orca container, via orca-run.sh):
//   orca_probe.cjs --orca-log FILE --scenario NAME [--label base|changed] [--base-url URL] [--out DIR]
//
// Selectors work on both the jQuery UI category navigator and the native <dialog> version, so the
// same scenario can run against either revision. Output: <out>/<scenario>__<label>.json with the
// words Orca spoke after each step, in order.

const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {chromium, request} = require('playwright');

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), [])
);
const baseUrl = args['base-url'] || process.env.BASE_URL || 'http://indico:8000';
const outDir = args.out || '/regressions/output/screenreader';
const label = args.label || 'run';
const manifest = JSON.parse(fs.readFileSync('/regressions/output/manifest.json', 'utf8'));
const personas = JSON.parse(fs.readFileSync('/regressions/config/personas.json', 'utf8'));

const repeat = (key, n) => Array.from({length: n}, () => key);

const scenarios = {
  // Category display page: open the navigator, walk it with Tab and Shift+Tab, read it in browse mode.
  display: {
    persona: 'anonymous',
    path: `/category/${manifest.navigatorParentId}/`,
    open: '#navigate-button',
    keys: [...repeat('Tab', 14), ...repeat('shift+Tab', 3), ...repeat('Down', 20), 'Escape'],
  },
  // Category management: move 'Navigator source'.
  'category-move': {
    persona: 'admin',
    path: `/category/${manifest.navigatorParentId}/manage/`,
    open: '.category-management tr:has-text("Navigator source") .js-move-category',
    keys: [...repeat('Tab', 12), 'Escape'],
  },
};

function xdo(...xargs) {
  execFileSync('xdotool', xargs);
}

function orcaSpeech(logFile) {
  const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  return [...text.matchAll(/SPEECH OUTPUT: '((?:[^'\\]|\\.)*)'/g)].map(m => m[1].replace(/\\'/g, "'"));
}

async function storageState(persona) {
  const login = personas[persona]?.login;
  if (!login?.email) {
    return undefined;
  }
  const api = await request.newContext({baseURL: baseUrl});
  const html = await (await api.get('/login/')).text();
  const csrf = html.match(/<input[^>]*name=["']csrf_token["'][^>]*value=["']([^"']+)["']/)[1];
  await api.post('/login/', {
    form: {csrf_token: csrf, _provider: 'indico', identifier: login.email, password: login.password},
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  const state = await api.storageState();
  await api.dispose();
  return state;
}

async function main() {
  const scenario = scenarios[args.scenario];
  if (!scenario) {
    throw new Error(`unknown scenario ${args.scenario}; known: ${Object.keys(scenarios).join(', ')}`);
  }
  const browser = await chromium.launch({
    headless: false,
    args: ['--force-renderer-accessibility=complete', '--window-position=0,0', '--window-size=1280,900'],
  });
  const context = await browser.newContext({viewport: null, storageState: await storageState(scenario.persona)});
  const page = await context.newPage();
  await page.goto(baseUrl + scenario.path);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);

  // Real X input: Orca follows native focus, which injected (CDP) events don't move
  const box = await page.locator(scenario.open).first().boundingBox();
  const origin = await page.evaluate(() => ({
    x: window.screenX + (window.outerWidth - window.innerWidth) / 2,
    y: window.screenY + window.outerHeight - window.innerHeight,
  }));
  const steps = [];
  let spoken = orcaSpeech(args['orca-log']).length;
  const record = async (step, act) => {
    act();
    await page.waitForTimeout(900);
    const all = orcaSpeech(args['orca-log']);
    steps.push({step, speech: all.slice(spoken).filter(Boolean)});
    spoken = all.length;
  };

  await record(`click ${scenario.open}`, () =>
    xdo(
      'mousemove',
      String(Math.round(origin.x + box.x + box.width / 2)),
      String(Math.round(origin.y + box.y + box.height / 2)),
      'click',
      '1'
    )
  );
  await page.locator('.current-category').first().waitFor();
  await page.waitForTimeout(1500);
  const opened = orcaSpeech(args['orca-log']);
  steps[0].speech.push(...opened.slice(spoken).filter(Boolean));
  spoken = opened.length;

  for (const key of scenario.keys) {
    await record(key, () => xdo('key', '--clearmodifiers', key));
  }

  await browser.close();
  fs.mkdirSync(outDir, {recursive: true});
  const out = path.join(outDir, `${args.scenario}__${label}.json`);
  fs.writeFileSync(out, JSON.stringify({scenario: args.scenario, label, baseUrl, steps}, null, 2));
  for (const {step, speech} of steps) {
    console.log(`${step.padEnd(12)} ${speech.join(' | ')}`);
  }
  console.log(`wrote ${out}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
