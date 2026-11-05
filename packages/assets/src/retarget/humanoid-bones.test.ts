import { describe, expect, it } from "vitest";

import {
  HUMANOID_AIM,
  HUMANOID_BONES,
  HUMANOID_BONE_NAMES,
  UAL_TO_HUMANOID,
  buildUalSkinTargets,
} from "./humanoid-bones.js";

const FINGERS = ["index", "middle", "pinky", "ring"];

// The 65 joints of the Quaternius UAL Standard rig, as listed in the GLB's skin.
const UAL_JOINTS = [
  "root",
  "pelvis",
  "spine_01",
  "spine_02",
  "spine_03",
  "neck_01",
  "Head",
  ...["l", "r"].flatMap((side) => [
    `clavicle_${side}`,
    `upperarm_${side}`,
    `lowerarm_${side}`,
    `hand_${side}`,
    ...FINGERS.flatMap((finger) => [
      `${finger}_01_${side}`,
      `${finger}_02_${side}`,
      `${finger}_03_${side}`,
      `${finger}_04_leaf_${side}`,
    ]),
    `thumb_01_${side}`,
    `thumb_02_${side}`,
    `thumb_03_${side}`,
    `thumb_04_leaf_${side}`,
  ]),
  ...["l", "r"].flatMap((side) => [
    `thigh_${side}`,
    `calf_${side}`,
    `foot_${side}`,
    `ball_${side}`,
    `ball_leaf_${side}`,
  ]),
];

describe("humanoid bone contract", () => {
  it("has 24 unique bones, under the style guide cap of 40", () => {
    expect(HUMANOID_BONE_NAMES).toHaveLength(24);
    expect(new Set(HUMANOID_BONE_NAMES).size).toBe(24);
  });

  it("lists every parent before its children", () => {
    const seen = new Set<string>();
    for (const bone of HUMANOID_BONES) {
      if (bone.parent !== null) expect(seen.has(bone.parent), bone.name).toBe(true);
      seen.add(bone.name);
    }
  });

  it("maps each UAL animation bone to a distinct humanoid bone", () => {
    const targets = Object.values(UAL_TO_HUMANOID);
    expect(new Set(targets).size).toBe(targets.length);
    for (const target of targets) expect(HUMANOID_BONE_NAMES).toContain(target);
  });

  it("maps the spine by hierarchy position, not by name", () => {
    expect(UAL_TO_HUMANOID.spine_01).toBe("Spine02");
    expect(UAL_TO_HUMANOID.spine_03).toBe("Spine");
  });

  it("aims every bone at one of its own children", () => {
    for (const [bone, aimed] of Object.entries(HUMANOID_AIM)) {
      const child = HUMANOID_BONES.find((spec) => spec.name === aimed);
      expect(child?.parent, `${bone} -> ${aimed}`).toBe(bone);
    }
  });

  it("assigns all 65 UAL joints a skin target and rejects unknown joints", () => {
    expect(UAL_JOINTS).toHaveLength(65);
    const targets = buildUalSkinTargets(UAL_JOINTS);
    expect(targets.size).toBe(65);
    for (const target of targets.values()) expect(HUMANOID_BONE_NAMES).toContain(target);
    expect(targets.get("index_03_l")).toBe("LeftHand");
    expect(targets.get("thumb_04_leaf_r")).toBe("RightHand");
    expect(targets.get("ball_leaf_r")).toBe("RightToeBase");
    expect(targets.get("root")).toBe("Hips");
    expect(() => buildUalSkinTargets(["tail_01"])).toThrow(/No humanoid bone/);
  });
});
