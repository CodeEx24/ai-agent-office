# Agent Office art direction and style guide

> **v1, revisable.** This is art direction v1, chosen by the owner and approved on 2026-11-05 (AGO-53). The owner may change it later. Treat every rule below as a default to update, not a law. Jira: AGO-28.

## 1. Style decision

**Toon / 3D cartoon**: stylized, rounded, big-head proportions, clay-like matte materials, soft saturated colour, soft lighting, toy-like simplified shapes. Not low-poly faceted, not semi-realistic, not cinematic.

Avoid (rejected by the owner): semi-realistic faces and materials, photoreal textures, cinematic or high-contrast lighting.

## 2. Reference images

All in `docs/assets/concepts/` (prompts alongside). No new images were generated for this guide.

| Image | Status | Use it for |
|---|---|---|
| `pixel-v1-character-sheet.webp` | **APPROVED** (owner, 2026-11-05) | Character look, proportions, outfit, materials |
| `office-v2-environment.webp` | **APPROVED** (owner, 2026-11-05) | Furniture shapes, palette, lighting, room mood |
| `pixel-v0-rejected.webp` | Rejected | What to avoid: semi-realistic character |
| `office-v1-rejected.webp` | Rejected | What to avoid: cinematic, photoreal environment |

## 3. Character proportions and silhouette

Reference: Pixel (android office assistant), the approved sheet.

- **Head-to-body ratio: about 3 heads tall** (head roughly one third of total height). Allowed range 2.5 to 3.5 heads; do not go taller than 3.5.
- Head is a rounded, slightly wide sphere-like shape; eyes are large (about one quarter of face width each), set low on the face. Small ears, simple brows, small smile.
- Torso short and soft; limbs short and slightly tapered; hands simplified (mitten-like fingers, not anatomical); feet chunky.
- **Silhouette test:** each agent must be recognisable as a solid black shape at 64 px height. Give each agent one silhouette hook (antenna, hair-cap shape, hat, shoulder piece, tail). Pixel's hook is a small antenna with a teal tip.
- Neutral rig-friendly **A-pose** for all character models; arms away from the torso so skinning does not merge limbs.
- Keep clothing as thin shells with simple folds (rolled sleeves, lapels). No loose cloth that needs simulation.
- Face stays readable at office-overview distance: eye colour carries the agent's status accent (teal by default).

## 4. Palette (hex tokens)

Hex values were sampled from the two approved images and rounded; they are the starting tokens and may be tuned during the first in-engine pass. Name tokens in code as `--ao-*` or the matching constant (for example `COLOR_TEAL_500`).

| Token | Hex | Where it comes from |
|---|---|---|
| `navy-700` (blazer, deep accents) | `#2E394A` | Pixel blazer |
| `navy-600` (columns, trim) | `#285771` | Office columns |
| `blue-500` (chairs, rugs) | `#225A82` | Office chairs |
| `teal-700` (deep rug, lamp shade) | `#20545F` | Office rug |
| `teal-500` (primary brand teal) | `#51B6B4` | Pixel badge, lanyard, sneaker soles (`#60AAAA`) |
| `teal-glow` (emissive accent) | `#24E7D9` | Pixel antenna tip, eyes |
| `sky-400` (water, sky, glass) | `#71C9FD` | Waterfalls, windows |
| `mushroom-glow` (scenery emissive) | `#73E9F6` | Glowing mushrooms |
| `peach-300` (floor, desks) | `#EBA778` / `#F0B57A` | Floor and desk tops |
| `orange-500` (poufs, cushions, table) | `#DB7E43` / `#F5A253` | Furniture accents |
| `charcoal-600` (trousers) | `#3E3E3E` | Pixel chinos; hair cap `#555557` |
| `skin-android` (warm grey) | `#908277` | Pixel face and hands |
| `white-soft` | `#E8E8E5` | Sneakers; cloud highlights `#F4F5F4` |
| `cream-100` (shirt) | about `#EDE3D0` (eyeballed, shadowed in the image) | Pixel shirt |
| `leaf-green-500` (plants, grass) | about `#4E9A4A` (eyeballed; the image samples are muddy) | Plants and island tops |

Rules: teal, navy and peach carry about 80% of any screen; green and sky blue are scenery only; no pure black or pure white (use `navy-700` for darkest and `white-soft` for lightest); one saturated accent per character. Status colours (success, warning, danger) are defined with the UI tokens in `packages/ui` and must not be reused as character colours.

## 5. Lighting

Soft, bright, daytime. Never cinematic or high contrast.

