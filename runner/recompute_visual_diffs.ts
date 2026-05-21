// One-shot: re-run compareImages against every stored (baseline, proposal)
// pair and rewrite visual_diffs rows. Used after fixing the diff algorithm
// to avoid re-capturing the whole suite from scratch.
import {openDb} from './storage.js';
import {compareImages} from './visual_diff.js';

const db = openDb();
const rows = db.prepare(`
  SELECT vd.page_id, vd.persona, vd.browser, vd.baseline_id,
         vd.image AS proposal, vb.image AS baseline
  FROM visual_diffs vd
  JOIN visual_baselines vb ON vb.id = vd.baseline_id
`).all() as Array<{
  page_id: string;
  persona: string;
  browser: string;
  baseline_id: number;
  proposal: Buffer;
  baseline: Buffer;
}>;

console.log(`recomputing ${rows.length} visual diffs...`);
const update = db.prepare(`
  UPDATE visual_diffs
  SET diff_image = ?, pixel_count = ?, pixel_pct = ?
  WHERE page_id = ? AND persona = ? AND browser = ?
`);
const del = db.prepare(`
  DELETE FROM visual_diffs WHERE page_id = ? AND persona = ? AND browser = ?
`);

let updated = 0;
let cleared = 0;
for (const r of rows) {
  const cmp = compareImages(r.baseline, r.proposal);
  const tag = `${r.page_id}/${r.persona}/${r.browser}`;
  if (cmp.unchanged) {
    del.run(r.page_id, r.persona, r.browser);
    cleared += 1;
    console.log(`  ${tag} → cleared (now matches)`);
  } else {
    update.run(cmp.diffImage, cmp.pixelCount, cmp.pixelPct, r.page_id, r.persona, r.browser);
    updated += 1;
    console.log(`  ${tag} → ${cmp.pixelPct.toFixed(3)}% (${cmp.pixelCount} px)${cmp.sizeMismatch ? ' [size-padded]' : ''}`);
  }
}

console.log(`\ndone: ${updated} updated, ${cleared} cleared.`);
db.close();
