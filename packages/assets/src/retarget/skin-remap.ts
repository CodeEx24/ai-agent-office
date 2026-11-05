export interface Influences {
  joints: readonly [number, number, number, number];
  weights: readonly [number, number, number, number];
}

/**
 * Re-points one vertex's four joint influences through `jointMap` (old joint index -> new joint
 * index). When two influences land on the same new joint (a finger and the hand, say) their
 * weights add. The result is renormalised to sum to 1 and unused slots are zero-weighted joint 0.
 */
export function remapInfluences(
  vertex: Influences,
  jointMap: ReadonlyMap<number, number>,
): Influences {
  const merged = new Map<number, number>();
  for (let i = 0; i < 4; i += 1) {
    const weight = vertex.weights[i] ?? 0;
    if (weight <= 0) continue;
    const oldJoint = vertex.joints[i] ?? 0;
    const newJoint = jointMap.get(oldJoint);
    if (newJoint === undefined) {
      throw new Error(`Joint ${String(oldJoint)} has no target joint`);
    }
    merged.set(newJoint, (merged.get(newJoint) ?? 0) + weight);
  }
  const entries = [...merged.entries()].sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  const joints: [number, number, number, number] = [0, 0, 0, 0];
  const weights: [number, number, number, number] = [0, 0, 0, 0];
  entries.slice(0, 4).forEach(([joint, weight], i) => {
    joints[i] = joint;
    weights[i] = total > 0 ? weight / total : 0;
  });
  return { joints, weights };
}
