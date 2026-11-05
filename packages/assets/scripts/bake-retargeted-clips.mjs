// Shared-skeleton spike (AGO-64): bakes three CC0 clips onto two characters that share one bone contract.
//
//   pnpm --filter @ago/assets build
//   node packages/assets/scripts/bake-retargeted-clips.mjs --ual <UAL1_Standard.glb> [--out <dir>]
//
// Inputs
//   - Quaternius Universal Animation Library "Standard" GLB (CC0, free). Not committed: 7.6 MB.
//   - packages/assets/models/pixel-v1.glb (AGO-49): Meshy's 24-bone rig, A-pose.
// Outputs (meshopt, committed)
//   - spike-pixel.glb:     Pixel with Idle, Walk and Talk retargeted from UAL.
//   - spike-mannequin.glb: the UAL Mannequin re-skinned onto the same 24 bone names, simplified to
//                          one material with vertex colours, with the same three clips.
// Retargeting is done per character at build time (world-space, see src/retarget/retarget-clip.ts)
// because the two rigs share bone names and hierarchy but not rest poses.
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, join, meshopt, prune, simplify, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import { Matrix4, Quaternion, Vector3 } from "three";

import {
  HUMANOID_AIM,
  HUMANOID_BONES,
  UAL_TO_HUMANOID,
  buildUalSkinTargets,
  remapInfluences,
  retargetClip,
} from "../dist/retarget/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.resolve(here, "../models");

// UAL clip name -> shipped clip name.
const CLIPS = { Idle_Loop: "Idle", Walk_Loop: "Walk", Idle_Talking_Loop: "Talk" };

// The Mannequin is a 1.75 m realistic body; Pixel is a 0.93 m three-heads-tall character.
// Scale the Mannequin armature so both stand at a similar height in the same scene.
const MANNEQUIN_SCALE = 0.56;
const MANNEQUIN_TRIANGLE_TARGET = 7500;

// Style guide section 4: teal-500 for the body, navy-700 for the joints. Linear RGB for COLOR_0.
const BODY_COLOR = "#51B6B4";
const JOINT_COLOR = "#2E394A";

function hexToLinear(hex) {
  const channel = (offset) => {
    const srgb = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return [channel(1), channel(3), channel(5), 1];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const read = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const ual = read("--ual");
  if (!ual) throw new Error("usage: bake-retargeted-clips.mjs --ual <UAL1_Standard.glb> [--out <dir>]");
  return { ual, out: read("--out") ?? MODELS_DIR };
}

/** Rig description (bones plus the armature ancestor) of a glTF document's first skin. */
function readRig(document) {
  const skin = document.getRoot().listSkins()[0];
  if (!skin) throw new Error("document has no skin");
  const needed = new Set();
  for (const joint of skin.listJoints()) {
    let node = joint;
    while (node && !needed.has(node)) {
      needed.add(node);
      node = node.getParentNode();
    }
  }
  const rig = [];
  const nodes = new Map();
  const visit = (node, parentName) => {
    if (!needed.has(node)) return;
    const [x, y, z, w] = node.getRotation();
    rig.push({
      name: node.getName(),
      parent: parentName,
      translation: node.getTranslation(),
      rotation: [x, y, z, w],
      scale: node.getScale()[0],
    });
    nodes.set(node.getName(), node);
    for (const child of node.listChildren()) visit(child, node.getName());
  };
  for (const child of document.getRoot().listScenes()[0].listChildren()) visit(child, null);
  return { rig, nodes };
}

function readSourceClips(document) {
  const clips = [];
  for (const animation of document.getRoot().listAnimations()) {
    const outputName = CLIPS[animation.getName()];
    if (!outputName) continue;
    const rotations = new Map();
    const translations = new Map();
    let duration = 0;
    for (const channel of animation.listChannels()) {
      const sampler = channel.getSampler();
      const times = sampler.getInput().getArray();
      duration = Math.max(duration, times[times.length - 1] ?? 0);
      const track = { times, values: sampler.getOutput().getArray() };
      const bone = channel.getTargetNode().getName();
      if (channel.getTargetPath() === "rotation") rotations.set(bone, track);
      else if (channel.getTargetPath() === "translation") translations.set(bone, track);
    }
    clips.push({ name: outputName, duration, rotations, translations });
  }
  if (clips.length !== Object.keys(CLIPS).length) throw new Error("a requested UAL clip is missing");
  return clips;
}

function retargetAll(sourceRig, targetRig, sourceClips) {
  return sourceClips.map((clip) =>
    retargetClip({
      source: sourceRig,
      target: targetRig,
      clip,
      boneMap: UAL_TO_HUMANOID,
      aim: HUMANOID_AIM,
      hipsBone: "Hips",
    }),
  );
}

/** Writes one retargeted clip into the document as a glTF animation. */
function addAnimation(document, nodes, result) {
  const buffer = document.getRoot().listBuffers()[0];
  const animation = document.createAnimation(result.name);
  const input = document
    .createAccessor(`${result.name}-times`)
    .setType("SCALAR")
    .setArray(result.times)
    .setBuffer(buffer);
  const add = (nodeName, path, type, values) => {
    const node = nodes.get(nodeName);
    if (!node) throw new Error(`target bone ${nodeName} not found`);
    const output = document
      .createAccessor(`${result.name}-${nodeName}-${path}`)
      .setType(type)
      .setArray(values)
      .setBuffer(buffer);
    const sampler = document
      .createAnimationSampler()
      .setInput(input)
      .setOutput(output)
      .setInterpolation("LINEAR");
    animation.addSampler(sampler);
    animation.addChannel(
      document.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler),
    );
  };
  for (const [boneName, values] of result.rotations) add(boneName, "rotation", "VEC4", values);
  add("Hips", "translation", "VEC3", result.hipsTranslation);
}

