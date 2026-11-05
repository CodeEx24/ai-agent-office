import { Quaternion, Vector3 } from "three";

// World-space clip retargeting between two humanoid rigs with different rest poses and bone axes.
//
// For every mapped bone b:   D_b = animatedWorld(src b) * inverse(restWorld(src b))
// is the rotation the source applies to that bone in world space. The target bone gets
// D_b * alignedRest(tgt b), where alignedRest is the target's rest orientation turned (swing only)
// so the bone points where the source bone points at rest. That removes the T-pose versus A-pose
// mismatch, so "arm lowered by 80 degrees" means the same thing on both rigs. Local rotations are
// then recovered top-down from the already retargeted parents. Hips translation is the source
// pelvis displacement scaled by the ratio of hip heights.

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export interface RigBone {
  name: string;
  /** Parent bone name, or null for the first node. Parents come before children in a rig. */
  parent: string | null;
  translation: Vec3;
  rotation: Quat;
  /** Uniform scale. Meshy exports an armature node scaled by 0.01, so this matters. */
  scale: number;
}

/** Flat keyframe data: `values` has 3 (translation) or 4 (rotation, xyzw) numbers per time. */
export interface KeyTrack {
  times: ArrayLike<number>;
  values: ArrayLike<number>;
}

export interface SourceClip {
  name: string;
  duration: number;
  rotations: ReadonlyMap<string, KeyTrack>;
  translations: ReadonlyMap<string, KeyTrack>;
}

export interface RetargetedClip {
  name: string;
  /** Uniform sample times in seconds. */
  times: Float32Array;
  /** Local rotation per target bone, xyzw per time. */
  rotations: Map<string, Float32Array>;
  /** Local translation of the hips bone, xyz per time. */
  hipsTranslation: Float32Array;
}

export interface RetargetOptions {
  source: readonly RigBone[];
  target: readonly RigBone[];
  clip: SourceClip;
  /** Source bone name -> target bone name, for the bones that carry animation. */
  boneMap: Readonly<Record<string, string>>;
  /** Target bone name -> target bone it points at in the rest pose. */
  aim: Readonly<Record<string, string>>;
  /** Target bone that receives translation. */
  hipsBone: string;
  fps?: number;
}

interface WorldPose {
  rotation: Quaternion;
  position: Vector3;
  scale: number;
}

function toQuaternion(q: Quat): Quaternion {
  return new Quaternion(q[0], q[1], q[2], q[3]);
}

function toVector(v: Vec3): Vector3 {
  return new Vector3(v[0], v[1], v[2]);
}

/** Forward kinematics. `overrides` replaces the local rotation or translation of named bones. */
function computeWorld(
  rig: readonly RigBone[],
  overrides: {
    rotations?: ReadonlyMap<string, Quaternion>;
    translations?: ReadonlyMap<string, Vector3>;
  } = {},
): Map<string, WorldPose> {
  const world = new Map<string, WorldPose>();
  for (const bone of rig) {
    const localRotation = overrides.rotations?.get(bone.name) ?? toQuaternion(bone.rotation);
    const localPosition = overrides.translations?.get(bone.name) ?? toVector(bone.translation);
    const parent = bone.parent === null ? undefined : world.get(bone.parent);
    if (bone.parent !== null && !parent) {
      throw new Error(`Bone "${bone.name}" appears before its parent "${bone.parent}"`);
    }
    if (!parent) {
      world.set(bone.name, {
        rotation: localRotation.clone(),
        position: localPosition.clone(),
        scale: bone.scale,
      });
      continue;
    }
    world.set(bone.name, {
      rotation: parent.rotation.clone().multiply(localRotation),
      position: parent.position
        .clone()
        .add(localPosition.clone().multiplyScalar(parent.scale).applyQuaternion(parent.rotation)),
      scale: parent.scale * bone.scale,
    });
  }
  return world;
}

function getPose(world: ReadonlyMap<string, WorldPose>, name: string): WorldPose {
  const pose = world.get(name);
  if (!pose) throw new Error(`Unknown bone "${name}"`);
  return pose;
}

/** Index of the last key at or before `time`, clamped. */
function findKey(times: ArrayLike<number>, time: number): number {
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((times[mid] ?? 0) <= time) low = mid;
    else high = mid - 1;
  }
  return low;
}

function blendFactor(track: KeyTrack, index: number, time: number): number {
  const t0 = track.times[index] ?? 0;
  const t1 = track.times[index + 1] ?? t0;
  const alpha = t1 > t0 ? (time - t0) / (t1 - t0) : 0;
  return Math.min(Math.max(alpha, 0), 1);
}

function sampleQuaternion(track: KeyTrack, time: number): Quaternion {
  const i = findKey(track.times, time);
  const read = (k: number) =>
    new Quaternion(
      track.values[k * 4] ?? 0,
      track.values[k * 4 + 1] ?? 0,
      track.values[k * 4 + 2] ?? 0,
      track.values[k * 4 + 3] ?? 1,
    );
  const a = read(i);
  if (i >= track.times.length - 1) return a;
  return a.slerp(read(i + 1), blendFactor(track, i, time));
}

function sampleVector(track: KeyTrack, time: number): Vector3 {
  const i = findKey(track.times, time);
  const read = (k: number) =>
    new Vector3(
      track.values[k * 3] ?? 0,
      track.values[k * 3 + 1] ?? 0,
      track.values[k * 3 + 2] ?? 0,
    );
  const a = read(i);
  if (i >= track.times.length - 1) return a;
  return a.lerp(read(i + 1), blendFactor(track, i, time));
}

