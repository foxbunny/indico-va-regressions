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

async function otherDiffExists(kind, pageId, persona) {
  const other = kind === 'visual' ? 'a11y' : 'visual';
  try {
    const res = await fetch(`/api/diffs/${other}/${pageId}/${persona}`, {method: 'HEAD'});
    return res.ok;
  } catch {
    return false;
  }
}

function switchKindLink(currentKind, pageId, persona) {
  const other = currentKind === 'visual' ? 'a11y' : 'visual';
  const label = other === 'visual' ? 'View visual diff' : 'View a11y diff';
  return el('a', {
    href: `#/diff/${other}/${pageId}/${persona}`,
    class: `view-btn view-btn-${other}`,
  }, icon(other === 'visual' ? 'eye' : 'a11y'), ' ', label);
}

function historyLink(kind, pageId, persona) {
  return el('a', {
    href: `#/history/${kind}/${pageId}/${persona}`,
    class: 'icon-link',
  }, icon('history'), ' History');
}

function statusBadge(status) {
  return el('span', {class: `status-${status}`}, status);
}

function humanPx(n) {
  if (n < 1000) return `${n}px`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}Kpx`;
  return `${Math.round(n / 1_000_000)}Mpx`;
}

function diffMetric(d) {
  if (d.kind === 'visual') {
    return d.pixel_pct > 0 ? `${d.pixel_pct.toFixed(3)}% (${humanPx(d.pixel_count)})` : '—';
  }
  const total = (d.added_count || 0) + (d.removed_count || 0);
  return total > 0 ? `+${d.added_count} / -${d.removed_count}` : '—';
}

function navLinks(active) {
  return el('div', {class: 'nav-tabs'},
    el('a', {href: '#/', class: active === 'diffs' ? 'active' : ''}, 'Open diffs'),
    el('a', {href: '#/baselines', class: active === 'baselines' ? 'active' : ''}, 'All baselines'),
    el('a', {href: '#/runs', class: active === 'runs' ? 'active' : ''}, 'Run log'),
  );
}

// --- dashboard: open diffs (default) ----------------------------------------

function visualChange(v) {
  const cls = `change-chip change-visual change-${v.status}`;
  if (v.status === 'new') {
    return el('span', {class: cls}, icon('eye'), ' new');
  }
  const pct = v.pixel_pct ? v.pixel_pct.toFixed(3) : '0';
  return el('span', {class: cls}, icon('eye'), ` ${pct}% (${humanPx(v.pixel_count)})`);
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

function changesCell(v, a) {
  return el('span', {class: 'changes-cell'},
    v ? visualChange(v) : null,
    a ? a11yChange(a) : null,
  );
}

function combinedDiffsTable(visualMap, a11yMap) {
  // Build a sorted list of (page_id, persona) keys that have a diff in either modality.
  const keys = new Set([...visualMap.keys(), ...a11yMap.keys()]);
  if (keys.size === 0) {
    return el('p', {class: 'empty'},
      'No open diffs — every page matches its baseline in both modalities.');
  }
  const sorted = [...keys].sort();
  const tbody = el('tbody');
  for (const key of sorted) {
    const v = visualMap.get(key) || null;
    const a = a11yMap.get(key) || null;
    const [pageId, persona] = key.split('\0');
    // Preview shows the diff PNG (red-highlighted pixel changes). For 'new'
    // visual diffs there's no baseline → no diff PNG; fall back to a label.
    // Whole preview is linked to the most informative diff for the row: the
    // visual one if any visual change is present, otherwise the a11y one.
    const previewContent = v && v.has_diff_image
      ? el('img', {class: 'thumb', src: `/img/diff/${pageId}/${persona}.png`, loading: 'lazy', alt: ''})
      : v
        ? el('span', {class: 'empty thumb-placeholder'}, '(new — no diff)')
        : el('span', {class: 'empty thumb-placeholder'}, 'a11y-only');
    const previewKind = v ? 'visual' : 'a11y';
    const thumbCell = thumbLink(`#/diff/${previewKind}/${pageId}/${persona}`, previewContent);
    const rowCb = el('input', {
      type: 'checkbox',
      class: 'row-cb',
      'data-page-id': pageId,
      'data-persona': persona,
      'data-has-visual': v ? 'true' : 'false',
      'data-has-a11y': a ? 'true' : 'false',
      onchange: updateSelectAllState,
    });
    tbody.appendChild(el('tr', {},
      el('td', {class: 'cb-cell'}, rowCb),
      el('td', {class: 'thumb-cell'}, thumbCell),
      el('td', {}, pageId),
      el('td', {}, persona),
      el('td', {}, changesCell(v, a)),
      el('td', {class: 'actions-cell'},
        v ? el('button', {class: 'view-btn view-btn-visual', onclick: () => { location.hash = `#/diff/visual/${pageId}/${persona}`; }}, icon('eye'), ' visual') : null,
        a ? el('button', {class: 'view-btn view-btn-a11y', onclick: () => { location.hash = `#/diff/a11y/${pageId}/${persona}`; }}, icon('a11y'), ' a11y') : null,
      ),
    ));
  }
  const headerCb = el('input', {
    type: 'checkbox',
    id: 'select-all-cb',
    onchange: (e) => selectRows(e.target.checked ? 'all' : 'none'),
  });
  return el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {class: 'cb-cell'}, headerCb),
      el('th', {}, 'Preview'),
      el('th', {}, 'Page'),
      el('th', {}, 'Persona'),
      el('th', {}, 'Changes'),
      el('th', {}, 'View'),
    )),
    tbody,
  );
}

