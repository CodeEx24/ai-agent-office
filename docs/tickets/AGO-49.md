# AGO-49 - Spike: image to 3D mesh, rig and animation in three.js

## Overview
Jira: AGO-49 (US-002), Epic EP-10, Wave 1, WS-D (3D Office & Assets), Area 3D. Blocked by AGO-28 (style guide, done) and AGO-61 (Next.js, done).

Turn the owner-approved Pixel v1 character sheet (AGO-53) into a GLB, get a humanoid rig, apply animation and load it in a React Three Fiber test page.

Risk tier: low-medium. No auth, data model or DB surface. The risks are spend (Higgsfield credits, owner-gated) and adding the first three.js dependency.

## Spend record (recorded BEFORE generation)
| Item | Value |
|---|---|
| Plan / balance before | pro / 899 credits |
| Model | `meshy_v7_image_to_3d` through Higgsfield `generate_3d` |
| Source image | front view cropped (440x740) from `docs/assets/concepts/pixel-v1-character-sheet.webp` |
| Params | standard, triangle, `target_polycount` 8000, `pose_mode` a-pose, textured, no PBR, rigging on (1 m), animation on (`Casual_Walk`, id 30) |
| Quote: mesh only | 38 credits |
| Quote: mesh + rig | 44 credits |
| Quote: mesh + rig + 1 animation | 47.5 credits |
| Approval | Coordinator, relaying the owner: ONE run at 47.5 credits, hard cap 100 credits for the whole spike, no retries without a new approval; idle clip preferably free, any paid `3d_rigging` pass needs its own quote and approval |
| Job | `5860298c-b4cf-4860-81f7-1e9ee8e6163e` (one run, completed first time) |
| Balance after | 851.5 credits (exactly 47.5 spent; 52.5 of the 100 cap unused) |

Quotes came from `get_cost: true`, which submits nothing. No other generation, retry or paid rigging pass was run.

## Findings

### Is Higgsfield's output rigged and usable? Yes, with post-processing
Higgsfield exposes Meshy 7 image-to-3D. With `enable_rigging` and `enable_animation` it returns one GLB that is already skinned and animated:
- 1 skinned mesh, 1 material, 24-joint humanoid skeleton with Mixamo-style names (`Hips`, `Spine`, `Spine01`, `Spine02`, `Head`, `LeftUpLeg`, ...). No finger bones.
- Exactly one clip, the one requested (`Armature|Casual_Walk|baselayer`, 4 s, 66 channels). Meshy applies one animation per run, so idle is a second step.
- The reconstruction keeps Pixel's identity (antenna with teal tip, teal eyes, lanyard badge, rolled blazer sleeves, teal-soled sneakers). See `docs/assets/3d/dev-3d-idle.png` and `dev-3d-walk.png`.
- Armature is scaled 0.01 (centimetres). It renders at the right size under `rigging_height_meters: 1`.

Problems found in the raw output, all fixed by `packages/assets/scripts/optimize-character.mjs`:
- Texture is a 2048x2048 JPEG (2.31 MB, about 22 MB GPU), over the style guide's 1024 cap and most of the 32 MB scene budget.
- Unused TANGENT attribute (no normal map in our look).
- Clip name is vendor-specific; renamed to `Walk`.
- The skin tone bakes darker and browner than the approved warm grey (`skin-android` `#908277`). Colour needs a pass (texture tint or a material colour correction) before the character ships. Not fixed in this spike.
- Hands are simplified but the rest pose is a slightly wide A-pose; fine for skinning.

### Budget check (style guide section 8, character row)
| Measure | Budget | Raw Higgsfield GLB | Shipped GLB (`pixel-v1.glb`) |
|---|---|---|---|
| Triangles | 5k to 8k, hard cap 10k | 8,261 | 8,261 (over the 8k target by 261, under the cap) |
| Bones | at most 40 | 24 | 24 |
| Materials | 1 | 1 | 1 |
| Base colour texture | 1024x1024 | 2048x2048 JPEG, 2.31 MB | 1024x1024 WebP, 97.6 KB |
| GPU texture memory (approx.) | scene cap 32 MB | about 22 MB | about 5.6 MB |
| Clips | idle + walk in the same GLB | walk only | `Idle`, `Walk` |
| File size | none set; asks above 5 MB | 3.21 MB | 292,912 bytes (0.29 MB), meshopt |