/** Direction a bone points in the rest pose: toward its aim child, or away from its parent. */
function restDirection(
  rig: readonly RigBone[],
  world: ReadonlyMap<string, WorldPose>,
  boneName: string,
  aimChild: string | undefined,
): Vector3 {
  const pose = getPose(world, boneName);
  if (aimChild) {
    return getPose(world, aimChild).position.clone().sub(pose.position).normalize();
  }
  const parentName = rig.find((bone) => bone.name === boneName)?.parent;
  if (!parentName) return new Vector3(0, 1, 0);
  return pose.position.clone().sub(getPose(world, parentName).position).normalize();
}

/** Rest orientation of every mapped target bone, turned so it points where its source bone points. */
function alignRestToSource(options: RetargetOptions): Map<string, Quaternion> {
  const { source, target, boneMap, aim } = options;
  const sourceRest = computeWorld(source);
  const targetRest = computeWorld(target);
  const sourceFor = new Map(Object.entries(boneMap).map(([src, tgt]) => [tgt, src]));
  const aligned = new Map<string, Quaternion>();

  for (const [targetName, sourceName] of sourceFor) {
    const targetAim = aim[targetName];
    const sourceAim = targetAim ? sourceFor.get(targetAim) : undefined;
    if (targetAim && !sourceAim) {
      throw new Error(`Aim bone "${targetAim}" of "${targetName}" is not in the bone map`);
    }
    const targetDir = restDirection(target, targetRest, targetName, targetAim);
    const sourceDir = restDirection(source, sourceRest, sourceName, sourceAim);
    const swing = new Quaternion().setFromUnitVectors(targetDir, sourceDir);
    aligned.set(targetName, swing.multiply(getPose(targetRest, targetName).rotation));
  }
  return aligned;
}

/** Retargets one source clip onto the target rig and bakes it at a fixed frame rate. */
export function retargetClip(options: RetargetOptions): RetargetedClip {
  const { source, target, clip, boneMap, hipsBone } = options;
  const fps = options.fps ?? 30;
  const frameCount = Math.max(2, Math.round(clip.duration * fps) + 1);
  const times = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) times[f] = Math.min(f / fps, clip.duration);

  const sourceRest = computeWorld(source);
  const targetRest = computeWorld(target);
  const aligned = alignRestToSource(options);
  const sourceFor = new Map(Object.entries(boneMap).map(([src, tgt]) => [tgt, src]));

  const hipsSourceName = sourceFor.get(hipsBone);
  if (!hipsSourceName) throw new Error(`No source bone maps to hips bone "${hipsBone}"`);
  const hipsSourceRest = getPose(sourceRest, hipsSourceName);
  const hipsTargetRest = getPose(targetRest, hipsBone);
  const heightScale = hipsTargetRest.position.y / hipsSourceRest.position.y;
  const hipsParentName = target.find((bone) => bone.name === hipsBone)?.parent;
  const hipsParent = hipsParentName ? getPose(targetRest, hipsParentName) : null;

  const targetBones = target.filter((bone) => sourceFor.has(bone.name));
  const rotations = new Map(
    targetBones.map((bone) => [bone.name, new Float32Array(frameCount * 4)] as const),
  );
  const hipsTranslation = new Float32Array(frameCount * 3);
  const previous = new Map<string, Quaternion>();

  for (let f = 0; f < frameCount; f += 1) {
    const time = times[f] ?? 0;
    const sourceRotations = new Map<string, Quaternion>();
    for (const [name, track] of clip.rotations) {
      sourceRotations.set(name, sampleQuaternion(track, time));
    }
    const sourceTranslations = new Map<string, Vector3>();
    for (const [name, track] of clip.translations) {
      sourceTranslations.set(name, sampleVector(track, time));
    }
    const animated = computeWorld(source, {
      rotations: sourceRotations,
      translations: sourceTranslations,
    });

    const resultWorld = new Map<string, Quaternion>();
    for (const bone of targetBones) {
      const sourceName = sourceFor.get(bone.name) ?? "";
      const delta = getPose(animated, sourceName)
        .rotation.clone()
        .multiply(getPose(sourceRest, sourceName).rotation.clone().invert());
      const world = delta.multiply(aligned.get(bone.name) ?? new Quaternion());
      resultWorld.set(bone.name, world);

      const parentWorld = bone.parent
        ? (resultWorld.get(bone.parent) ?? getPose(targetRest, bone.parent).rotation)
        : new Quaternion();
      const local = parentWorld.clone().invert().multiply(world).normalize();
      const before = previous.get(bone.name);
      if (before && before.dot(local) < 0) local.set(-local.x, -local.y, -local.z, -local.w);
      previous.set(bone.name, local);
      rotations.get(bone.name)?.set([local.x, local.y, local.z, local.w], f * 4);
    }

    const displacement = getPose(animated, hipsSourceName)
      .position.clone()
      .sub(hipsSourceRest.position)
      .multiplyScalar(heightScale);
    const desired = hipsTargetRest.position.clone().add(displacement);
    const local = hipsParent
      ? desired
          .sub(hipsParent.position)
          .applyQuaternion(hipsParent.rotation.clone().invert())
          .divideScalar(hipsParent.scale)
      : desired;
    hipsTranslation.set([local.x, local.y, local.z], f * 3);
  }

  return { name: clip.name, times, rotations, hipsTranslation };
}

/** World-space unit direction from one bone to another after applying local rotations; used by tests and diagnostics. */
export function poseDirection(
  rig: readonly RigBone[],
  rotations: ReadonlyMap<string, Quat>,
  from: string,
  to: string,
): Vec3 {
  const overrides = new Map([...rotations].map(([name, q]) => [name, toQuaternion(q)] as const));
  const world = computeWorld(rig, { rotations: overrides });
  const d = getPose(world, to).position.clone().sub(getPose(world, from).position).normalize();
  return [d.x, d.y, d.z];
}
