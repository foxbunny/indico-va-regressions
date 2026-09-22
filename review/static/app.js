const appRoot = document.getElementById('app');
const breadcrumb = document.getElementById('hash-breadcrumb');

const app = {
  replaceChildren(...children) {
    appRoot.replaceChildren(...children.flat().filter(c => c != null && c !== false));
  },
};

function icon(name, extraClass = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon ${extraClass}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#ico-${name}`);
  svg.appendChild(use);
  return svg;
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

function humanTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
}

function pageTitleRow(title, ...items) {
  return el('div', {class: 'page-title-row'},
    el('h2', {}, title),
    ...items.filter(Boolean),
  );
}

// Find every other diff for the same (page, persona) to switch between engines/modalities.
async function siblingDiffs(currentKey, pageId, persona) {
  try {
    const data = await fetchJson('/api/diffs');
    const visuals = data.visual.filter(d => d.page_id === pageId && d.persona === persona);
    const a11y = data.a11y.find(d => d.page_id === pageId && d.persona === persona) || null;
    return {visuals, a11y, currentKey};
  } catch {
    return {visuals: [], a11y: null, currentKey};
  }
}

function diffKey(kind, browser) {
  return kind === 'visual' ? `visual:${browser}` : 'a11y';
}

function switchKindLinks(currentKey, pageId, persona, siblings) {
  const out = [];
  for (const v of siblings.visuals) {
    const key = diffKey('visual', v.browser);
    if (key === currentKey) continue;
    out.push(el('a', {
      href: `#/diff/visual/${v.browser}/${pageId}/${persona}`,
      class: 'view-btn view-btn-visual',
    }, icon('eye'), ` View visual (${v.browser})`));
  }
  if (siblings.a11y && currentKey !== 'a11y') {
    out.push(el('a', {
      href: `#/diff/a11y/${pageId}/${persona}`,
      class: 'view-btn view-btn-a11y',
    }, icon('a11y'), ' View a11y diff'));
  }
  return out;
}

