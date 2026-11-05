// Character GLB pipeline (AGO-49): raw image-to-3D output -> game-ready GLB.
//
//   node scripts/optimize-character.mjs <raw.glb> <out-dir> [name]
//
// Steps, kept separate on purpose (no `optimize` preset: it may simplify or flatten the rig):
//   1. drop the unused TANGENT attribute (no normal map in the style guide, section 6)
//   2. rename the vendor walk clip to "Walk"
//   3. author a looping "Idle" clip (subtle breathing sway, baked at 30 fps)
//   4. resize the base colour texture to 1024 and re-encode as WebP (style guide, section 8)
//   5. write <name>.meshopt.glb (shipped: three's meshopt decoder is bundled, no CDN fetch)
//   6. write <name>.draco.glb and <name>.uncompressed.glb for size comparison only
//
// Prints a JSON report with triangle, bone, texture and file-size numbers.
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { meshopt, draco, textureCompress } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import { MeshoptEncoder, MeshoptDecoder } from "meshoptimizer";
import sharp from "sharp";

const FPS = 30;
const IDLE_SECONDS = 4;
const TEXTURE_SIZE = 1024;

// Bone -> [axis, amplitude in degrees, phase in radians]. Small deltas, so the pose never leaves the A-pose.
const IDLE_SWAY = {
  Spine: ["x", 1.2, 0],
  Spine01: ["x", 1.6, 0.4],
  Spine02: ["x", 2, 0.8],
  Head: ["x", 2.5, 1.4],
  LeftArm: ["z", 2, 0.6],
  RightArm: ["z", -2, 0.6],
  LeftForeArm: ["x", 3, 1.1],
  RightForeArm: ["x", 3, 1.1],
};

/** Hamilton product a * b, quaternions as [x, y, z, w]. */
function multiply(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function axisAngle(axis, radians) {
  const s = Math.sin(radians / 2);
  const c = Math.cos(radians / 2);
  return [axis === "x" ? s : 0, axis === "y" ? s : 0, axis === "z" ? s : 0, c];
}

/** Adds a seamless looping Idle clip. Each key is rest rotation * small delta: glTF rotation channels replace the local rotation. */
function addIdleClip(document) {
  const root = document.getRoot();
  const buffer = root.listBuffers()[0];
  const clip = document.createAnimation("Idle");
  const frameCount = IDLE_SECONDS * FPS + 1;
  const times = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) times[i] = i / FPS;

  const input = document.createAccessor("idle-times").setType("SCALAR").setArray(times).setBuffer(buffer);
  const bones = new Map(root.listNodes().map((node) => [node.getName(), node]));

  for (const [boneName, [axis, degrees, phase]] of Object.entries(IDLE_SWAY)) {
    const bone = bones.get(boneName);
    if (!bone) throw new Error(`Idle: bone ${boneName} not found`);
    const rest = bone.getRotation();
    const values = new Float32Array(frameCount * 4);
    for (let i = 0; i < frameCount; i += 1) {
      // Whole number of sine periods over the clip, and the last key repeats the first, so it loops cleanly.
      const angle = (degrees * Math.PI) / 180 * Math.sin((2 * Math.PI * i) / (frameCount - 1) + phase);
      const q = i === frameCount - 1 ? values.slice(0, 4) : multiply(rest, axisAngle(axis, angle));
      values.set(q, i * 4);
    }
    const output = document
      .createAccessor(`idle-${boneName}`)
      .setType("VEC4")
      .setArray(values)
      .setBuffer(buffer);
    const sampler = document.createAnimationSampler().setInput(input).setOutput(output).setInterpolation("LINEAR");
    clip.addSampler(sampler);
    clip.addChannel(
      document.createAnimationChannel().setTargetNode(bone).setTargetPath("rotation").setSampler(sampler),
    );
  }
}

function summarize(document, filePath) {
  const root = document.getRoot();
  let triangles = 0;
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      triangles += (indices ?? primitive.getAttribute("POSITION")).getCount() / 3;
    }
  }
  return {
    file: path.basename(filePath),
    bytes: statSync(filePath).size,
    triangles: Math.floor(triangles),
    bones: root.listSkins().reduce((sum, skin) => sum + skin.listJoints().length, 0),
    materials: root.listMaterials().length,
    clips: root.listAnimations().map((clip) => clip.getName()),
    textures: root.listTextures().map((texture) => ({
      mimeType: texture.getMimeType(),
      size: texture.getSize(),
      bytes: texture.getImage()?.byteLength ?? 0,
    })),
  };
}

async function main() {
  const [input, outDir, name = "pixel-v1"] = process.argv.slice(2);
  if (!input || !outDir) throw new Error("usage: optimize-character.mjs <raw.glb> <out-dir> [name]");
  mkdirSync(outDir, { recursive: true });

  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      "draco3d.decoder": await draco3d.createDecoderModule(),
      "draco3d.encoder": await draco3d.createEncoderModule(),
      "meshopt.decoder": MeshoptDecoder,
      "meshopt.encoder": MeshoptEncoder,
    });

  const document = await io.read(input);
  const raw = summarize(document, input);

  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) primitive.setAttribute("TANGENT", null);
  }
  for (const clip of document.getRoot().listAnimations()) {
    if (/walk/i.test(clip.getName())) clip.setName("Walk");
  }
  addIdleClip(document);
  await document.transform(
    textureCompress({ encoder: sharp, targetFormat: "webp", resize: [TEXTURE_SIZE, TEXTURE_SIZE], quality: 85 }),
  );

  const uncompressedPath = path.join(outDir, `${name}.uncompressed.glb`);
  await io.write(uncompressedPath, document);

  const dracoDocument = await io.read(uncompressedPath);
  await dracoDocument.transform(draco());
  const dracoPath = path.join(outDir, `${name}.draco.glb`);
  await io.write(dracoPath, dracoDocument);

  const meshoptDocument = await io.read(uncompressedPath);
  await meshoptDocument.transform(meshopt({ encoder: MeshoptEncoder, level: "high" }));
  const meshoptPath = path.join(outDir, `${name}.meshopt.glb`);
  await io.write(meshoptPath, meshoptDocument);

  const report = {
    raw,
    uncompressed: summarize(await io.read(uncompressedPath), uncompressedPath),
    draco: { file: path.basename(dracoPath), bytes: statSync(dracoPath).size },
    meshopt: summarize(await io.read(meshoptPath), meshoptPath),
  };
  console.log(JSON.stringify(report, null, 2));
}

await main();
