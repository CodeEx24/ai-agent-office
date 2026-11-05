export type CrowdCharacter = "pixel" | "mannequin";

export interface CrowdSlot {
  id: string;
  character: CrowdCharacter;
  /** x, y, z in metres. */
  position: readonly [number, number, number];
  /** 0 to 1: where in the clip this character starts, so the crowd is not in lockstep. */
  phase: number;
}

export const CROWD_COLUMNS = 4;
const SPACING = 1.1;
const ROW_SPACING = 1.7;

/** Lays `count` characters out on a grid, alternating the two characters like a checkerboard. */
export function getCrowdSlots(count: number): CrowdSlot[] {
  const rows = Math.ceil(count / CROWD_COLUMNS);
  return Array.from({ length: count }, (_, index) => {
    const column = index % CROWD_COLUMNS;
    const row = Math.floor(index / CROWD_COLUMNS);
    const character: CrowdCharacter = (column + row) % 2 === 0 ? "pixel" : "mannequin";
    return {
      id: `${character}-${String(index + 1)}`,
      character,
      position: [
        (column - (CROWD_COLUMNS - 1) / 2) * SPACING,
        0,
        (row - (rows - 1) / 2) * ROW_SPACING,
      ] as const,
      phase: (index * 0.37) % 1,
    };
  });
}