function selectRows(filter) {
  const cbs = document.querySelectorAll('.row-cb');
  for (const cb of cbs) {
    if (filter === 'all') cb.checked = true;
    else if (filter === 'none') cb.checked = false;
    else if (filter === 'visual') cb.checked = cb.dataset.hasVisual === 'true';
    else if (filter === 'a11y') cb.checked = cb.dataset.hasA11y === 'true';
  }
  updateSelectAllState();
}

function updateSelectAllState() {
  const cbs = document.querySelectorAll('.row-cb');
  const checked = Array.from(cbs).filter(c => c.checked).length;
  const headerCb = document.getElementById('select-all-cb');
  if (!headerCb) return;
  headerCb.checked = cbs.length > 0 && checked === cbs.length;
  headerCb.indeterminate = checked > 0 && checked < cbs.length;
}

async function acceptSelected() {
  const cbs = Array.from(document.querySelectorAll('.row-cb:checked'));
  if (cbs.length === 0) {
    alert('No rows selected.');
    return;
  }
  if (!confirm(`Promote ${cbs.length} selected proposal(s) to baseline?`)) return;
  for (const cb of cbs) {
    const {pageId, persona, hasVisual, hasA11y} = cb.dataset;
    if (hasVisual === 'true') {
      await fetchJson(`/api/diffs/visual/${pageId}/${persona}/accept`, {method: 'POST'});
    }
    if (hasA11y === 'true') {
      await fetchJson(`/api/diffs/a11y/${pageId}/${persona}/accept`, {method: 'POST'});
    }
  }
  await renderDiffs();
}

async function renderDiffs() {
  breadcrumb.textContent = '';
  app.replaceChildren(navLinks('diffs'), el('p', {}, 'Loading…'));
  const data = await fetchJson('/api/diffs');
  const visualMap = new Map(data.visual.map(d => [`${d.page_id}\0${d.persona}`, d]));
  const a11yMap   = new Map(data.a11y.map(d => [`${d.page_id}\0${d.persona}`, d]));
  const totalVisual = data.visual.length;
  const totalA11y = data.a11y.length;

  // Count classifications for the summary line.
  let bothCount = 0;
  for (const k of visualMap.keys()) if (a11yMap.has(k)) bothCount += 1;
  const visualOnly = totalVisual - bothCount;
  const a11yOnly = totalA11y - bothCount;

  app.replaceChildren(
    navLinks('diffs'),
    el('h2', {}, `Open diffs`),
    el('p', {class: 'run-meta'},
      totalVisual + totalA11y === 0
        ? 'Everything matches its baseline.'
        : el('span', {},
            `${visualOnly} visual-only · ${a11yOnly} a11y-only · ${bothCount} affecting both `,
            `(${totalVisual} visual + ${totalA11y} a11y open diffs in total)`,
          ),
    ),
    totalVisual + totalA11y > 0 ? el('div', {class: 'diff-toolbar'},
      el('button', {onclick: () => selectRows('visual')}, 'Select all visual'),
      el('button', {onclick: () => selectRows('a11y')}, 'Select all a11y'),
      el('button', {class: 'accept', onclick: acceptSelected}, icon('check'), ' Accept selected'),
    ) : null,
    combinedDiffsTable(visualMap, a11yMap),
  );
}

