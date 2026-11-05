import { describe, expect, it } from "vitest";
import {
  AnimationClip,
  Bone,
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Skeleton,
  SkinnedMesh,
} from "three";

import { collectModelStats, findClipName } from "./model-stats";

describe("collectModelStats", () => {
  it("counts triangles of indexed geometry, bones, materials and clips", () => {
    const root = new Group();
    const material = new MeshStandardMaterial();
    // A box has 12 triangles (6 faces x 2).
    root.add(new Mesh(new BoxGeometry(1, 1, 1), material));

    const skinned = new SkinnedMesh(new BoxGeometry(1, 1, 1), material);
    const hips = new Bone();
    const spine = new Bone();
    hips.add(spine);
    skinned.add(hips);
    skinned.bind(new Skeleton([hips, spine]));
    root.add(skinned);

    const stats = collectModelStats(root, [new AnimationClip("Idle", 1, [])]);

    expect(stats.triangles).toBe(24);
    expect(stats.meshes).toBe(2);
    expect(stats.bones).toBe(2);
    expect(stats.materials).toBe(1);
    expect(stats.clips).toEqual(["Idle"]);
  });

  it("reports zero for an empty scene", () => {
    expect(collectModelStats(new Group(), [])).toEqual({
      triangles: 0,
      bones: 0,
      meshes: 0,
      materials: 0,
      textures: [],
      clips: [],
    });
  });
});

describe("findClipName", () => {
  const names = ["Armature|Casual_Walk", "Armature|Idle_02", "Run"];

  it("matches idle and walk case-insensitively", () => {
    expect(findClipName(names, "idle")).toBe("Armature|Idle_02");
    expect(findClipName(names, "walk")).toBe("Armature|Casual_Walk");
  });

  it("returns undefined when no clip matches", () => {
    expect(findClipName(["Run"], "walk")).toBeUndefined();
  });
});
