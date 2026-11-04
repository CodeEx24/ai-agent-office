# AGO-53 - Spike: generate one character concept sheet with Higgsfield

## Overview
Jira: AGO-53 (US-003), Epic EP-10, Wave 1, WS-D (3D Office & Assets), Area Assets. Spike: confirm Higgsfield access and credit budget, then generate one character concept sheet (front, side, back) to test style and consistency. No product code, no dependencies.

Risk tier: low (docs and a single image asset; no auth, data model or money surface in the repo). The only spend is Higgsfield credits, gated by the owner (see below).

## Spend record (recorded BEFORE any generation - AC 1)
Recorded 2026-11-04 via the Higgsfield MCP (`balance`, and `generate_image` with `get_cost: true`, which submits nothing).

| Item | Value |
|---|---|
| Plan | pro |
| Credit balance before generation | 900 credits |
| Budget cap | 1 credit (hard max for this spike; one generation, count 1) |
| Exact quote, one concept sheet (1 image, 16:9, 3 views) | 0.25 credits |
| Model | `gpt_image_2_5` (Higgsfield default general image model; strong prompt adherence for multi-view layouts) |
| Aspect ratio / count | 16:9 / 1 |
| Free / unlim generations | Not used (`use_unlim` not set) |
| Approval | Coordinator replied "approved (1 credit cap)": one generation as quoted, no regeneration without asking again |

### Result
Generated once (job `a64ffb54-e0f6-45c4-92b9-f7402d09817e`). Balance after: 899.75 credits, so actual spend was 0.25 credits, within the 1-credit cap. Saved as `docs/assets/concepts/pixel-concept-sheet.webp` (1344x752, 34 KB; the 928 KB PNG was converted and not kept) with its prompt in `docs/assets/concepts/pixel-concept-sheet.prompt.md`. Front, side and back views are visibly the same character (outfit, antenna, lanyard, wristband and teal-soled sneakers match across views). Owner style verdict: PENDING (see PR).

### Prompt
```
Character turnaround concept sheet, three consistent full-body views in a row evenly spaced on a pure white seamless studio background: front view, side profile view, and back view, identical original character on all views, same pose, standing upright in a neutral A-pose with feet flat on the ground, entire body head-to-toe in frame and not cropped. Original stylized 3D character for a friendly virtual-office simulation: an adult android office assistant named Pixel, mature adult proportions about 6.5 heads tall, smooth matte warm-grey ceramic face with softly angular jaw and defined cheekbones, two round glowing teal eyes with subtle muted highlights, a thin teal antenna on the left side of the head, short geometric charcoal hair-cap shell, slim athletic build. Wardrobe head-to-toe: fitted navy blazer with rolled sleeves over a cream knit polo, slim charcoal chinos with a brown leather belt, white low-top sneakers with teal soles, a small teal lanyard badge at the chest (blank, no text), a matte silver wrist band on the left wrist, no bag. Stylized 3D character render, appealing clean shapes, soft global illumination, three-point studio lighting with gentle rim light, clean neutral background, game-ready concept art, sharp focus, 4K. Single subject only, no other people, no props, no furniture, no text, no watermark, no logos, no frame borders, no labels, does not resemble any existing copyrighted character.
```
Prompt built with the Higgsfield `character-sheet` workflow (3d-stylized preset, original character only).

## Decisions taken
| Decision | Choice | Reason |
|---|---|---|
| Spend gate | Quote first, generate only after coordinator "approved" | Owner's instruction ("quote first") |
| Model | `gpt_image_2_5` | Recommended default for prompt-adherent general generation |
| Style preset | 3d-stylized, original android "Pixel" | Matches the 3D virtual-office product; original IP only |
| Views | Front, side, back (3 views) | AC 2; the workflow's 4-view turnaround drops the 3/4 view to match the AC |
| Asset location | `docs/assets/concepts/` | AGO-57 (scaffold, `packages/assets/`) has not merged yet; move later |
| Format | Web-optimised PNG/WebP, kept small | Brief constraint |

## Implementation details
Docs and image asset only. Files: this note, plus the sheet and its prompt under `docs/assets/concepts/`.

## API changes
None.

## Database changes
None.

## Dependencies on other tickets
AGO-57 (scaffold): once merged, move the sheet to `packages/assets/concepts/`. AGO-28 (art direction guide) will consume the style verdict.

## Known limitations
Single-shot generation; consistency across multiple sheets is not tested here. Owner style verdict pending.

## Testing notes
No code. The repo has no lint/typecheck/test scripts yet, so those gates are skipped. Manual check: image opens, three views are visible, prompt file matches this note.

## Follow-up tasks
- Move the sheet to `packages/assets/concepts/` after AGO-57.
- Feed the verdict into the AGO-28 art direction guide.