/** Disposes an animation with its channels and samplers, so their accessors can be pruned. */
function disposeAnimation(animation) {
  for (const channel of animation.listChannels()) channel.dispose();
  for (const sampler of animation.listSamplers()) sampler.dispose();
  animation.dispose();
}

function replaceAnimations(document, nodes, results) {
  for (const animation of document.getRoot().listAnimations()) disposeAnimation(animation);
  for (const result of results) addAnimation(document, nodes, result);
}

function decompose(matrix) {
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, rotation, scale);
  return { position, rotation, scale };
}

/** Rebuilds the UAL document in place as a character on the 24-bone humanoid layout. */
function buildMannequin(document) {
  const root = document.getRoot();
  const scene = root.listScenes()[0];
  const oldSkin = root.listSkins()[0];
  const oldJoints = oldSkin.listJoints();
  const oldNames = oldJoints.map((joint) => joint.getName());
  const skinTargets = buildUalSkinTargets(oldNames);
  const newIndex = new Map(HUMANOID_BONES.map((bone, i) => [bone.name, i]));
  const jointMap = new Map(
    oldNames.map((name, i) => [i, newIndex.get(skinTargets.get(name) ?? "")]),
  );
  if ([...jointMap.values()].some((value) => value === undefined)) throw new Error("unmapped UAL joint");

  // Rest world matrices of the mapped UAL bones, plus two unweighted head markers.
  const worldOf = new Map();
  for (const joint of oldJoints) {
    const humanoid = UAL_TO_HUMANOID[joint.getName()];
    if (humanoid) worldOf.set(humanoid, new Matrix4().fromArray(joint.getWorldMatrix()));
  }
  const head = decompose(worldOf.get("Head"));
  const marker = (offset) =>
    new Matrix4().compose(head.position.clone().add(offset), head.rotation, new Vector3(1, 1, 1));
  worldOf.set("head_end", marker(new Vector3(0, 0.22, 0)));
  worldOf.set("headfront", marker(new Vector3(0, 0.04, 0.1)));

  const armature = document
    .createNode("Armature")
    .setScale([MANNEQUIN_SCALE, MANNEQUIN_SCALE, MANNEQUIN_SCALE]);
  const bones = new Map();
  const inverseBind = new Map();
  for (const spec of HUMANOID_BONES) {
    const world = worldOf.get(spec.name);
    if (!world) throw new Error(`no rest pose for ${spec.name}`);
    const parentWorld = spec.parent ? worldOf.get(spec.parent) : new Matrix4();
    const local = decompose(parentWorld.clone().invert().multiply(world));
    const node = document
      .createNode(spec.name)
      .setTranslation(local.position.toArray())
      .setRotation(local.rotation.toArray())
      .setScale([1, 1, 1]);
    bones.set(spec.name, node);
    (spec.parent ? bones.get(spec.parent) : armature).addChild(node);
    inverseBind.set(spec.name, world.clone().invert());
  }

  // Skin: the 24 joints in humanoid order. Bind pose equals the rest pose.
  const buffer = root.listBuffers()[0];
  const ibmArray = new Float32Array(HUMANOID_BONES.length * 16);
  HUMANOID_BONES.forEach((spec, i) => {
    inverseBind.get(spec.name).toArray(ibmArray, i * 16);
  });
  const skin = document
    .createSkin("Mannequin")
    .setInverseBindMatrices(
      document.createAccessor("ibm").setType("MAT4").setArray(ibmArray).setBuffer(buffer),
    );
  for (const spec of HUMANOID_BONES) skin.addJoint(bones.get(spec.name));

  // Re-point the vertex weights, merge the two materials into vertex colours, drop unused UVs.
  const mesh = root.listMeshes()[0];
  const material = document
    .createMaterial("mannequin")
    .setBaseColorFactor([1, 1, 1, 1])
    .setRoughnessFactor(0.85)
    .setMetallicFactor(0);
  const bodyColor = hexToLinear(BODY_COLOR);
  const jointColor = hexToLinear(JOINT_COLOR);
  for (const primitive of mesh.listPrimitives()) {
    const joints = primitive.getAttribute("JOINTS_0");
    const weights = primitive.getAttribute("WEIGHTS_0");
    const j = [0, 0, 0, 0];
    const w = [0, 0, 0, 0];
    for (let v = 0; v < joints.getCount(); v += 1) {
      joints.getElement(v, j);
      weights.getElement(v, w);
      const mapped = remapInfluences({ joints: [...j], weights: [...w] }, jointMap);
      joints.setElement(v, mapped.joints);
      weights.setElement(v, mapped.weights);
    }
    const color = /joint/i.test(primitive.getMaterial()?.getName() ?? "") ? jointColor : bodyColor;
    const colors = new Float32Array(joints.getCount() * 4);
    for (let v = 0; v < joints.getCount(); v += 1) colors.set(color, v * 4);
    primitive.setAttribute(
      "COLOR_0",
      document.createAccessor("color").setType("VEC4").setArray(colors).setBuffer(buffer),
    );
    primitive.setAttribute("TEXCOORD_0", null).setAttribute("TEXCOORD_1", null);
    primitive.setMaterial(material);
  }

  const meshNode = document.createNode("Mannequin").setMesh(mesh).setSkin(skin);
  armature.addChild(meshNode);
  const disposeTree = (node) => {
    for (const child of node.listChildren()) disposeTree(child);
    node.dispose();
  };
  for (const child of scene.listChildren()) disposeTree(child);
  oldSkin.dispose();
  scene.addChild(armature);
  return { bones, armature };
}

