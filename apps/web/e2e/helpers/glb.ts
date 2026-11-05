import { expect } from "../fixtures";

// Helpers for reading the JSON chunk of a binary glTF. Geometry is meshopt-compressed but the
// JSON is not, so budgets (triangles, bones, clips) can be checked without decoding.

export interface GltfJson {
  accessors: { count: number }[];
  meshes: { primitives: { indices?: number; attributes: Record<string, number> }[] }[];
  nodes: { name?: string; children?: number[] }[];
  skins: { joints: number[] }[];
  materials: unknown[];
  animations: { name: string; channels: unknown[] }[];
}

export function parseGlbJson(buffer: Buffer): GltfJson {
  expect(buffer.toString("ascii", 0, 4)).toBe("glTF");
  const jsonLength = buffer.readUInt32LE(12);
  return JSON.parse(buffer.toString("utf8", 20, 20 + jsonLength)) as GltfJson;
}

export function countTriangles(gltf: GltfJson): number {
  let indexCount = 0;
  for (const mesh of gltf.meshes) {
    for (const primitive of mesh.primitives) {
      const accessor = primitive.indices ?? primitive.attributes.POSITION;
      const count = accessor === undefined ? 0 : (gltf.accessors[accessor]?.count ?? 0);
      indexCount += count;
    }
  }
  return indexCount / 3;
}

/** One "bone:parent" entry per skin joint, in joint order: the bone contract of a character. */
export function boneContract(gltf: GltfJson): string[] {
  const parentOf = new Map<number, number>();
  gltf.nodes.forEach((node, index) => {
    for (const child of node.children ?? []) parentOf.set(child, index);
  });
  return (gltf.skins[0]?.joints ?? []).map((joint) => {
    const parent = parentOf.get(joint);
    const parentName = parent === undefined ? "-" : (gltf.nodes[parent]?.name ?? "-");
    return `${gltf.nodes[joint]?.name ?? "?"}:${parentName}`;
  });
}
