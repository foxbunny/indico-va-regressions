# Category navigator: expectations before the fresh regression run

Recorded before inspecting this run's diffs. Compare the candidate against isolated
master, not against an earlier candidate. Existing known defects are exceptions to
flag, not reasons to relax the expected behavior.

| States | Expected candidate result and difference from master |
| --- | --- |
| Initial focus / root centered | Focus starts on the named dialog; no search caret; root title vertically centered, same header height as breadcrumb header. Dialog/list widths and underlying page geometry preserved. |
| Search, close, parent, breadcrumb, drilldown, action, footer, clear, result focus | Actual keyboard focus reaches the named control with a visible focus indication; actions remain visible without hover; browsing drilldown and parent hit areas fill their rows, search-result controls retain content height. No focus-induced layout shifts. |
| Close, parent, breadcrumb, clear tooltips | Design-system tooltip visible with the correct translated text and target; no Browse subcategories tooltip. Legacy native-title tips may have no screenshot counterpart. |
| Statistics tooltip / icon exclusion | Icon and `N \| M` presentation preserved; expanded independently pluralized text in the tooltip, shorthand excluded from AX; hovering the icon alone shows no tooltip. |
| Folder hover / protected category | Decorative folder appears after the hovered title without changing geometry; protection explanation shown on its intended target. |
| Category single/bulk moves / descendant | Correct move labels and destination constraints; current parent and invalid descendants disabled; eligible destinations enabled; no enabled shortcut bypasses a disabled destination. |
| Category move confirmation | Confirmation visible, actionable and above the page; navigator hidden while confirming; cancel restores navigator focus. Flag changes to legacy confirmation presentation separately. |
| Event single/bulk moves / disabled tooltip | Correct event destination constraints and explanation; no select-this-one bypass in an empty disabled category. |
| Event move confirmation | Existing confirmation contents and geometry unchanged; no obscuring navigator. |
| Publishing | Unlisted event initializes the root navigator without an exception; appropriate destination selection available. |
| Creation / event clone / template clone | Correct picker opens above its caller with dialog focus and preserved dimensions; underlying forms and their values unchanged. |
| Existing category states | Only the four navigator browsing/search states should change; display pages and unrelated dialogs/tooltips must remain pixel/AX identical. |

Across all states: use existing design-system colors/type; expect semantic buttons,
expanded stats and descriptive control names in AX, without lost dialog naming or
modal semantics. A missing modal state, missing tooltip/focus target, unexpected
background change, clipping or shifted width is a flagged mismatch. Failed legacy
setup means the corresponding before-state is unavailable, not a valid matched
interaction. Browser/AX checks do not constitute a screen-reader test.

Known environment issue to resolve before capture: generated React translation
catalogs must match between master and candidate, as must the Python catalogs.