function summarize(document, filePath) {
  const root = document.getRoot();
  let triangles = 0;
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      triangles += (primitive.getIndices() ?? primitive.getAttribute("POSITION")).getCount() / 3;
    }
  }
  return {
    file: path.basename(filePath),
    bytes: statSync(filePath).size,
    triangles: Math.floor(triangles),
    bones: root.listSkins()[0]?.listJoints().length ?? 0,
    materials: root.listMaterials().length,
    clips: root.listAnimations().map((clip) => clip.getName()),
  };
}

async function main() {
  const { ual, out } = parseArgs();
  mkdirSync(out, { recursive: true });
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "meshopt.decoder": MeshoptDecoder,
    "meshopt.encoder": MeshoptEncoder,
  });

  const ualDocument = await io.read(ual);
  const sourceRig = readRig(ualDocument).rig;
  const sourceClips = readSourceClips(ualDocument);
  const report = {};

  // Pixel: keep the mesh, replace its clips.
  const pixel = await io.read(path.join(MODELS_DIR, "pixel-v1.glb"));
  const pixelRig = readRig(pixel);
  replaceAnimations(pixel, pixelRig.nodes, retargetAll(sourceRig, pixelRig.rig, sourceClips));
  await pixel.transform(prune(), dedup(), meshopt({ encoder: MeshoptEncoder, level: "high" }));
  const pixelPath = path.join(out, "spike-pixel.glb");
  await io.write(pixelPath, pixel);
  report.pixel = summarize(await io.read(pixelPath), pixelPath);

  // Mannequin: re-skin onto the 24 bones, simplify, then retarget onto the new rig.
  const mannequin = ualDocument;
  const { bones } = buildMannequin(mannequin);
  for (const animation of mannequin.getRoot().listAnimations()) disposeAnimation(animation);
  const before = summarize(mannequin, ual).triangles;
  await mannequin.transform(
    prune(),
    join({ keepMeshes: true, keepNamed: false }),
    weld(),
    simplify({
      simplifier: MeshoptSimplifier,
      ratio: MANNEQUIN_TRIANGLE_TARGET / before,
      error: 0.02,
    }),
    prune(),
    dedup(),
  );
  const mannequinRig = readRig(mannequin);
  replaceAnimations(mannequin, bones, retargetAll(sourceRig, mannequinRig.rig, sourceClips));
  await mannequin.transform(meshopt({ encoder: MeshoptEncoder, level: "high" }));
  const mannequinPath = path.join(out, "spike-mannequin.glb");
  await io.write(mannequinPath, mannequin);
  report.mannequin = {
    ...summarize(await io.read(mannequinPath), mannequinPath),
    trianglesBeforeSimplify: before,
  };

  console.log(JSON.stringify(report, null, 2));
}

await main();