File size by compression, same content (resized WebP texture, both clips):
| Variant | Bytes |
|---|---|
| Raw Higgsfield GLB | 3,212,524 |
| Uncompressed (resized + WebP) | 1,009,588 |
| Draco | 489,228 |
| Meshopt (shipped) | 292,912 |

Meshopt was shipped over Draco: smaller here, and three's meshopt decoder is bundled, while the Draco decoder loads from a CDN by default (an offline/CI hazard).

### Recommended pipeline
1. Crop the front view from the approved character sheet (image-to-3D wants one subject; a three-view sheet confuses it).
2. Higgsfield `generate_3d` with `meshy_v7_image_to_3d`: standard, triangle, `target_polycount` 8000, A-pose, textured, no PBR, rigging on, one animation. Quote first with `get_cost: true`.
3. `node packages/assets/scripts/optimize-character.mjs <raw.glb> <out-dir>`: drops tangents, renames clips, bakes the Idle clip, resizes the texture to 1024 WebP, writes meshopt (shipped), Draco and uncompressed variants and prints the numbers.
4. Commit only the meshopt GLB to `packages/assets/models/`. `apps/web` copies it to a gitignored `public/models/` at `predev`/`prebuild`.
5. Check the numbers against the style guide table in the PR.

### Per-character cost
47.5 credits for mesh + rig + one animation at this setup (38 mesh + 6 rig + 3.5 animation). Extra clips from Meshy are not quoted here; the one thing not measured is the cost of a rig-only `3d_rigging` pass to add more clips. No dollar figure is stated because the credit-to-currency rate is plan dependent. At 8 agents the all-new-mesh cost is about 380 credits; agents that share the skeleton (AGO-64) reuse clips for free.

### Fallbacks
- **Idle clip (used here):** authored in code (`addIdleClip`): 2 to 3 degree sway on spine, head and arms, baked at 30 fps over 4 s, seamless loop, each key is rest rotation times a small delta. Free, no licence, reproducible. It reads as breathing, not as a polished animation.
- **CC0 clip packs** (for example Quaternius Universal Animation Library): free, no account, but its skeleton differs from Meshy's 24-bone one, so using it means retargeting. That is AGO-64's scope (shared skeleton and retargeting), so it was not attempted. Blender is not installed on this machine.
- **Blender Rigify:** free, would rig an unrigged mesh. Needs Blender, which is not installed. Not needed because Higgsfield's output was already rigged.
- **Mixamo:** needs an Adobe account, which is the owner's credential. Not used; ask the owner before relying on it. The Meshy skeleton already uses Mixamo-style names, which should make Mixamo clips a close fit.
- **Paid `3d_rigging` pass** on the finished GLB for more Meshy clips: not run, needs its own quote and approval.

### Decision for the owner / follow-ups
The pipeline works end to end for roughly 47.5 credits per character. Before it becomes the default: fix skin colour, decide how idle and other clips are sourced (AGO-64), and consider KTX2 for textures (see Follow-up tasks).

## Decisions taken
| Decision | Choice | Reason |
|---|---|---|
| Source image | Front view crop, not the whole 3-view sheet | Image-to-3D reconstructs one subject |
| Mesh model | Meshy 7 via Higgsfield | Only listed 3D model that rigs and animates in one call; cheapest total (47.5) |
| Polycount target | 8000 triangles | Style guide 5k to 8k band (cap 10k) |
| Pose | A-pose | Style guide section 3 |
| PBR | Off | Style guide: matte clay, one base colour map |
| Walk clip | `Casual_Walk` (id 30), paid, same run | 3.5 credits over rig only |
| Idle clip | Authored in code, not a retargeted CC0 clip | Owner preferred a free CC0 clip, but Blender is not installed and the Quaternius skeleton differs from Meshy's; retargeting is AGO-64. Recorded as a deviation from the owner's stated preference |
| Compression shipped | Meshopt, not Draco | Smaller (0.29 MB vs 0.49 MB) and its decoder is bundled; Draco decoder is fetched from a CDN by default |
| Texture | 1024x1024 WebP | Style guide cap; the 2048 JPEG was about 22 MB of GPU memory |
| Tangents | Dropped | No normal map in the style guide |
| Where the GLB lives | `packages/assets/models/pixel-v1.glb` (canonical), copied to gitignored `apps/web/public/models/` by `predev`/`prebuild` | CLAUDE.md puts large binaries in `packages/assets`; one binary in git, still served as a static file |
| Git LFS | Not enabled | The asset is 0.29 MB; LFS is a repo setting outside this ticket and has quota limits. Raised as a follow-up |
| Raw GLB / source URL | Not committed | Raw is 3.2 MB and not game-ready; the URL contains the account's user ID. The job ID is recorded above |
| Lighting in the viewer | Hemisphere + warm key + teal rim from the style guide; no drei `Environment` preset | Presets download an HDR from a CDN at runtime, which makes the E2E network-dependent |
| `frustumCulled` | Off in the spike viewer | Skinned bounds come from the bind pose |
| Test page gate | `isDev3dEnabled()`: on outside production, `ENABLE_DEV_3D=1` in production | Task brief: gate like `/dev/ui` |
| E2E env | `ENABLE_DEV_3D=1` added to the Playwright `webServer` env | E2E runs on a production build |
| three.js stack | `three` 0.187.0, `@react-three/fiber` 9.8.2, `@react-three/drei` 10.7.9, `@types/three` 0.187.0, exact pins, only in `apps/web`, client-only via `next/dynamic` `ssr:false` | Locked stack; isolation requested |
| Pipeline tooling | `@gltf-transform/*` 4.5.1, `meshoptimizer`, `draco3dgltf`, `sharp` as devDependencies of `@ago/assets` | Dev-time only; runs from a script, never bundled into the app |

