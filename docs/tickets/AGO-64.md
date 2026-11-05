# AGO-64 - Spike: shared skeleton and animation retargeting

## Overview
Jira: AGO-64 (US-006), Epic EP-10, Wave 1, WS-D (3D Office & Assets), Area 3D. Blocked by AGO-49 (done).

Test one shared skeleton across two characters with three retargeted clips and measure the frame rate. Builds on AGO-49: the rigged Pixel GLB (Meshy, 24 bones), the optimization pipeline and the dev-only `/dev/3d` page.

Risk tier: low. No auth, data model, DB or agent-runtime surface. Spend risk is the only one, and it was avoided: nothing in this ticket cost money.

## Spend record
| Item | Value |
|---|---|
| Higgsfield / Meshy credits | 0. No generation call, no quote needed. |
| Second character | Free: the CC0 Quaternius Mannequin, re-skinned in code |
| Clips | Free: CC0 Quaternius Universal Animation Library, Standard tier (pay what you want, paid $0, no account) |
| Paid tier of the library (Pro) | Not purchased. It is not needed for idle, walk and talk. |

## Decision: shared skeleton confirmed with changes
**Confirmed:** one 24-bone humanoid bone contract (Meshy's Mixamo-style rig: names plus hierarchy) works for two different characters and for a clip library that was authored on a completely different rig. Any UAL clip can be retargeted onto it by a name map, both characters then expose the same clip names, and eight characters cost very little to animate and draw (see Frame rate).

**Changed (the honest part):**
1. **"Shared" means names and hierarchy, not rest pose.** Pixel rests in an A-pose with Meshy bone axes. The UAL rig rests in a T-pose with Unreal axes. A rotation track copied by bone name is wrong for both. So clips are retargeted in world space and **baked per character at build time** (`bake-retargeted-clips.mjs`), not stored once and bound at runtime to every character. Each character GLB carries its own Idle, Walk and Talk, with identical names and bone names.
2. **The shared rig has no fingers.** Pixel has no finger bones (AGO-49). UAL has 65 joints, 40 of them fingers. Finger animation is dropped, and the Mannequin's finger weights are folded into the hand bone. This also keeps the Mannequin at 24 bones, under the style guide cap of 40.
3. **Hips translation is scaled by hip height** (the ratio of hips height above ground), otherwise a 1.75 m walk cycle would float or sink a 0.93 m character.
4. **Rest-pose normalization is the follow-up** that would allow one shared clip file bound at runtime to all characters. It means re-posing each new character to a common rest pose before skinning.

**Not proven here:** only one Meshy rig was seen, and the second character is a re-skinned CC0 mesh, not a second Meshy generation. Whether Meshy always returns the same 24 bones, and how much its joint proportions vary between characters, is the main open risk for AGO-29 (character set). A cheap check before AGO-29: generate one more character and run `bake-retargeted-clips.mjs` on it.

## Bone mapping
UAL source joint to the shared humanoid bone. Mapped by position in the hierarchy, not by name similarity: the Meshy spine names run bottom up (Hips, Spine02, Spine01, Spine).

| UAL joint | Humanoid bone | UAL joint | Humanoid bone |
|---|---|---|---|
| `pelvis` | `Hips` | `thigh_l` / `thigh_r` | `LeftUpLeg` / `RightUpLeg` |
| `spine_01` | `Spine02` | `calf_l` / `calf_r` | `LeftLeg` / `RightLeg` |
| `spine_02` | `Spine01` | `foot_l` / `foot_r` | `LeftFoot` / `RightFoot` |
| `spine_03` | `Spine` | `ball_l` / `ball_r` | `LeftToeBase` / `RightToeBase` |
| `neck_01` | `neck` | `clavicle_l` / `clavicle_r` | `LeftShoulder` / `RightShoulder` |
| `Head` | `Head` | `upperarm_l` / `upperarm_r` | `LeftArm` / `RightArm` |
| `root` | not animated (axis conversion only, folded into the world transform) | `lowerarm_l` / `lowerarm_r` | `LeftForeArm` / `RightForeArm` |
| `index_*`, `middle_*`, `pinky_*`, `ring_*`, `thumb_*` (all fingers) | skin weights fold into `LeftHand` / `RightHand`, no animation | `hand_l` / `hand_r` | `LeftHand` / `RightHand` |
| `ball_leaf_l` / `ball_leaf_r` | skin weights fold into the toe bone | | |

`head_end` and `headfront` exist in Pixel's rig and are added unweighted to the Mannequin so both skeletons have the identical 24 names. They carry no animation. The code is `packages/assets/src/retarget/humanoid-bones.ts` (`UAL_TO_HUMANOID`, `HUMANOID_AIM`, `buildUalSkinTargets`).

## Implementation details
- **Retarget helper** `packages/assets/src/retarget/` (pure TypeScript, three's `Quaternion` and `Vector3` only, no DOM, no file IO):
  - `retarget-clip.ts`: for each mapped bone the source world rotation change `animatedWorld * inverse(restWorld)` is applied to the target bone's rest orientation. The target rest orientation is first swung so each bone points where the source bone points at rest (aim table), which removes the T-pose versus A-pose mismatch. Local rotations are then recovered top down. Hips translation is the source pelvis displacement scaled by hip height. Output is baked at 30 fps with quaternion sign continuity.
  - `humanoid-bones.ts`: the 24-bone contract, the UAL bone map, the aim table, the skin target map.
  - `skin-remap.ts`: merges and renormalizes the four joint influences of a vertex when joints collapse.
- **Bake script** `packages/assets/scripts/bake-retargeted-clips.mjs`: reads the UAL GLB and `pixel-v1.glb`, writes `spike-pixel.glb` and `spike-mannequin.glb` (meshopt). For the Mannequin it rebuilds the skeleton on the 24 bones (rest pose and inverse bind matrices taken from the UAL rest pose), re-points the vertex weights, replaces two materials with one material and vertex colours (style guide teal-500 and navy-700), simplifies 13,744 to 7,498 triangles (meshopt simplifier), and scales the armature by 0.56 so it is about as tall as Pixel.
- **Clips** (from UAL Standard, non root motion file so characters stay in place): `Idle_Loop` -> `Idle`, `Walk_Loop` -> `Walk`, `Idle_Talking_Loop` -> `Talk`. The Standard pack has no wave or typing clip. `Sitting_*` clips were avoided: the hips drop to a chair that does not exist.
- **Dev page** `/dev/3d/crowd` (`apps/web/src/features/dev-3d/crowd/`): 8 characters (4 Pixel, 4 Mannequin, checkerboard), `SkeletonUtils.clone` per character (own skeleton, shared geometry and material), Idle/Walk/Talk buttons that switch all eight, an FPS readout updated from `useFrame` without re-rendering React, and a `window.__crowdPerf` bridge (frame summary, draw calls, GPU string, which clip each mixer is running). Same gate as `/dev/3d` (`isDev3dEnabled`).
- **Measurement script** `apps/web/scripts/measure-crowd-fps.mjs`: drives the production build in a real browser and prints JSON including the GPU string.
- E2E helpers for reading GLB JSON moved to `apps/web/e2e/helpers/glb.ts` and reused by the AGO-49 spec.
- Sources and licences: `packages/assets/models/SOURCES.md`. Pipeline notes: `docs/art/3d-pipeline.md` (new; it did not exist).

## API changes
None.

## Database changes
None. No migration, no schema slot used.

## Dependencies on other tickets
AGO-49 (Pixel GLB, pipeline, `/dev/3d`). Feeds AGO-29 (character set), AGO-32 (the 12 named clips), AGO-100 (asset manifest), AGO-169 (performance budget).

## Frame rate
This machine is **not a mid-range laptop**. It is a high-end laptop, so the numbers below stand in for one and the stand-in is explained, not hidden.

| Item | Value |
|---|---|
| CPU | Intel Core i9-14900HX |
| GPUs | Intel UHD Graphics (iGPU) and NVIDIA GeForce RTX 4070 Laptop GPU |
| OS | Windows 11 Home 10.0.26200 |
| Browser | Microsoft Edge 156 (Chromium), headless and headed, Playwright |
| Display | 165 Hz (a vsync-locked run reads 165 fps) |
| Build | Production build (`next build` + `next start`), not `next dev` |
| Scene | 8 characters (4 Pixel + 4 Mannequin), 63,036 triangles, 12 draw calls, canvas 30rem tall, DPR up to 2 |

**What stands in for a mid-range laptop:** the Intel iGPU only (Playwright's Edge picked the iGPU by default, confirmed by the GPU string; the RTX was forced on with `--force_high_performance_gpu`), a CDP CPU throttle of 4x and 6x, and DPR 2. The page caps the canvas at about 848x480 CSS px (max-w-4xl, 30rem tall), so a bigger viewport does not add fill load; only DPR does (1696x960 device pixels, not 4K). Those runs also used a 1920x1080 viewport. The throttle slows main thread JavaScript only, not the GPU or driver. A mid-range laptop is not measured; the real check is a run on one (see Follow-up).

Two kinds of run, because they answer different questions:
- **Vsync locked (GPU inclusive).** The frame must finish before the next refresh, so a steady 165 fps and a p95 frame time near 6.1 ms means the GPU kept up with no missed frames.
- **Uncapped (`--disable-frame-rate-limit --disable-gpu-vsync`).** Shows headroom, but the browser can submit frames faster than the GPU finishes them, so read it as the **CPU cost per frame**, not as a GPU frame rate.

| Run | Idle | Walk | Talk | p95 frame |
|---|---|---|---|---|
| iGPU, vsync, canvas 848x480 CSS px, DPR 1 | 165 fps | 165 fps | 165 fps | 6.3 to 6.4 ms |
| iGPU, vsync, DPR 2 (1696x960 device px) | 165 fps | 165 fps | 165 fps | 6.3 ms |
| iGPU, vsync, DPR 2 (1696x960 device px), CPU 4x slower | 165 fps | 165 fps | 165 fps | 6.4 ms (worst 7.0 ms) |
| RTX 4070, vsync, DPR 2 (1696x960 device px) | 165 fps | 165 fps | 165 fps | 6.3 ms |
| iGPU, uncapped (CPU cost per frame) | 1,814 fps (0.55 ms) | 1,729 fps (0.58 ms) | 1,762 fps (0.57 ms) | 0.3 to 0.4 ms |
| iGPU, uncapped, headed | 2,075 fps (0.48 ms) | 1,915 fps (0.52 ms) | 1,687 fps (0.59 ms) | 0.3 to 0.4 ms |
| iGPU, uncapped, CPU 4x slower | 794 fps (1.26 ms) | 801 fps (1.25 ms) | 794 fps (1.26 ms) | 1.6 to 1.9 ms |
| iGPU, uncapped, CPU 6x slower | 465 fps (2.15 ms) | 436 fps (2.29 ms) | 439 fps (2.28 ms) | 2.9 to 3.4 ms |
| RTX 4070, uncapped | 5,204 fps (0.19 ms) | 5,976 fps (0.17 ms) | 5,742 fps (0.17 ms) | 0.3 to 0.4 ms |

**Reading:** the 60 fps target (16.7 ms frame) for 8 animated characters holds with a very wide margin on this machine's integrated GPU, including a 6x slower CPU (about 2.3 ms of CPU per frame, roughly 7x under budget). It is a good sign, not proof for a mid-range laptop: drivers, thermals, battery power mode, a busy browser and a real room scene (AGO-169) are not in this test. Each run is 5 to 6 seconds (about 600 frames per clip) on one machine.

**Optimizations:** none needed at this frame rate, so no instancing or skinned-mesh tricks were added. Already in place: shared geometry and one shared material per character via `SkeletonUtils.clone`, one material per character, baked 30 fps clips, frustum culling off only on this dev page. Three.js cannot GPU-instance skinned meshes out of the box, so draw calls scale with characters (12 for 8: the simplified Mannequin kept two primitives, one draw each).

Reproduce:
```
pnpm --filter @ago/web build
PORT=$(node scripts/free-port.mjs); APP_ENV=local ENABLE_DEV_3D=1 NEXT_PUBLIC_APP_URL=http://127.0.0.1:$PORT NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 pnpm --filter @ago/web start -- --hostname 127.0.0.1 --port $PORT
node apps/web/scripts/measure-crowd-fps.mjs http://127.0.0.1:<port> --seconds=6 [--uncapped] [--cpu-throttle=4] [--high-performance-gpu] [--width=1920 --height=1080 --dpr=2]
```

## Budget check (style guide section 8, character row)
| Measure | Budget | `spike-pixel.glb` | `spike-mannequin.glb` |
|---|---|---|---|
| Triangles | 5k to 8k, hard cap 10k | 8,261 | 7,498 (13,744 before simplify) |
| Bones | at most 40 | 24 | 24 |
| Materials | 1 | 1 | 1 (two primitives) |
| Texture | 1024 base colour | 1024 WebP (from AGO-49) | none (vertex colours) |
| Clips in the GLB | idle + walk | Idle, Walk, Talk | Idle, Walk, Talk |
| File size (meshopt) | asks above 5 MB | 293,288 B | 88,040 B |

Total committed assets in this ticket: 381 KB. Nothing is over 5 MB. The 7.6 MB UAL source GLB is not committed.

## Decisions taken
No human was at the keyboard, so each decision point took the recommended option.

| Decision | Choice | Reason |
|---|---|---|
| Second character | CC0 Quaternius Mannequin re-skinned onto the Meshy bone names, not a second Meshy generation and not a recoloured Pixel | Free, a genuinely different mesh, and it makes the retarget real (different rig, rest pose and proportions). A second generation costs credits and needs owner approval. |
| Clip source | Quaternius UAL Standard (CC0, free) | Brief preference; no account, no money |
| Which clips | Idle, Walk, Talk (`Idle_Talking_Loop`) | The Standard pack has no wave or typing clip; talk fits an office agent. `Sitting_*` avoided. |
| Retarget approach | Own world-space helper, not `SkeletonUtils.retargetClip` | `retargetClip` copes poorly with a T-pose versus A-pose mismatch and different bone axes, and needs a loaded scene (textures) in Node. A pure helper is also unit-testable. |
| Where retargeting runs | Build time, per character, baked into each GLB | Rest poses differ, so one track set cannot drive both. Nothing runs at load time. |
| Spine mapping | By hierarchy position (`spine_01` -> `Spine02`) | Meshy spine names run bottom up |
| Fingers | Dropped (folded into hand) | Pixel has none; also keeps 24 bones |
| Root motion | Non root motion UAL file | Characters stay in place in the crowd grid |
| Output file names | `spike-pixel.glb`, `spike-mannequin.glb`; `pixel-v1.glb` untouched | Do not regress AGO-49's tests and page; `spike-` marks them provisional |
| Mannequin materials | One material with vertex colours (teal-500 body, navy-700 joints) | Style guide: 1 material per character, palette tokens |
| Mannequin size | Armature scale 0.56 | Same height as Pixel in a shared scene |
| Compression | Meshopt | Same as AGO-49, bundled decoder |
| Page gate | Same `isDev3dEnabled()` as `/dev/3d` | Reuse |
| Performance claims | Recorded as a stand-in, with GPU string and two kinds of run | The machine is high end; honesty over a headline number |
| `docs/art/3d-pipeline.md` | Created (it did not exist) | The pipeline now has two scripts and a bone contract worth one page |
| CLAUDE.md | Not changed | Not updated per ticket (section 8) |
| Draco decoder | `useGLTF(url, false)` on the crowd page | No CDN fetch for a decoder the files do not need |

## Known limitations
- The Mannequin is a placeholder: realistic proportions, flat teal, not Pixel's style. It stands in for "a second character" until AGO-29.
- Pixel's skin is still darker than the approved warm grey (AGO-49 follow-up, not touched).
- No fingers and no facial animation. The Talk clip moves arms and head only.
- The Mannequin has 2 primitives (12 draw calls for 8 characters instead of 8); `join` did not merge skinned primitives.
- The retarget swing aligns bone direction only, not roll about the bone. Fine for these three clips; check twist-heavy clips (AGO-32) by eye.
- The uncapped numbers measure CPU cost, not GPU frame time; there is no GPU timer query here.
- The E2E needs WebGL. As in AGO-49, CI uses bundled Chromium without a GPU; if it reports a WebGL context error the fix is software-GL launch args, not loosening the console error guard.
- One machine, one short run per case, no mid-range laptop in hand.

## Testing notes
- Unit (`@ago/assets`): `humanoid-bones.test.ts`, `retarget-clip.test.ts` (rest pose, world rotation applied to an A-pose target from a T-pose source, identity retarget, hip scaling, aim bone missing), `skin-remap.test.ts`.
- Unit (`@ago/web`): `crowd-layout.test.ts`, `frame-stats.test.ts`.
- E2E `apps/web/e2e/dev-3d-crowd.spec.ts`: page loads and 8 characters render (4 and 4), all three clips play on all 8 mixers and the canvas keeps changing, both GLBs carry exactly Idle/Walk/Talk on an identical bone contract, the FPS readout is live, budgets, the ticket notes carry the decision. No FPS threshold is asserted (CI has no GPU). The console error guard applies to every test.
- Manual: crowd page driven in headless Edge; screenshots `docs/assets/3d/crowd-idle.png` and `crowd-walk.png`.
- Rebuild the assets: `pnpm --filter @ago/assets build`, then `node packages/assets/scripts/bake-retargeted-clips.mjs --ual <UAL1_Standard.glb>`.

## Follow-up tasks
- Check a real mid-range laptop (or a 2-3 year old Intel Iris / AMD integrated machine) with `measure-crowd-fps.mjs`, with the real room scene (AGO-169).
- Generate one more Meshy character (owner approval, quote first) and run the bake on it: confirms the rig is always the same 24 bones and how much proportions vary (AGO-29).
- Rest-pose normalization so one clip library can be bound at runtime to all characters (AGO-32).
- Check twist-heavy and sitting clips; add roll alignment to the retarget if needed.
- Merge the Mannequin primitives (or replace the Mannequin with a Pixel-style CC0 character).
- Pixel fingers: decide whether characters need a hand rig at all.
- Support the author (Quaternius, Patreon) if the assets ship.
