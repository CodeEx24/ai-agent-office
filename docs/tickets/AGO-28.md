# AGO-28 - Write the art direction and style guide

## Overview
Jira: AGO-28 (US-001), Epic EP-10, Wave 1, WS-D (3D Office & Assets), Area Assets. Blocked by AGO-53 (Done). Writes the one-page art direction guide at `docs/art/style-guide.md`, building on art direction v1 chosen by the owner in AGO-53 (toon / 3D cartoon, approved 2026-11-05, revisable).

Risk tier: low (docs only; no code, dependency, auth, data or spend).

Acceptance criteria (verbatim):
- Style guide lists proportions, palette, lighting and polygon budget
- Two or three reference images are attached and one is approved
- Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done)

## Implementation details
- New file `docs/art/style-guide.md`, marked "v1, revisable": style decision, reference images, character proportions and silhouette, palette as hex tokens, lighting (key/fill/rim, time of day, emissive teal), materials, fantasy scenery framing the office sides (to be built by AGO-36 / AGO-106), and a polygon, texture and draw-call budget.
- Reference images reused from AGO-53 in `docs/assets/concepts/` (approved: `pixel-v1-character-sheet.webp`, `office-v2-environment.webp`; rejected: `pixel-v0-rejected.webp`, `office-v1-rejected.webp`). No new images generated, no credits spent.
- Palette hex values were sampled with a script from the approved images (Pillow region averages); where the sample was muddy or in shadow (cream shirt, leaf green) the guide says the value is eyeballed.
- Budgets align with AGO-169 targets (60 fps on a mid-range laptop with 8 agents, 30 fps on a phone). They are recommendations; AGO-169 measures and may tighten them.

## API changes
None.

## Database changes
None. No migration; schema slot not used.

## Dependencies on other tickets
- AGO-53: reference images and art direction v1 (done).
- Feeds AGO-36 (room and prop assets), AGO-106 (scenery), AGO-59, AGO-49 and AGO-169 (budget).

## Known limitations
- Budget numbers are untested estimates until AGO-49 (image to 3D spike) and AGO-169 measure real assets.
- Two hex tokens are eyeballed (see guide). Images stay in `docs/assets/concepts/` until moved to `packages/assets/`.

## Testing notes
Docs only. The repo has no lint, typecheck or test scripts yet (root `package.json` has build, dev, typecheck and clean only, with no workspaces that define them), so those gates are skipped and the PR says so. Manual check: guide renders, links to the images resolve, every AC item is present.

## Decisions taken
| Decision | Choice | Reason |
|---|---|---|
| Style | Toon / 3D cartoon (v1) | Owner already chose it in AGO-53; recommended option; revisable |
| Reference images | Reuse the AGO-53 images, one approved plus rejected ones as "avoid" | Satisfies "two or three images, one approved" without spending Higgsfield credits; cites the 2026-11-05 owner approval |
| Guide location | `docs/art/style-guide.md` | Coordinator suggestion; docs-only change |
| Head-to-body ratio | About 3 heads tall (2.5 to 3.5) | Matches the approved character sheet |
| Budgets | Character 5k to 8k tris, scene target 250k, 100 draw calls | Mid-range hardware plus AGO-169 targets; to be validated |

## Follow-up tasks
- Validate budgets with real assets (AGO-49, AGO-169) and tune the guide.
- Move concept images to `packages/assets/concepts/` (AGO-53 follow-up).