function humanPx(n) {
  if (n < 1000) return `${n}px`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}Kpx`;
  return `${Math.round(n / 1_000_000)}Mpx`;
}

function navLinks(active) {
  return el('div', {class: 'nav-tabs'},
    el('a', {href: '#/', class: active === 'diffs' ? 'active' : ''}, 'Open diffs'),
    el('a', {href: '#/baselines', class: active === 'baselines' ? 'active' : ''}, 'All baselines'),
    el('a', {href: '#/runs', class: active === 'runs' ? 'active' : ''}, 'Run log'),
  );
}

// --- dashboard: open diffs (transient from latest run) ----------------------

function visualChange(v) {
  const cls = `change-chip change-visual change-${v.status}`;
  const browserTag = el('span', {class: 'browser-tag'}, v.browser);
  if (v.status === 'new') {
    return el('span', {class: cls}, icon('eye'), ' ', browserTag, ' new');
  }
  const pct = v.pixel_pct ? v.pixel_pct.toFixed(3) : '0';
  return el('span', {class: cls}, icon('eye'), ' ', browserTag, ` ${pct}% (${humanPx(v.pixel_count)})`);
}

function a11yChange(a) {
  const cls = `change-chip change-a11y change-${a.status}`;
  if (a.status === 'new') {
    return el('span', {class: cls}, icon('a11y'), ' new');
  }
  return el('span', {class: cls}, icon('a11y'), ` +${a.added_count}/-${a.removed_count}`);
}

function thumbLink(href, content) {
  return el('a', {href, class: 'thumb-link'}, content);
}

function changesCell(visuals, a) {
  return el('span', {class: 'changes-cell'},
    ...visuals.map(visualChange),
    a ? a11yChange(a) : null,
  );
}

function combinedDiffsTable(visualGroups, a11yMap) {
  const keys = new Set([...visualGroups.keys(), ...a11yMap.keys()]);
  if (keys.size === 0) {
    return el('p', {class: 'empty'},
      'No open diffs — every page matches its baseline in the latest run.');
  }
  const sorted = [...keys].sort();
  const tbody = el('tbody');
  for (const key of sorted) {
    const visuals = visualGroups.get(key) || [];
    const a = a11yMap.get(key) || null;
    const [pageId, persona] = key.split('\0');

    const previewVisual = visuals.find(v => v.has_diff_image) || visuals[0] || null;
    let previewContent;
    let previewHref;
    if (previewVisual && previewVisual.has_diff_image) {
      previewContent = el('img', {
        class: 'thumb',
        src: `/img/diff/${previewVisual.browser}/${pageId}/${persona}.png`,
        loading: 'lazy', alt: '',
      });
      previewHref = `#/diff/visual/${previewVisual.browser}/${pageId}/${persona}`;
    } else if (previewVisual) {
      previewContent = el('span', {class: 'empty thumb-placeholder'}, '(new)');
      previewHref = `#/diff/visual/${previewVisual.browser}/${pageId}/${persona}`;
    } else {
      previewContent = el('span', {class: 'empty thumb-placeholder'}, 'a11y-only');
      previewHref = `#/diff/a11y/${pageId}/${persona}`;
    }

    const actionBtns = [];
    for (const v of visuals) {
      actionBtns.push(el('button', {
        class: 'view-btn view-btn-visual',
        onclick: () => { location.hash = `#/diff/visual/${v.browser}/${pageId}/${persona}`; },
      }, icon('eye'), ` ${v.browser}`));
    }
    if (a) {
      actionBtns.push(el('button', {
        class: 'view-btn view-btn-a11y',
        onclick: () => { location.hash = `#/diff/a11y/${pageId}/${persona}`; },
      }, icon('a11y'), ' a11y'));
    }
    tbody.appendChild(el('tr', {},
      el('td', {class: 'thumb-cell'}, thumbLink(previewHref, previewContent)),
      el('td', {}, pageId),
      el('td', {}, persona),
      el('td', {}, changesCell(visuals, a)),
      el('td', {class: 'actions-cell'}, ...actionBtns),
    ));
  }
  return el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, 'Preview'),
      el('th', {}, 'Page'),
      el('th', {}, 'Persona'),
      el('th', {}, 'Changes'),
      el('th', {}, 'View'),
    )),
    tbody,
  );
}

async function renderDiffs() {
  breadcrumb.textContent = '';
  app.replaceChildren(navLinks('diffs'), el('p', {}, 'Loading open diffs…'));
  const data = await fetchJson('/api/diffs');

  const visualGroups = new Map();
  for (const v of data.visual) {
    const key = `${v.page_id}\0${v.persona}`;
    if (!visualGroups.has(key)) visualGroups.set(key, []);
    visualGroups.get(key).push(v);
  }
  const a11yMap = new Map(data.a11y.map(d => [`${d.page_id}\0${d.persona}`, d]));
  const totalVisual = data.visual.length;
  const totalA11y = data.a11y.length;

  const visualByBrowser = new Map();
  for (const v of data.visual) {
    visualByBrowser.set(v.browser, (visualByBrowser.get(v.browser) || 0) + 1);
  }
  const browserSummary = [...visualByBrowser.entries()]
    .sort()
    .map(([b, n]) => `${n} ${b}`)
    .join(' + ');

  app.replaceChildren(
    navLinks('diffs'),
    el('h2', {}, 'Open diffs (latest run)'),
    el('p', {class: 'run-meta'},
      totalVisual + totalA11y === 0
        ? 'Everything matches its baseline.'
        : el('span', {},
            `${totalVisual} visual diff${totalVisual === 1 ? '' : 's'}`,
            browserSummary ? ` (${browserSummary})` : '',
            ` · ${totalA11y} a11y diff${totalA11y === 1 ? '' : 's'}`,
          ),
    ),
    combinedDiffsTable(visualGroups, a11yMap),
  );
}

// --- baselines tab ----------------------------------------------------------

