// The shared bone contract (AGO-64): the 24-bone Mixamo-style humanoid rig that Meshy produced for
// Pixel (AGO-49). Every shipped character GLB uses exactly these names and this hierarchy, so a
// clip baked for one character binds by name on every other. Note the Meshy spine names run
// bottom-up: Hips -> Spine02 -> Spine01 -> Spine.

export interface HumanoidBoneSpec {
  readonly name: string;
  readonly parent: string | null;
}

/** Parents always come before their children. */
export const HUMANOID_BONES: readonly HumanoidBoneSpec[] = [
  { name: "Hips", parent: null },
  { name: "Spine02", parent: "Hips" },
  { name: "Spine01", parent: "Spine02" },
  { name: "Spine", parent: "Spine01" },
  { name: "neck", parent: "Spine" },
  { name: "Head", parent: "neck" },
  { name: "head_end", parent: "Head" },
  { name: "headfront", parent: "Head" },
  { name: "LeftShoulder", parent: "Spine" },
  { name: "LeftArm", parent: "LeftShoulder" },
  { name: "LeftForeArm", parent: "LeftArm" },
  { name: "LeftHand", parent: "LeftForeArm" },
  { name: "RightShoulder", parent: "Spine" },
  { name: "RightArm", parent: "RightShoulder" },
  { name: "RightForeArm", parent: "RightArm" },
  { name: "RightHand", parent: "RightForeArm" },
  { name: "LeftUpLeg", parent: "Hips" },
  { name: "LeftLeg", parent: "LeftUpLeg" },
  { name: "LeftFoot", parent: "LeftLeg" },
  { name: "LeftToeBase", parent: "LeftFoot" },
  { name: "RightUpLeg", parent: "Hips" },
  { name: "RightLeg", parent: "RightUpLeg" },
  { name: "RightFoot", parent: "RightLeg" },
  { name: "RightToeBase", parent: "RightFoot" },
];

export const HUMANOID_BONE_NAMES: readonly string[] = HUMANOID_BONES.map((bone) => bone.name);

/**
 * Quaternius Universal Animation Library (UAL) joint -> humanoid bone, for the bones that carry
 * animation. Mapped by position in the hierarchy, not by name similarity: UAL spine_01 is the
 * lowest spine bone, which Meshy calls Spine02.
 */
export const UAL_TO_HUMANOID: Readonly<Record<string, string>> = {
  pelvis: "Hips",
  spine_01: "Spine02",
  spine_02: "Spine01",
  spine_03: "Spine",
  neck_01: "neck",
  Head: "Head",
  clavicle_l: "LeftShoulder",
  upperarm_l: "LeftArm",
  lowerarm_l: "LeftForeArm",
  hand_l: "LeftHand",
  clavicle_r: "RightShoulder",
  upperarm_r: "RightArm",
  lowerarm_r: "RightForeArm",
  hand_r: "RightHand",
  thigh_l: "LeftUpLeg",
  calf_l: "LeftLeg",
  foot_l: "LeftFoot",
  ball_l: "LeftToeBase",
  thigh_r: "RightUpLeg",
  calf_r: "RightLeg",
  foot_r: "RightFoot",
  ball_r: "RightToeBase",
};

/** The bone a humanoid bone points at in the rest pose. Bones without an entry (Head, hands, toes) point away from their parent. */
export const HUMANOID_AIM: Readonly<Record<string, string>> = {
  Hips: "Spine02",
  Spine02: "Spine01",
  Spine01: "Spine",
  Spine: "neck",
  neck: "Head",
  LeftShoulder: "LeftArm",
  LeftArm: "LeftForeArm",
  LeftForeArm: "LeftHand",
  RightShoulder: "RightArm",
  RightArm: "RightForeArm",
  RightForeArm: "RightHand",
  LeftUpLeg: "LeftLeg",
  LeftLeg: "LeftFoot",
  LeftFoot: "LeftToeBase",
  RightUpLeg: "RightLeg",
  RightLeg: "RightFoot",
  RightFoot: "RightToeBase",
};

const UAL_FINGER = /^(?:index|middle|pinky|ring|thumb)_\d+(?:_leaf)?_(l|r)$/;

/**
 * Every UAL joint -> the humanoid bone that takes over its skin weights when the Mannequin mesh
 * is re-skinned onto the 24-bone layout. Fingers fold into the hand, leaf bones into their parent,
 * and the UAL `root` (which only carries the -90 degree axis conversion) into Hips.
 */
export function buildUalSkinTargets(ualJointNames: readonly string[]): Map<string, string> {
  const targets = new Map<string, string>();
  for (const name of ualJointNames) {
    const direct = UAL_TO_HUMANOID[name];
    const finger = UAL_FINGER.exec(name);
    if (direct) {
      targets.set(name, direct);
    } else if (name === "root") {
      targets.set(name, "Hips");
    } else if (finger) {
      targets.set(name, finger[1] === "l" ? "LeftHand" : "RightHand");
    } else if (name === "ball_leaf_l") {
      targets.set(name, "LeftToeBase");
    } else if (name === "ball_leaf_r") {
      targets.set(name, "RightToeBase");
    } else {
      throw new Error(`No humanoid bone for UAL joint "${name}"`);
    }
  }
  return targets;
}
