# Model sources and licences

Every GLB in this folder, where it came from and under what terms. Add a row for each new asset.

| File | Origin | Licence | Notes |
|---|---|---|---|
| `pixel-v1.glb` | Pixel character sheet (AGO-53, owner approved) turned into a rigged GLB by Meshy 7 through Higgsfield, job `5860298c-b4cf-4860-81f7-1e9ee8e6163e`, optimized by `scripts/optimize-character.mjs` (AGO-49) | Project asset (generated, owner commissioned) | 47.5 credits spent in AGO-49. Idle is procedural, Walk is the Meshy clip. |
| `spike-pixel.glb` | `pixel-v1.glb` with its clips replaced by Idle, Walk and Talk retargeted from the Quaternius Universal Animation Library by `scripts/bake-retargeted-clips.mjs` (AGO-64) | Mesh: project asset. Clips: CC0 1.0 | No money spent in AGO-64. |
| `spike-mannequin.glb` | The Quaternius UAL "Mannequin" mesh, re-skinned onto the 24 humanoid bones, simplified from 13,744 to 7,498 triangles, merged to one material with vertex colours, with the same three retargeted clips (AGO-64) | CC0 1.0 | Placeholder second character for the spike. Not Pixel style. |

## Quaternius Universal Animation Library (Standard)

- Author: Quaternius (`@Quaternius`)
- Page: https://quaternius.itch.io/universal-animation-library (also https://quaternius.com/packs/universalanimationlibrary.html)
- Pack used: "Universal Animation Library[Standard]", the free tier (pay what you want, **paid $0**). File `UAL1_Standard.glb` (non root motion), 7.6 MB, 43 clips, 65 joints.
- Not committed: the original GLB and the zip. To rebuild, download the pack from the page above and pass `Unreal-Godot/UAL1_Standard.glb` to `bake-retargeted-clips.mjs --ual`.
- Licence text shipped with the pack (`License.txt`):

> CC0 1.0 Universal (CC0 1.0) Public Domain Dedication
> https://creativecommons.org/publicdomain/zero/1.0/
> Models by @Quaternius

CC0 needs no attribution, but the author asks for support at https://www.patreon.com/quaternius. Worth doing if these assets ship.
