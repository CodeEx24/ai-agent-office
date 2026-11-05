# 3D character pipeline

How a character GLB gets from a concept to the game-ready file the office loads. Budgets live in `docs/art/style-guide.md` section 8. Per-ticket detail: `docs/tickets/AGO-49.md` (generation, optimization) and `docs/tickets/AGO-64.md` (shared skeleton, retargeting, frame rate).

## The shared bone contract
Every character uses the same **24 bones, with the same names and hierarchy** (Meshy's Mixamo-style rig). The list and the parent of each bone are in `packages/assets/src/retarget/humanoid-bones.ts` (`HUMANOID_BONES`). The spine names run bottom up: `Hips`, `Spine02`, `Spine01`, `Spine`, then `neck`, `Head`. No fingers.

Shared means names and hierarchy. It does **not** mean the same rest pose: Meshy characters rest in an A-pose, CC0 libraries usually in a T-pose, and bone axes differ. A clip's rotation tracks are therefore baked per character.

## Steps
1. **Mesh and rig.** Higgsfield `generate_3d` with `meshy_v7_image_to_3d`, rigging on. Quote first (`get_cost: true`); anything that costs money needs owner approval.
2. **Optimize.** `node packages/assets/scripts/optimize-character.mjs <raw.glb> <out-dir>` (texture to 1024 WebP, meshopt, no tangents).
3. **Clips.** Use a free CC0 library, not paid generation. Quaternius Universal Animation Library (Standard) is the one in use. Add a row to `packages/assets/models/SOURCES.md` for every asset and keep the licence text.
4. **Retarget and bake.** `pnpm --filter @ago/assets build`, then `node packages/assets/scripts/bake-retargeted-clips.mjs --ual <UAL1_Standard.glb>`. It retargets in world space (`packages/assets/src/retarget/retarget-clip.ts`): the source bone rotation change is applied to a target bone whose rest orientation was first swung to match the source rest direction, then hips translation is scaled by hip height. Clip names are `Idle`, `Walk`, `Talk`.
5. **A non-Meshy mesh** (a CC0 character, for example) is re-skinned onto the 24 bones: vertex influences are re-pointed and merged (`skin-remap.ts`), fingers fold into the hand, then it is simplified, given one material and baked like any other character.
6. **Commit** only the meshopt GLB (`packages/assets/models/`). Never commit a source pack or a raw model over 5 MB without asking. `apps/web` copies the GLBs to a gitignored `public/models/` at `predev` and `prebuild`.
7. **Check** triangles, bones, materials, texture size and file size against the style guide table, and put the numbers in the PR.

## Checking a character on screen
- `/dev/3d`: one model, idle and walk (AGO-49).
- `/dev/3d/crowd`: eight characters, Idle/Walk/Talk on all of them, with an FPS readout (AGO-64). Both are dev only (`isDev3dEnabled`) and never linked from navigation.
- `apps/web/scripts/measure-crowd-fps.mjs` measures the crowd page in a real browser. Record the GPU string with every number, and say whether the run was vsync locked or uncapped.

## Known gaps
No hand rig, no LOD1, no KTX2 textures, no rest-pose normalization (so no single runtime clip library yet). See the follow-up lists in the two ticket notes.
