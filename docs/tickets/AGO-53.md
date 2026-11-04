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

### Result: v0 (REJECTED)
Generated once (job `a64ffb54-e0f6-45c4-92b9-f7402d09817e`). Balance after: 899.75 credits (0.25 spent, within the 1-credit cap). Saved as `docs/assets/concepts/pixel-v0-rejected.webp` (34 KB) with its prompt in `pixel-v0-rejected.prompt.md`. Front, side and back views were consistent. Kept for reference only.

**Owner verdict on v0: REJECTED.** The semi-realistic style is not wanted.

## Art direction v1 (owner direction; revisable, not final)
Owner direction after rejecting v0: 3D cartoon look (stylized, rounded, big-head friendly proportions, animated-film feel). Keep Pixel's identity (android, glowing teal eyes, small antenna, navy blazer, cream shirt, teal lanyard badge, charcoal chinos, white sneakers with teal soles). Front/side/back turnaround in a neutral rig-friendly pose. A second image shows an office scene in the same style with fantasy environments (floating islands, glowing forest, waterfalls) framing the office.

**The owner may change this direction later, so AGO-28 (art direction guide) must treat v1 as revisable input, not a final decision.**

### v1 spend record
| Item | Value |
|---|---|
| Approval | Owner approved up to 1 credit total for these 2 generations (about 0.25 each); nothing else generated |
| Balance before v1 | 899.75 credits |
| Quotes (`get_cost`, preflight) | 0.25 credits each (character sheet), 0.25 credits (environment) |
| Balance after v1 | 899.25 credits (0.5 spent in v1; 0.75 across the whole spike) |
| Model | `gpt_image_2_5`, 16:9, count 1 each |
| Character sheet | job `8357c965-b3f1-45b3-992a-508def64d4d4` -> `docs/assets/concepts/pixel-v1-character-sheet.webp` (41 KB), prompt in `pixel-v1-character-sheet.prompt.md` |
| Environment | job `3636c0bc-3ff8-4fad-a2f1-6de563b4219f` -> `docs/assets/concepts/office-v1-environment.webp` (212 KB), prompt in `office-v1-environment.prompt.md` |

Assessment (agent, for the owner): the character sheet reads as 3D cartoon with big-head proportions, and the three views are consistent (antenna, lanyard badge, wristbands, rolled sleeves, teal-soled sneakers). The environment matches the composition brief (glass office framed by floating islands, waterfalls and glowing mushroom forest) but its rendering leans semi-realistic and cinematic rather than clearly cartoon; if the owner wants a flatter, rounder look, that needs another generation and a new spend approval.

Owner verdict on v1: PENDING (requested via the coordinator).

### Prompt (v0, rejected)
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
| Style after v0 rejection | "Art direction v1": 3D cartoon, owner-specified; revisable | Owner decision; owner may change direction later |
| v1 generations | Exactly 2 (character sheet + environment), within the 1-credit total approval; no retries | Owner's spend limit; environment rendering looks semi-realistic but was not regenerated without a new approval |

## Implementation details
Docs and image assets only. Files: this note, plus the v0 (rejected) sheet and the v1 character sheet and environment image, each with its prompt, under `docs/assets/concepts/`.

## API changes
None.

## Database changes
None.

## Dependencies on other tickets
AGO-57 (scaffold): once merged, move the images to `packages/assets/concepts/`. AGO-28 (art direction guide) must treat "art direction v1" as revisable, not final.

## Known limitations
One generation per image; consistency across multiple sheets is not tested here. The v1 environment image renders more semi-realistic than cartoon. Owner verdict on v1 pending.

## Testing notes
No code. The repo has no lint/typecheck/test scripts yet, so those gates are skipped. Manual check: image opens, three views are visible, prompt file matches this note.

## Follow-up tasks
- Move the images to `packages/assets/concepts/` after AGO-57.
- Feed art direction v1 into AGO-28 as a revisable direction.