- **Key:** one soft directional light, warm white (about `#FFF3E0`), upper front-left, intensity about 1.0. Soft shadows only (PCF soft or baked); one shadow-casting light total.
- **Fill:** hemisphere/ambient light with sky `#BFE3FF` and ground `#F2C9A0`, about 0.6 to 0.8, so shadows never go black.
- **Rim:** a cool teal-white rim (about `#9FF3EA`) from behind on characters only, low intensity (0.3 to 0.5), to separate them from the background. Skip the rim on props.
- **Time of day:** default is bright mid-morning. An optional evening preset (warmer key, lower fill, brighter emissives) is allowed later; night is out of scope for v1.
- **Emissive accents:** teal only (`teal-glow`, `mushroom-glow`) for eyes, antenna tips, screens and scenery mushrooms. Emissive is for status and magic, never for large surfaces. Use emissive materials plus selective bloom (or none), not extra point lights.
- Prefer baked or fake ambient occlusion on props to real-time lights. Maximum 1 shadow-casting light and 2 additional cheap lights per scene.

## 6. Materials

- Matte, clay-like, slightly soft. Use `MeshStandardMaterial` (or `MeshToonMaterial` with a 3-4 step gradient if the toon look needs more punch) with **roughness 0.7 to 1.0, metalness 0 to 0.1**.
- Flat or very lightly textured colour: one base colour, plus at most one shared detail/normal map. No photographic textures, no scratches or grime.
- Edges are rounded or bevelled; no sharp hard edges. A subtle fabric fuzz on soft furniture is done with colour, not geometry.
- Metal (wristbands, desk legs) is brushed and low-key: metalness at most 0.4, roughness at least 0.4.
- Glass (windows) is a simple transparent material with a light sky tint; no real refraction.
- Share materials: all props of one type use one material instance so the renderer can batch them.

## 7. Fantasy scenery framing the office

The office sits inside a fantasy world: **floating islands with waterfalls, glowing mushroom forests, soft clouds**, in the same cartoon style and palette (sky blue, grass green, teal glow).

- The scenery **frames the left and right sides** of the office and shows through the windows; the centre stays free for the working floor and agents.
- Built in the 3D scene, not painted into the room: see AGO-36 (room and prop assets) and AGO-106. The approved `office-v2-environment.webp` shows the scenery through the windows only; wrapping the sides is a build task, not a render task.
- Scenery is **background only**: low-poly clusters, instanced where repeated (trees, mushrooms, clouds), no gameplay, no interaction.
- It must not out-compete the office: keep saturation and contrast slightly below the foreground, and use a soft sky gradient plus a few cloud billboards for depth.
- Island tops, waterfalls (animated UV or a simple scrolling texture, not particles) and mushrooms may use emissive teal accents.

## 8. Polygon and texture budget (three.js, mid-range hardware)

Targets come from AGO-169 (performance budget): **60 fps on a mid-range laptop with 8 agents, 30 fps on a phone**, with instancing, LOD, pixel-ratio cap, render-on-demand and a tab-hidden pause. These figures are recommended starting budgets; AGO-169 measures and may tighten them.

| Asset | Triangles (LOD0) | LOD1 | Textures | Notes |
|---|---|---|---|---|
| Character (agent) | 5k to 8k, hard cap 10k | 2k to 3k (far) | 1 atlas, 1024x1024 base colour, optional 512 normal/ORM | At most 40 bones; 1 material; animations in the same GLB |
| Small prop (mug, plant, lamp) | 200 to 1k | none or 50% | Share the room atlas | Instance repeated props |
| Medium prop (chair, sofa, desk) | 1k to 3k, cap 4k | 40% | Share the room atlas | Rounded but low segment counts |
| Room (shell and fixed furniture) | 25k to 40k total | n/a | 2048x2048 atlas, 1024 for secondary | Merge static meshes where possible |
| Scenery set (islands, mushrooms, waterfalls) | 15k to 30k total per side | far clusters at 25% | one shared 1024 atlas | Instance trees, mushrooms and clouds |
| **Whole scene (visible)** | **target 250k, hard cap 400k** | | **max 32 MB GPU texture memory** | 8 agents at LOD0 is about 80k of that |

Other rules:

- **Draw calls: target 100 or fewer, hard cap 150** per frame (agents and room together). Use instancing, merged static geometry and atlases to stay there.
- Texture sizes are powers of two. Max 1024 for characters and props, 2048 only for the room atlas. Compress with KTX2/Basis (UASTC for colour, ETC1S for others) in the asset pipeline; GLB with Draco or meshopt.
- Phone profile: cap the pixel ratio at 1.5 (2 on laptops), drop to LOD1 scenery and turn off soft shadows if the frame time goes over budget.
- **Animation:** 30 fps keyframes baked, shared skeleton across agents so clips can be reused.
- Check every new asset against this table in review: triangle count, texture size and material count go in the asset's PR description.

## 9. How to use and change this guide

- New assets (AGO-36, AGO-59, AGO-106 and later) follow this guide and cite it in the PR.
- If the owner changes the direction, bump this guide to v2, update the palette and budget tables, and keep the old reference images as history.
- Concept images are stored in `docs/assets/concepts/` for now; AGO-53 follow-up moves them to `packages/assets/concepts/`.