// --- baselines tab ----------------------------------------------------------

function baselinesTable(kind, rows) {
  if (rows.length === 0) return el('p', {class: 'empty'}, `No ${kind} baselines yet.`);
  const tbody = el('tbody');
  for (const row of rows) {
    const thumbContent = kind === 'visual'
      ? el('img', {class: 'thumb', src: `/img/baseline/by-id/${row.id}.png`, loading: 'lazy', alt: ''})
      : el('span', {class: 'empty thumb-placeholder'}, `${row.node_count} nodes`);
    const historyHref = `#/history/${kind}/${row.page_id}/${row.persona}`;
    tbody.appendChild(el('tr', {},
      el('td', {class: 'thumb-cell'}, thumbLink(historyHref, thumbContent)),
      el('td', {}, row.page_id),
      el('td', {}, row.persona),
      el('td', {}, row.captured_at),
      el('td', {}, String(row.history_size)),
      el('td', {}, el('a', {href: historyHref}, 'history')),
    ));
  }
  return el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, 'Preview'),
      el('th', {}, 'Page'),
      el('th', {}, 'Persona'),
      el('th', {}, 'Current accepted'),
      el('th', {}, 'Versions'),
      el('th', {}, ''),
    )),
    tbody,
  );
}

async function renderBaselines() {
  breadcrumb.textContent = '';
  app.replaceChildren(navLinks('baselines'), el('p', {}, 'Loading…'));
  const data = await fetchJson('/api/baselines');
  app.replaceChildren(
    navLinks('baselines'),
    el('h2', {}, 'All baselines'),
    el('h3', {class: 'section-title'}, `Visual (${data.visual.length})`),
    baselinesTable('visual', data.visual),
    el('h3', {class: 'section-title'}, `Accessibility (${data.a11y.length})`),
    baselinesTable('a11y', data.a11y),
  );
}

// --- history view -----------------------------------------------------------

function historyChangeChip(kind, row) {
  // Each baseline row carries the diff that produced it (i.e. against the
  // previous baseline). The very first baseline in a chain has no predecessor
  // and shows '(initial)'. Pre-existing rows accepted before this column was
  // added are chained via the backfill but lack the stored overlay/unified
  // diff, so we show '(delta not stored)' while still letting the user open
  // a side-by-side comparison.
  if (row.prev_baseline_id == null) return el('span', {class: 'empty'}, '(initial)');
  if (kind === 'visual') {
    if (!row.has_diff_image) return el('span', {class: 'empty'}, '(delta not stored)');
    const pct = row.pixel_pct ? row.pixel_pct.toFixed(3) : '0';
    return el('span', {class: 'change-chip change-visual change-changed'},
      icon('eye'), ` ${pct}% (${humanPx(row.pixel_count)})`);
  }
  if (!row.has_diff_text) return el('span', {class: 'empty'}, '(delta not stored)');
  return el('span', {class: 'change-chip change-a11y change-changed'},
    icon('a11y'), ` +${row.added_count}/-${row.removed_count}`);
}