function baselinesTable(kind, rows) {
  if (rows.length === 0) return el('p', {class: 'empty'}, `No ${kind} baselines.`);
  const tbody = el('tbody');
  for (const row of rows) {
    const thumbContent = kind === 'visual'
      ? el('img', {
          class: 'thumb',
          src: `/img/baseline/${row.browser}/${row.page_id}/${row.persona}.png`,
          loading: 'lazy', alt: '',
        })
      : el('span', {class: 'empty thumb-placeholder'}, `${row.node_count} nodes`);
    const cells = [
      el('td', {class: 'thumb-cell'}, thumbContent),
      el('td', {}, row.page_id),
      el('td', {}, row.persona),
    ];
    if (kind === 'visual') {
      cells.push(el('td', {}, el('span', {class: 'browser-tag'}, row.browser)));
      cells.push(el('td', {}, `${row.width} × ${row.height}`));
    } else {
      cells.push(el('td', {}, `${row.node_count} nodes`));
    }
    cells.push(el('td', {}, humanTime(row.captured_at)));
    tbody.appendChild(el('tr', {}, ...cells));
  }
  const headers = [el('th', {}, 'Preview'), el('th', {}, 'Page'), el('th', {}, 'Persona')];
  if (kind === 'visual') headers.push(el('th', {}, 'Browser'), el('th', {}, 'Resolution'));
  else headers.push(el('th', {}, 'Nodes'));
  headers.push(el('th', {}, 'Captured'));
  return el('table', {},
    el('thead', {}, el('tr', {}, ...headers)),
    tbody,
  );
}

async function renderBaselines() {
  breadcrumb.textContent = '';
  app.replaceChildren(navLinks('baselines'), el('p', {}, 'Loading baselines…'));
  const data = await fetchJson('/api/baselines');
  app.replaceChildren(
    navLinks('baselines'),
    el('h2', {}, 'All baselines (master snapshot)'),
    el('h3', {class: 'section-title'}, `Visual (${data.visual.length})`),
    baselinesTable('visual', data.visual),
    el('h3', {class: 'section-title'}, `Accessibility (${data.a11y.length})`),
    baselinesTable('a11y', data.a11y),
  );
}

// --- diff viewers (read-only inspection) ------------------------------------

function buildSyncedViewer({baselineSrc, proposalSrc, hasBaseline}) {
  const makePanel = (label, src) => {
    const viewport = el('div', {class: 'zoom-pane pan-viewport'});
    if (src) {
      viewport.appendChild(el('img', {src, draggable: 'false', alt: '', class: 'zoom-img'}));
    } else {
      viewport.appendChild(el('div', {class: 'empty'}, 'no baseline yet'));
    }
    const wrap = el('div', {class: 'pan-wrap'},
      el('div', {class: 'pan-label'}, label),
      viewport,
    );
    return {wrap, viewport};
  };

  const baseline = makePanel('baseline (master)', hasBaseline ? baselineSrc : null);
  const proposal = makePanel('proposal (current run)', proposalSrc);

  const targets = [baseline, proposal]
    .map(({viewport}) => ({viewport, image: viewport.querySelector('img')}))
    .filter(t => t.image);
  if (targets.length > 0) attachZoom(targets);

  return el('div', {class: 'pan-zoom'},
    el('div', {class: 'pan-grid'}, baseline.wrap, proposal.wrap),
  );
}

function renderUnifiedDiff(text) {
  const pre = el('pre');
  for (const line of text.split('\n')) {
    let cls = '';
    if (line.startsWith('+') && !line.startsWith('+++')) cls = 'line-add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'line-del';
    else if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) cls = 'line-meta';
    pre.appendChild(el('div', {class: cls}, line));
  }
  return pre;
}