## Implementation details
- `apps/web/src/features/dev-3d/`: `model-stats.ts` (triangle, bone, texture and clip helpers), `Dev3dViewer.tsx` (R3F canvas, Idle/Walk buttons, stats panel), `Dev3dViewerLoader.tsx` (client-only dynamic import), `is-dev-3d-enabled.ts`.
- Route `apps/web/src/app/dev/3d/page.tsx`, `force-dynamic`, `notFound()` when disabled, not linked from navigation.
- `apps/web/scripts/sync-models.mjs`: copies `packages/assets/models/*.glb` into `public/models/` (gitignored).
- `packages/assets/scripts/optimize-character.mjs`: the pipeline described above.
- Tests: Vitest for the helpers and the gate; Playwright `e2e/dev-3d.spec.ts`.

## API changes
None.

## Database changes
None. No migration, no schema slot used.

## Dependencies on other tickets
AGO-28 (budgets), AGO-53 (source image). Feeds AGO-64 (shared skeleton and retargeting spike) and AGO-36 (room and prop assets).

## Known limitations
- The idle clip is a procedural sway, not a hand-made animation.
- Skin colour is darker than the approved concept; no colour correction was done.
- No LOD1 (style guide asks for 2k to 3k triangles at distance) and no KTX2/Basis texture compression (`toktx` not installed). The texture is WebP.
- Triangles are 261 over the 8k target (under the 10k hard cap).
- The viewer disables frustum culling on every object, fine for a one-model dev page, not for the office scene.
- Only one character, one generation: consistency across characters was not tested.
- The E2E needs WebGL. It passed locally on Microsoft Edge; CI uses bundled Chromium without a GPU, so the CI result is the real check. If it reports a WebGL context error the fix is software-GL launch args on the Playwright project, not loosening the console-error guard.
- `three` logs one `THREE.Clock` deprecation warning from inside R3F (a warning, not a console error; the guard only fails on errors).

## Testing notes
- Unit: `pnpm test` (13 web tests, including `model-stats.test.ts` and `is-dev-3d-enabled.test.ts`).
- E2E: `PORT=$(node scripts/free-port.mjs) pnpm test:e2e` builds, starts `next start`, and runs `dev-3d.spec.ts`: page loads, canvas visible, stats leave "loading", Idle and Walk are listed, both buttons toggle, no console errors or page errors.
- Manual: `/dev/3d` driven in a headless browser, screenshots in `docs/assets/3d/`, console clean (one three.js deprecation warning).
- Gates run locally: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, all green. (`pnpm lint` crashed once with a native abort when packages linted in parallel; it passes with `--concurrency=1` and per package.)

## Follow-up tasks
- Fix the skin colour of the generated texture against `skin-android`.
- Decide how clips are sourced for all agents (retarget CC0 packs onto the shared skeleton): AGO-64.
- KTX2/Basis texture compression once `toktx` is available in the asset pipeline.
- LOD1 for characters.
- Git LFS decision for GLBs once the total asset size grows (repo setting, owner).
- A GLB manifest in `packages/assets` (the placeholder `ASSET_MANIFEST` is still empty).