function historyPreviewCell(kind, row) {
  if (kind === 'visual' && row.has_diff_image && row.prev_baseline_id != null) {
    return el('img', {
      class: 'thumb',
      src: `/img/baseline-diff/by-id/${row.id}.png`,
      loading: 'lazy', alt: '',
    });
  }
  if (kind === 'visual') {
    return el('img', {
      class: 'thumb',
      src: `/img/baseline/by-id/${row.id}.png`,
      loading: 'lazy', alt: '',
    });
  }
  return el('span', {class: 'empty thumb-placeholder'}, `${row.node_count} nodes`);
}

async function renderHistory(kind, pageId, persona) {
  breadcrumb.innerHTML = `&rsaquo; <a href="#/baselines">baselines</a> &rsaquo; ${escape(pageId)} (${escape(persona)})`;
  app.replaceChildren(el('p', {}, 'Loading history…'));
  const history = await fetchJson(`/api/baselines/${kind}/${pageId}/${persona}`);
  if (history.length === 0) {
    app.replaceChildren(el('p', {class: 'empty'}, 'No baselines for this page+persona.'));
    return;
  }
  const tbody = el('tbody');
  history.forEach((row, idx) => {
    const isCurrent = idx === 0;
    // Pre-migration rows have a chained prev_baseline_id but no stored
    // overlay/unified-diff — side-by-side is still useful, so we open the
    // historic-diff viewer for any chained step and degrade gracefully there.
    const canView = row.prev_baseline_id != null;
    const previewContent = historyPreviewCell(kind, row);
    // Chained step → click the preview to open the historic diff viewer.
    // Initial baseline has no diff to view, so the preview is plain.
    const previewCell = canView
      ? thumbLink(`#/history-diff/${kind}/${pageId}/${persona}/${row.id}`, previewContent)
      : previewContent;
    tbody.appendChild(el('tr', {},
      el('td', {class: 'thumb-cell'}, previewCell),
      el('td', {}, humanTime(row.captured_at),
        isCurrent ? el('span', {class: 'history-stamp history-current'}, ' (current)') : null),
      el('td', {}, historyChangeChip(kind, row)),
      el('td', {class: 'actions-cell'},
        canView ? el('a', {
          href: `#/history-diff/${kind}/${pageId}/${persona}/${row.id}`,
          class: `view-btn view-btn-${kind}`,
        }, icon(kind === 'visual' ? 'eye' : 'a11y'), ' View diff') : null,
      ),
    ));
  });

  app.replaceChildren(
    pageTitleRow(`History: ${pageId} · ${persona} (${kind})`),
    el('p', {class: 'run-meta'},
      `${history.length} accepted baseline${history.length === 1 ? '' : 's'}, most recent first. `,
      'Each row shows the change against the previous baseline.'),
    el('div', {class: 'diff-toolbar'},
      el('button', {class: 'reset', onclick: () => resetBaseline(kind, pageId, persona)},
        icon('trash'), ' Forget all baselines'),
    ),
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Preview'),
        el('th', {}, 'Captured'),
        el('th', {}, 'Change vs previous'),
        el('th', {}, ''),
      )),
      tbody,
    ),
  );
}

// --- diff viewer ------------------------------------------------------------

async function acceptDiff(kind, pageId, persona) {
  await fetchJson(`/api/diffs/${kind}/${pageId}/${persona}/accept`, {method: 'POST'});
  location.hash = '#/';
}

async function resetBaseline(kind, pageId, persona) {
  if (!confirm(`Forget every accepted baseline for ${pageId} (${persona})?\nThe next run will record it as "new".`)) return;
  await fetchJson(`/api/baselines/${kind}/${pageId}/${persona}/reset`, {method: 'POST'});
  location.hash = '#/baselines';
}

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

  const baseline = makePanel('baseline', hasBaseline ? baselineSrc : null);
  const proposal = makePanel('proposal (new state)', proposalSrc);

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

// Click-to-toggle fit↔1:1 zoom, with drag-to-pan at 1:1. Pass one target for
// standalone behavior, or multiple to sync every target's zoom + pan to a
// shared state.
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
      // Position the natural-pixel under the cursor at the same screen point
      // so the click target stays put when switching to 1:1. Other synced
      // targets follow the same translation.
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