function attachZoom(targets) {
  const state = {zoomed: false, tx: 0, ty: 0};
  let didMove = false;

  function apply() {
    for (const {image} of targets) {
      if (state.zoomed) {
        image.classList.add('zoomed');
        image.style.transform = `translate(${state.tx}px, ${state.ty}px)`;
      } else {
        image.classList.remove('zoomed');
        image.style.transform = '';
      }
    }
  }

  function toggleAt(viewport, image, clientX, clientY) {
    if (!state.zoomed) {
      const paneRect = viewport.getBoundingClientRect();
      const displayed = image.getBoundingClientRect();
      const fitScale = displayed.width / image.naturalWidth;
      const naturalX = (clientX - displayed.left) / fitScale;
      const naturalY = (clientY - displayed.top) / fitScale;
      const clickX = clientX - paneRect.left;
      const clickY = clientY - paneRect.top;
      state.tx = clickX - (paneRect.width - image.naturalWidth) / 2 - naturalX;
      state.ty = clickY - (paneRect.height - image.naturalHeight) / 2 - naturalY;
      state.zoomed = true;
    } else {
      state.zoomed = false;
      state.tx = 0;
      state.ty = 0;
    }
    apply();
  }

  for (const {viewport, image} of targets) {
    viewport.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !state.zoomed) return;
      e.preventDefault();
      didMove = false;
      let lx = e.clientX;
      let ly = e.clientY;
      const onMove = (m) => {
        const dx = m.clientX - lx;
        const dy = m.clientY - ly;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) didMove = true;
        state.tx += dx;
        state.ty += dy;
        lx = m.clientX;
        ly = m.clientY;
        apply();
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    viewport.addEventListener('click', (e) => {
      if (didMove) {
        didMove = false;
        return;
      }
      toggleAt(viewport, image, e.clientX, e.clientY);
    });
  }
}

async function renderVisualDiff(pageId, persona, browser) {
  breadcrumb.innerHTML = `&rsaquo; <a href="#/">open diffs</a> &rsaquo; ${escape(pageId)} (${escape(persona)} · ${escape(browser)})`;
  app.replaceChildren(el('p', {}, 'Loading diff…'));
  const [diff, siblings] = await Promise.all([
    fetchJson(`/api/diffs/visual/${browser}/${pageId}/${persona}`),
    siblingDiffs(diffKey('visual', browser), pageId, persona),
  ]);
  const hasBaseline = Boolean(diff.has_baseline);

  const diffImg = diff.has_diff_image
    ? el('img', {
        src: `/img/diff/${browser}/${pageId}/${persona}.png`,
        alt: 'pixel-difference overlay',
        class: 'zoom-img',
      })
    : null;
  const diffBody = diffImg
    ? el('div', {class: 'zoom-pane visual-diff-pane'}, diffImg)
    : el('p', {class: 'empty'},
        hasBaseline
          ? 'Snapshots differ in size only — no pixel overlay produced.'
          : 'No baseline exists for this page yet.');
  if (diffImg) attachZoom([{viewport: diffBody, image: diffImg}]);

  const viewer = buildSyncedViewer({
    baselineSrc: `/img/baseline/${browser}/${pageId}/${persona}.png`,
    proposalSrc: `/img/proposal/${browser}/${pageId}/${persona}.png`,
    hasBaseline,
  });

  app.replaceChildren(
    pageTitleRow(`Visual: ${pageId} · ${persona} · ${browser}`,
      ...switchKindLinks(diffKey('visual', browser), pageId, persona, siblings),
    ),
    el('p', {class: 'run-meta'},
      `${diff.pixel_pct ? diff.pixel_pct.toFixed(3) : '0'}% (${humanPx(diff.pixel_count)}) · captured ${humanTime(diff.captured_at)}`,
    ),
    el('p', {class: 'run-meta'}, 'Pixels that changed between the master baseline and the current branch render. Magenta blocks are masked regions.'),
    el('h3', {class: 'section-title'}, 'Diff'),
    diffBody,
    el('h3', {class: 'section-title'}, 'Side-by-side'),
    viewer,
  );
}

