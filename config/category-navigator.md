# Category navigator coverage

Run `./visual-regression.sh --filter category-navigator` for the shared navigator's
interaction and consumer scenarios. The older four browsing/search snapshots remain
in the `categories` group.

| Group | Covered states |
| --- | --- |
| Browsing | Initial dialog focus, root header without breadcrumbs, child header |
| Keyboard | Search, header/footer Close, parent, breadcrumb, drilldown, action, clear search, search result |
| Pointer | Close, parent, breadcrumb, clear-search and protection tooltips; statistics info disclosure opened by click; folder hover |
| Tooltip exclusion | Statistics icon hover does not open the statistics disclosure |
| Category moves | Single/bulk move, disabled current destination, disabled descendant, confirmation and cancel/focus restoration |
| Event moves | Single/bulk move, disabled current destination, confirmation, publishing |
| Form pickers | Event creation, event cloning, designer-template cloning |

Every scenario captures Chromium and Firefox visuals and Chromium's accessibility
tree. Keyboard states use real Tab presses rather than programmatic focus. The
`candidateChecks` selectors assert the intended state after stabilisation/hover;
failed setup or checks produce exit code 2 instead of an apparently valid resting
state screenshot. The icon-exclusion check waits 700ms, beyond the tooltip's 500ms
delay, before asserting that no tooltip appeared. Confirmation uses a trial click
to verify that the prompt is not covered, then cancels after capture and verifies
focus restoration. Checks are skipped when recording master baselines, since the
old implementation may lack the focusable control or custom tooltip entirely.

The category-navigator seed supplies a source, its descendant, an eligible sibling
destination, a protected category and a clonable template. Publishing reuses the
existing unlisted registration-form event. Scenarios stop at confirmations and do
not submit moves, publish events or create clones.

New baselines must be captured from compiled master using `INDICO_SRC` pointing to
an isolated checkout, never from the candidate branch. The fixture adds categories
to the root listing, so refresh affected master category baselines when introducing
the fixture before comparing the candidate.

The isolated checkout also needs the compiled translation catalogs corresponding
to master; otherwise language controls and British-English labels produce false
collateral diffs.

The native-modal follow-up additionally asserts `:modal` in each open navigator
state and waits for the close/parent/breadcrumb/clear tooltips in keyboard focus
states. Baseline actions use the actual legacy breadcrumb/footer selectors. Five
legacy targets (parent, drilldown, action, clear icon, search result) are not native
keyboard controls: explicit baseline checks verify their unfocusable markup rather
than timing out while searching for new control classes. Focus-target misses in
these checked scenarios now fail the run.

The two existing category export hint scenarios target native `title` controls.
They verify the hover target and title attribute; browser-chrome native title
bubbles are not part of Playwright screenshots, so these do not claim custom
tooltip visual coverage.

`runner/category_navigator.spec.ts` checks modal AX state, background focus
exclusion, Tab/Shift+Tab, Escape/opener restoration, nested clone picker Escape,
confirmation cancellation, event-confirmation clickability and the statistics
disclosure (click and Enter toggle, expanded state, placement, Escape, outside-click close without summary focus, inside click keeps it open). Run via Playwright
in the seeded runner container with `--browser=chromium` and `--browser=firefox`.
`NAVIGATOR_BASELINE=1` runs only the geometry measurement against master.

Snapshots and DOM focus checks do not substitute for a screen-reader session.