async function renderVisualDiff(pageId, persona) {
  breadcrumb.innerHTML = `&rsaquo; <a href="#/">open diffs</a> &rsaquo; ${escape(pageId)} (${escape(persona)})`;
  app.replaceChildren(el('p', {}, 'Loading diff…'));
  const [diff, hasOther] = await Promise.all([
    fetchJson(`/api/diffs/visual/${pageId}/${persona}`),
    otherDiffExists('visual', pageId, persona),
  ]);
  const hasBaseline = diff.baseline_id !== null;

  const diffImg = diff.has_diff_image
    ? el('img', {
        src: `/img/diff/${pageId}/${persona}.png`,
        alt: 'pixel-difference overlay',
        class: 'zoom-img',
      })
    : null;
  const diffBody = diffImg
    ? el('div', {class: 'zoom-pane visual-diff-pane'}, diffImg)
    : el('p', {class: 'empty'},
        hasBaseline
          ? 'Snapshots differ in size only — no pixel overlay produced.'
          : 'No baseline yet — accept this proposal to set one.');
  if (diffImg) attachZoom([{viewport: diffBody, image: diffImg}]);

  const viewer = buildSyncedViewer({
    baselineSrc: `/img/baseline/${pageId}/${persona}.png`,
    proposalSrc: `/img/proposal/${pageId}/${persona}.png`,
    hasBaseline,
  });

  app.replaceChildren(
    pageTitleRow(`Visual: ${pageId} · ${persona}`,
      hasOther ? switchKindLink('visual', pageId, persona) : null,
      hasBaseline ? historyLink('visual', pageId, persona) : null,
    ),
    el('p', {class: 'run-meta'},
      `${diff.pixel_pct ? diff.pixel_pct.toFixed(3) : '0'}% (${humanPx(diff.pixel_count)}) · captured ${humanTime(diff.captured_at)}`,
    ),
    el('p', {class: 'run-meta'}, 'Pixels that changed between the baseline and the new proposal. Magenta blocks are masked regions (CAPTCHA, etc.).'),
    el('h3', {class: 'section-title'}, 'Diff'),
    diffBody,
    el('h3', {class: 'section-title'}, 'Side-by-side'),
    viewer,
    el('div', {class: 'diff-toolbar diff-toolbar-bottom'},
      el('button', {class: 'accept', onclick: () => acceptDiff('visual', pageId, persona)},
        icon('check'), ' Update baseline to this'),
      hasBaseline ? el('button', {class: 'reset', onclick: () => resetBaseline('visual', pageId, persona)},
        icon('trash'), ' Forget baseline') : null,
    ),
  );
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

async function renderA11yDiff(pageId, persona) {
  breadcrumb.innerHTML = `&rsaquo; <a href="#/">open diffs</a> &rsaquo; ${escape(pageId)} (${escape(persona)})`;
  app.replaceChildren(el('p', {}, 'Loading diff…'));
  const [diff, baselineOutline, proposalOutline, hasOther] = await Promise.all([
    fetchJson(`/api/diffs/a11y/${pageId}/${persona}`),
    fetchText(`/outline/baseline/${pageId}/${persona}`),
    fetchText(`/outline/proposal/${pageId}/${persona}`),
    otherDiffExists('a11y', pageId, persona),
  ]);
  const hasBaseline = diff.baseline_id !== null;

  const diffBody = diff.diff_text
    ? el('div', {class: 'a11y-diff'}, renderUnifiedDiff(diff.diff_text))
    : el('p', {class: 'empty'}, hasBaseline ? 'Tree differs but no unified diff produced.' : 'No baseline yet — accept this proposal to set one.');

  const outlinePanel = (label, text, missingMsg) => el('div', {class: 'outline-wrap'},
    el('div', {class: 'outline-label'}, label),
    text != null
      ? el('pre', {class: 'outline-text'}, text)
      : el('p', {class: 'empty'}, missingMsg),
  );

  app.replaceChildren(
    pageTitleRow(`A11y: ${pageId} · ${persona}`,
      hasOther ? switchKindLink('a11y', pageId, persona) : null,
      hasBaseline ? historyLink('a11y', pageId, persona) : null,
    ),
    el('p', {class: 'run-meta'},
      `+${diff.added_count} / -${diff.removed_count} lines · captured ${humanTime(diff.captured_at)}`,
    ),
    el('p', {class: 'run-meta'}, 'How a screen-reader walks the page. Indentation = nesting. Roles in plain English; "—" introduces the accessible name.'),
    el('h3', {class: 'section-title'}, 'Diff'),
    diffBody,
    el('h3', {class: 'section-title'}, 'Side-by-side'),
    el('div', {class: 'outline-grid'},
      outlinePanel('Baseline (before)', baselineOutline, 'No baseline yet.'),
      outlinePanel('Proposal (after)', proposalOutline, 'No proposal data.'),
    ),
    el('div', {class: 'diff-toolbar diff-toolbar-bottom'},
      el('button', {class: 'accept', onclick: () => acceptDiff('a11y', pageId, persona)},
        icon('check'), ' Update baseline to this'),
      hasBaseline ? el('button', {class: 'reset', onclick: () => resetBaseline('a11y', pageId, persona)},
        icon('trash'), ' Forget baseline') : null,
    ),
  );
}

// --- historic diff viewer (one accepted step in a baseline's history) -------

async function renderHistoricVisualDiff(pageId, persona, baselineId) {
  breadcrumb.innerHTML = `&rsaquo; <a href="#/baselines">baselines</a> &rsaquo; <a href="#/history/visual/${escape(pageId)}/${escape(persona)}">${escape(pageId)} (${escape(persona)})</a> &rsaquo; #${baselineId}`;
  app.replaceChildren(el('p', {}, 'Loading diff…'));
  const meta = await fetchJson(`/api/baseline-step/visual/${baselineId}`);
  if (meta.prev_baseline_id == null) {
    app.replaceChildren(el('p', {class: 'empty'}, 'This is the initial baseline — nothing to diff against.'));
    return;
  }
  let diffSection = null;
  if (meta.has_diff_image) {
    const diffImg = el('img', {
      src: `/img/baseline-diff/by-id/${baselineId}.png`,
      alt: 'pixel-difference overlay',
      class: 'zoom-img',
    });
    const pane = el('div', {class: 'zoom-pane visual-diff-pane'}, diffImg);
    attachZoom([{viewport: pane, image: diffImg}]);
    diffSection = [el('h3', {class: 'section-title'}, 'Diff'), pane];
  }

  const viewer = buildSyncedViewer({
    baselineSrc: `/img/baseline/by-id/${meta.prev_baseline_id}.png`,
    proposalSrc: `/img/baseline/by-id/${baselineId}.png`,
    hasBaseline: true,
  });

  const metricLine = meta.has_diff_image
    ? `${meta.pixel_pct ? meta.pixel_pct.toFixed(3) : '0'}% (${humanPx(meta.pixel_count)}) · accepted ${humanTime(meta.captured_at)} · #${meta.prev_baseline_id} → #${meta.id}`
    : `accepted ${humanTime(meta.captured_at)} · #${meta.prev_baseline_id} → #${meta.id} · diff overlay not stored (pre-migration baseline)`;

  app.replaceChildren(
    pageTitleRow(`Visual history: ${pageId} · ${persona}`,
      historyLink('visual', pageId, persona),
    ),
    el('p', {class: 'run-meta'}, metricLine),
    el('p', {class: 'run-meta'}, 'Read-only view of an accepted step. Baseline = the version this replaced; Proposal = the version that became current at this step.'),
    diffSection,
    el('h3', {class: 'section-title'}, 'Side-by-side'),
    viewer,
  );
}

async function renderHistoricA11yDiff(pageId, persona, baselineId) {
  breadcrumb.innerHTML = `&rsaquo; <a href="#/baselines">baselines</a> &rsaquo; <a href="#/history/a11y/${escape(pageId)}/${escape(persona)}">${escape(pageId)} (${escape(persona)})</a> &rsaquo; #${baselineId}`;
  app.replaceChildren(el('p', {}, 'Loading diff…'));
  const meta = await fetchJson(`/api/baseline-step/a11y/${baselineId}`);
  if (meta.prev_baseline_id == null) {
    app.replaceChildren(el('p', {class: 'empty'}, 'This is the initial baseline — nothing to diff against.'));
    return;
  }
  const [prevOutline, thisOutline] = await Promise.all([
    fetchText(`/outline/baseline/by-id/${meta.prev_baseline_id}`),
    fetchText(`/outline/baseline/by-id/${baselineId}`),
  ]);
  const outlinePanel = (label, text, missingMsg) => el('div', {class: 'outline-wrap'},
    el('div', {class: 'outline-label'}, label),
    text != null
      ? el('pre', {class: 'outline-text'}, text)
      : el('p', {class: 'empty'}, missingMsg),
  );
  const diffSection = meta.diff_text
    ? [el('h3', {class: 'section-title'}, 'Diff'),
       el('div', {class: 'a11y-diff'}, renderUnifiedDiff(meta.diff_text))]
    : null;
  const metricLine = meta.diff_text
    ? `+${meta.added_count} / -${meta.removed_count} lines · accepted ${humanTime(meta.captured_at)} · #${meta.prev_baseline_id} → #${meta.id}`
    : `accepted ${humanTime(meta.captured_at)} · #${meta.prev_baseline_id} → #${meta.id} · unified diff not stored (pre-migration baseline)`;
  app.replaceChildren(
    pageTitleRow(`A11y history: ${pageId} · ${persona}`,
      historyLink('a11y', pageId, persona),
    ),
    el('p', {class: 'run-meta'}, metricLine),
    el('p', {class: 'run-meta'}, 'Read-only view of an accepted step.'),
    diffSection,
    el('h3', {class: 'section-title'}, 'Side-by-side'),
    el('div', {class: 'outline-grid'},
      outlinePanel('Previous (before)', prevOutline, 'Previous baseline outline missing.'),
      outlinePanel('This baseline (after)', thisOutline, 'Outline missing.'),
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
      el('td', {}, run.started_at),
      el('td', {}, run.finished_at || '—'),
      el('td', {}, run.git_head ? run.git_head.slice(0, 10) + (run.git_dirty ? ' (dirty)' : '') : '—'),
      el('td', {}, `${run.new_visual} new, ${run.changed_visual} changed, ${run.cleared_visual} cleared`),
      el('td', {}, `${run.new_a11y} new, ${run.changed_a11y} changed, ${run.cleared_a11y} cleared`),
    ));
  }
  app.replaceChildren(
    navLinks('runs'),
    el('h2', {}, 'Run log'),
    el('p', {class: 'run-meta'}, 'Diagnostic only — diffs and baselines are the canonical state.'),
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
    if ((m = hash.match(/^\/diff\/(visual|a11y)\/([^/]+)\/([^/]+)$/))) {
      return m[1] === 'visual' ? renderVisualDiff(m[2], m[3]) : renderA11yDiff(m[2], m[3]);
    }
    if ((m = hash.match(/^\/history\/(visual|a11y)\/([^/]+)\/([^/]+)$/))) {
      return await renderHistory(m[1], m[2], m[3]);
    }
    if ((m = hash.match(/^\/history-diff\/(visual|a11y)\/([^/]+)\/([^/]+)\/(\d+)$/))) {
      return m[1] === 'visual'
        ? renderHistoricVisualDiff(m[2], m[3], parseInt(m[4], 10))
        : renderHistoricA11yDiff(m[2], m[3], parseInt(m[4], 10));
    }
    app.replaceChildren(el('p', {class: 'empty'}, 'Unknown route: ' + hash));
  } catch (err) {
    app.replaceChildren(el('p', {class: 'empty'}, 'Error: ' + err.message));
  }
}

window.addEventListener('hashchange', route);
route();