async function renderA11yDiff(pageId, persona) {
  breadcrumb.innerHTML = `&rsaquo; <a href="#/">open diffs</a> &rsaquo; ${escape(pageId)} (${escape(persona)})`;
  app.replaceChildren(el('p', {}, 'Loading diff…'));
  const [diff, baselineOutline, proposalOutline, siblings] = await Promise.all([
    fetchJson(`/api/diffs/a11y/${pageId}/${persona}`),
    fetchText(`/outline/baseline/${pageId}/${persona}`),
    fetchText(`/outline/proposal/${pageId}/${persona}`),
    siblingDiffs('a11y', pageId, persona),
  ]);
  const hasBaseline = Boolean(diff.has_baseline);

  const diffBody = diff.diff_text
    ? el('div', {class: 'a11y-diff'}, renderUnifiedDiff(diff.diff_text))
    : el('p', {class: 'empty'}, hasBaseline ? 'Tree differs but no unified diff produced.' : 'No baseline exists for this page yet.');

  const outlinePanel = (label, text, missingMsg) => el('div', {class: 'outline-wrap'},
    el('div', {class: 'outline-label'}, label),
    text != null
      ? el('pre', {class: 'outline-text'}, text)
      : el('p', {class: 'empty'}, missingMsg),
  );

  app.replaceChildren(
    pageTitleRow(`A11y: ${pageId} · ${persona}`,
      ...switchKindLinks('a11y', pageId, persona, siblings),
    ),
    el('p', {class: 'run-meta'},
      `+${diff.added_count} / -${diff.removed_count} lines · captured ${humanTime(diff.captured_at)}`,
    ),
    el('p', {class: 'run-meta'}, 'How a screen-reader walks the page. Indentation = nesting. Roles in plain English; "—" introduces the accessible name.'),
    el('h3', {class: 'section-title'}, 'Diff'),
    diffBody,
    el('h3', {class: 'section-title'}, 'Side-by-side'),
    el('div', {class: 'outline-grid'},
      outlinePanel('Baseline (master)', baselineOutline, 'No baseline yet.'),
      outlinePanel('Proposal (current branch)', proposalOutline, 'No proposal data.'),
    ),
  );
}

// --- runs (diagnostic) ------------------------------------------------------

async function renderRuns() {
  breadcrumb.textContent = '';
  app.replaceChildren(navLinks('runs'), el('p', {}, 'Loading…'));
  const runs = await fetchJson('/api/runs');
  if (runs.length === 0) {
    app.replaceChildren(navLinks('runs'), el('p', {class: 'empty'}, 'No runs recorded yet.'));
    return;
  }
  const tbody = el('tbody');
  for (const run of runs) {
    tbody.appendChild(el('tr', {},
      el('td', {}, '#' + run.id),
      el('td', {}, humanTime(run.started_at)),
      el('td', {}, run.finished_at ? humanTime(run.finished_at) : '—'),
      el('td', {}, run.git_head ? run.git_head.slice(0, 10) + (run.git_dirty ? ' (dirty)' : '') : '—'),
      el('td', {}, `${run.new_visual} new, ${run.changed_visual} changed`),
      el('td', {}, `${run.new_a11y} new, ${run.changed_a11y} changed`),
    ));
  }
  app.replaceChildren(
    navLinks('runs'),
    el('h2', {}, 'Run log'),
    el('p', {class: 'run-meta'}, 'Diagnostic only — baselines and diffs are the canonical state.'),
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Run'),
        el('th', {}, 'Started'),
        el('th', {}, 'Finished'),
        el('th', {}, 'Git'),
        el('th', {}, 'Visual deltas'),
        el('th', {}, 'A11y deltas'),
      )),
      tbody,
    ),
  );
}

// --- router -----------------------------------------------------------------

async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  try {
    let m;
    if (hash === '/' || hash === '/diffs' || hash === '') return await renderDiffs();
    if (hash === '/baselines')                            return await renderBaselines();
    if (hash === '/runs')                                 return await renderRuns();
    if ((m = hash.match(/^\/diff\/visual\/([^/]+)\/([^/]+)\/([^/]+)$/))) {
      return await renderVisualDiff(m[2], m[3], m[1]);
    }
    if ((m = hash.match(/^\/diff\/a11y\/([^/]+)\/([^/]+)$/))) {
      return await renderA11yDiff(m[1], m[2]);
    }
    app.replaceChildren(el('p', {class: 'empty'}, 'Unknown route: ' + hash));
  } catch (err) {
    app.replaceChildren(el('p', {class: 'empty'}, 'Error: ' + err.message));
  }
}

window.addEventListener('hashchange', route);
route();
