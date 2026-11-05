import { type AnimationClip, type Material, type Mesh, type Object3D, type Texture } from "three";

export interface TextureStat {
  name: string;
  width: number;
  height: number;
}

export interface ModelStats {
  triangles: number;
  bones: number;
  meshes: number;
  materials: number;
  textures: TextureStat[];
  clips: string[];
}

function isMesh(object: Object3D): object is Mesh {
  return "isMesh" in object && object.isMesh === true;
}

function isSkinnedMesh(object: Object3D): object is Mesh & { skeleton: { bones: Object3D[] } } {
  return "isSkinnedMesh" in object && object.isSkinnedMesh === true;
}

/** Triangles drawn by one mesh: index count when indexed, otherwise vertex count, divided by 3. */
function countMeshTriangles(mesh: Mesh): number {
  const { index, attributes } = mesh.geometry;
  const position = attributes.position;
  const vertexCount = index ? index.count : (position?.count ?? 0);
  return Math.floor(vertexCount / 3);
}

function readTexture(texture: Texture): TextureStat {
  const image = texture.image as { width?: number; height?: number } | null | undefined;
  return { name: texture.name, width: image?.width ?? 0, height: image?.height ?? 0 };
}

/** Walks a loaded glTF scene and reports the numbers the style guide budgets (section 8). */
export function collectModelStats(root: Object3D, clips: readonly AnimationClip[]): ModelStats {
  let triangles = 0;
  let meshes = 0;
  const bones = new Set<Object3D>();
  const materials = new Set<Material>();
  const textures = new Map<string, TextureStat>();

  root.traverse((object) => {
    if (!isMesh(object)) return;
    meshes += 1;
    triangles += countMeshTriangles(object);
    if (isSkinnedMesh(object)) {
      for (const bone of object.skeleton.bones) bones.add(bone);
    }
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value && typeof value === "object" && "isTexture" in value) {
          const texture = value as Texture;
          textures.set(texture.uuid, readTexture(texture));
        }
      }
    }
  });

  return {
    triangles,
    bones: bones.size,
    meshes,
    materials: materials.size,
    textures: [...textures.values()],
    clips: clips.map((clip) => clip.name),
  };
}

export type ClipKind = "idle" | "walk";

const CLIP_PATTERNS: Record<ClipKind, RegExp> = {
  idle: /idle/i,
  walk: /walk/i,
};

/** Finds the first clip whose name matches the kind, so the viewer does not depend on exact vendor names. */
export function findClipName(clipNames: readonly string[], kind: ClipKind): string | undefined {
  return clipNames.find((name) => CLIP_PATTERNS[kind].test(name));
}
