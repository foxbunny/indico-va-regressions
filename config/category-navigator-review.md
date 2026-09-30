# Category navigator regression review — 2026-09-24

## Native-modal follow-up

The navigator now uses `showModal()`, native cancel handling and `::backdrop`.
It retains initial focus on the whole dialog, closes before category confirmation,
and reopens/refocuses on cancellation. No `aria-modal` workaround was added.
Six persistent acceptance tests pass in both Chromium and Firefox, covering
modal AX state (Chromium), excluded background focus, keyboard containment,
Escape/opener restoration, category-confirmation Cancel/Escape, nested clone
pickers, event-confirmation clickability, Space navigation, header height and
backdrop dismissal. All 13 existing unit tests and `make lint` pass.

The former target misses are resolved: real legacy breadcrumb/footer selectors
are used; five genuinely unfocusable old controls have explicit checked baseline
states; export hints target native-title controls. Focus tooltip captures now wait
for the shown state. Both master capture groups completed without target misses.

Measured category-move geometry at 1280×900 (Chromium):

| Element | Master | Candidate | Change |
| --- | --- | --- | --- |
| Dialog top | 80.28px | 95px | +14.72px |
| Dialog height | 739.42px | 710px | -29.42px (4.0%) |
| Dialog width | 832px | 830px | -2px |
| List width | 800px | 800px | unchanged |
| List top | 204.91px | 215.78px | +10.87px |

This is a modest pre-existing rewrite difference, left unchanged per the user's
instruction to tolerate small shifts. Native modality itself leaves the sampled
initial-focus, root, category-move, stats-hover, stats-icon and folder-hover
Chromium screenshots byte-identical to the preceding candidate.

Viewer: http://localhost:8002/#/diff/visual/chromium/navigator-category-move/admin

Live example: http://indico.local:8001/category/16/manage/ (use a child row's move
arrow). Existing Accessibility research categories suffice; no data was created.
Both pages were opened in host Brave and the viewer returned HTTP 200 from Windows.

Evidence: `todo/a11y-screenshots/category-navigator-native-modal/` in the Indico
checkout; logs are prefixed `modal-`. The original review below is historical:
flags 1, 5, 6 and 7 are now resolved; small styling differences and full-page
below-viewport backdrop differences remain documented. No screen-reader session,
commit or publication was performed.

## Original expectation-led comparison

The [expectation map](category-navigator-expectations.md) was recorded before this
run's diff inspection. Baselines were freshly captured from clean, isolated master
`115e4a4eb4010ee5ef091b6a6fed4e5ce22f7a8c`; the candidate is the uncommitted
`a11y-category-navigator` working tree. No candidate output was promoted to baseline.
Matching generated Python and React translation catalogs removed the previous
English spelling noise. No application source was changed during this review.

| Scope | Captures | Differences |
| --- | --- | --- |
| 32 new states | 64 screenshots, 32 AX trees | 64 visual, 31 AX |
| 13 existing category/persona states | 26 screenshots, 13 AX trees | 8 visual, 4 AX, all in the four navigator states |
| Unrelated category states | Included above | 0 visual, 0 AX; export-tooltip setup limitation still applies |

All new candidate state assertions passed in Chromium and Firefox. Both candidate
runner logs report differences rather than capture/assertion failures. Passing
these assertions does not clear the mismatches below.

## Confirmed expectations

| Area | Observed result |
| --- | --- |
| Initial focus and controls | Candidate state assertions pass in both browsers; initial focus is on the dialog, controls have descriptive AX names, navigation uses links, and actions remain visible without hover. |
| Focus geometry | Inspected search, close, parent, drilldown, clear and search-result captures show visible focus outlines; parent and browsing drilldown fill row height, search-result title remains content-height. Dialog/list widths remain approximately 830/800px at the captured desktop size. |
| Root title | Centered within the reserved breadcrumb-height header; the root row grows relative to master as intended by the earlier height-equality correction. |
| Pointer tooltips | Close, parent, breadcrumb, stats, clear, protected-category and disabled-destination states pass shown-tooltip assertions; sampled screenshots show the expected design-system tips. |
| Statistics and folder | Counts retain icon and vertical-bar shorthand; AX exposes category/event phrases instead; numbers show the expanded tooltip, icon-only hover does not; folder appears after the hovered title. |
| Move constraints | Current/descendant destination controls are disabled; empty disabled event destination has no select shortcut. |
| Category confirmation | Prompt is visible and trial-clickable; cancel restores dialog focus in both browsers. Hiding the navigator beneath it differs from master but matches the recorded expectation. |
| Other callers | Publishing and creation/event-clone/template-clone pickers load; assertions confirm dialog focus; no move, publish or clone was submitted. |

## Flagged mismatches and evidence limits

1. **High — modal semantics lost.** The AX diff for `navigator-initial-focus`
   changes `dialog ... [modal]` to `dialog ...` without modal state. This recurs
   across the navigator callers. The implementation uses `<dialog open>` rather
   than opening a native modal. Passing focus-target assertions does not establish
   focus containment or background inertness; the accessibility gate is not met.
2. **Layout — subtitle dialogs do not preserve legacy geometry.** Category/event
   moves and publishing now render the subtitle alongside the title inside its
   header with larger text, instead of the old separate subtitle strip. In the
   Chromium category-move pair, the outer dialog moves from roughly y=80–820 to
   y=95–805, while the list starts lower. Width is preserved, but typography and
   overall height/position are not. This is outside the expected action/stat swap
   and root-header height correction.
3. **Backdrop — full-page background differs below the viewport.** Event move,
   publish and event-clone screenshots reveal undimmed page content below y=900
   in the candidate. The event-move confirmation panel itself is unchanged and
   its AX tree has no diff, but its screenshot still differs by about 0.41% in
   Chromium. The fixed-viewport versus document-height overlay distinction needs
   a scroll/viewport test before classifying this as a user-visible defect rather
   than a full-page capture difference; do not call it pixel-identical.
4. **Minor styling — protected-row spacing differs.** The shield now nearly
   touches the category title and the protected title begins further left than
   master. This has no identified accessibility requirement and does not match
   the expectation of preserving unaffected styling.
5. **Coverage — keyboard tooltip visibility is not established everywhere.**
   Parent, breadcrumb and clear focus captures show the focus outline without
   a visible tooltip. Their checks assert focus but do not wait for the tooltip's
   delayed shown state. Pointer tooltip success does not prove keyboard tooltip
   success; add explicit focus-plus-tooltip assertions and recapture before
   accepting that requirement. This run alone cannot distinguish a timing issue
   from an application defect.
6. **Baseline coverage — seven legacy focus targets fail per browser.** Parent,
   breadcrumb, drilldown, action, footer Close, clear and search-result cases
   capture fallback master states. Some selectors only name new markup; notably
   legacy footer Close is `button[data-button-back]`, not a button inside
   `.ui-dialog-buttonpane`. These are unavailable before-focus comparisons, not
   evidence that all seven legacy controls were unreachable.
7. **Existing suite gap — two unrelated export-tooltip targets fail in both
   master and candidate.** Matching resting screenshots cannot validate these
   tooltip states.

Evidence: `/home/indico/indico/todo/a11y-screenshots/category-navigator-expectations/`.
Files use `PAGE-BROWSER-before.png`, `-after.png`, `-diff.png`, and
`PAGE-ax-diff.txt`; `expect-*.log` records baseline/candidate runs. The frozen
pre-run expectation map is included. Screenshots and AX inspection are not an
actual screen-reader session; no publication or acceptance of the flagged diffs
is implied.
