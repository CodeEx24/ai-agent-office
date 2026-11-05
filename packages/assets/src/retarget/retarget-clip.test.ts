import { describe, expect, it } from "vitest";

import {
  type KeyTrack,
  type Quat,
  type RigBone,
  type SourceClip,
  poseDirection,
  retargetClip,
} from "./retarget-clip.js";

const IDENTITY: Quat = [0, 0, 0, 1];

/** Rotation of `degrees` about the z axis as an xyzw quaternion. */
function rotZ(degrees: number): Quat {
  const half = (degrees * Math.PI) / 360;
  return [0, 0, Math.sin(half), Math.cos(half)];
}

// Source: a T-pose rig, arm along +x. Target: an A-pose rig whose arm bone is rolled so it points
// down and out, with different bone lengths, a different hip height and a scaled armature node.
const SOURCE: RigBone[] = [
  { name: "root", parent: null, translation: [0, 0, 0], rotation: IDENTITY, scale: 1 },
  { name: "pelvis", parent: "root", translation: [0, 1, 0], rotation: IDENTITY, scale: 1 },
  { name: "spine", parent: "pelvis", translation: [0, 0.5, 0], rotation: IDENTITY, scale: 1 },
  { name: "uarm", parent: "spine", translation: [0.2, 0.4, 0], rotation: rotZ(-90), scale: 1 },
  { name: "farm", parent: "uarm", translation: [0, 0.3, 0], rotation: IDENTITY, scale: 1 },
];

const TARGET: RigBone[] = [
  { name: "Armature", parent: null, translation: [0, 0, 0], rotation: IDENTITY, scale: 0.01 },
  { name: "hips", parent: "Armature", translation: [0, 50, 0], rotation: IDENTITY, scale: 1 },
  { name: "chest", parent: "hips", translation: [0, 25, 0], rotation: IDENTITY, scale: 1 },
  { name: "arm", parent: "chest", translation: [10, 20, 0], rotation: rotZ(-135), scale: 1 },
  { name: "forearm", parent: "arm", translation: [0, 15, 0], rotation: IDENTITY, scale: 1 },
];

const BONE_MAP = { pelvis: "hips", spine: "chest", uarm: "arm", farm: "forearm" };
const AIM = { hips: "chest", chest: "arm", arm: "forearm" };

function restClip(overrides: Record<string, KeyTrack> = {}): SourceClip {
  const rotations = new Map<string, KeyTrack>();
  for (const bone of SOURCE) {
    rotations.set(bone.name, { times: [0, 1], values: [...bone.rotation, ...bone.rotation] });
  }
  for (const [name, track] of Object.entries(overrides)) rotations.set(name, track);
  return { name: "test", duration: 1, rotations, translations: new Map() };
}

function retarget(clip: SourceClip) {
  return retargetClip({
    source: SOURCE,
    target: TARGET,
    clip,
    boneMap: BONE_MAP,
    aim: AIM,
    hipsBone: "hips",
  });
}

function frameRotations(result: ReturnType<typeof retarget>, frame: number): Map<string, Quat> {
  const out = new Map<string, Quat>();
  for (const [name, values] of result.rotations) {
    out.set(name, [
      values[frame * 4] ?? 0,
      values[frame * 4 + 1] ?? 0,
      values[frame * 4 + 2] ?? 0,
      values[frame * 4 + 3] ?? 1,
    ]);
  }
  return out;
}

function expectClose(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => {
    expect(value).toBeCloseTo(expected[i] ?? 0, 4);
  });
}

describe("retargetClip", () => {
  it("source at rest puts the target arm where the source arm points (A-pose lifted to T-pose)", () => {
    const result = retarget(restClip());
    const direction = poseDirection(TARGET, frameRotations(result, 0), "arm", "forearm");
    // The source T-pose arm points along +x; the target's own A-pose arm points down and out.
    expectClose(direction, [1, 0, 0]);
  });

  it("applies the source's world-space arm rotation to the target arm", () => {
    // Source upper arm turned 90 degrees about z in world space: from +x to straight down.
    const lowered = restClip({
      uarm: { times: [0, 1], values: [...rotZ(-180), ...rotZ(-180)] },
    });
    const result = retarget(lowered);
    const direction = poseDirection(TARGET, frameRotations(result, 0), "arm", "forearm");
    expectClose(direction, [0, -1, 0]);
  });

  it("reproduces the rest rotations when a rig is retargeted onto itself", () => {
    const identityMap = { pelvis: "pelvis", spine: "spine", uarm: "uarm", farm: "farm" };
    const result = retargetClip({
      source: SOURCE,
      target: SOURCE,
      clip: restClip(),
      boneMap: identityMap,
      aim: { pelvis: "spine", spine: "uarm", uarm: "farm" },
      hipsBone: "pelvis",
    });
    for (const bone of SOURCE.filter((b) => b.name in identityMap)) {
      const frame = frameRotations(result, 5).get(bone.name);
      expect(frame, bone.name).toBeDefined();
      // q and -q are the same rotation.
      const sign = Math.sign((frame?.[3] ?? 1) * bone.rotation[3]) || 1;
      expectClose(
        (frame ?? []).map((value) => value * sign),
        bone.rotation,
      );
    }
  });

  it("scales hips translation by the ratio of hip heights and the parent armature scale", () => {
    const rise: SourceClip = {
      ...restClip(),
      translations: new Map([["pelvis", { times: [0, 1], values: [0, 1, 0, 0, 1.2, 0] }]]),
    };
    const result = retarget(rise);
    const last = result.hipsTranslation.length - 3;
    expectClose(Array.from(result.hipsTranslation.slice(0, 3)), [0, 50, 0]);
    // Target hips are 0.5 m up and the source pelvis 1 m, so a 0.2 m rise becomes 0.1 m = 10 local units.
    expectClose(Array.from(result.hipsTranslation.slice(last, last + 3)), [0, 60, 0]);
  });

  it("bakes 30 fps samples including both ends of the clip", () => {
    const result = retarget(restClip());
    expect(result.times).toHaveLength(31);
    expect(result.times[0]).toBe(0);
    expect(result.times[30]).toBeCloseTo(1, 5);
    expect(result.rotations.get("arm")).toHaveLength(31 * 4);
  });

  it("throws when an aim bone has no source mapping", () => {
    expect(() =>
      retargetClip({
        source: SOURCE,
        target: TARGET,
        clip: restClip(),
        boneMap: { pelvis: "hips", spine: "chest", uarm: "arm" },
        aim: AIM,
        hipsBone: "hips",
      }),
    ).toThrow(/not in the bone map/);
  });
});
