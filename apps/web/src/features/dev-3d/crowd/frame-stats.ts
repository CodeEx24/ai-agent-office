export interface FrameSummary {
  frames: number;
  fps: number;
  avgFrameMs: number;
  p95FrameMs: number;
  worstFrameMs: number;
}

const EMPTY: FrameSummary = { frames: 0, fps: 0, avgFrameMs: 0, p95FrameMs: 0, worstFrameMs: 0 };

/** Summarises frame durations (milliseconds): mean fps, mean and 95th percentile frame time, worst frame. */
export function summarizeFrames(frameMs: readonly number[]): FrameSummary {
  if (frameMs.length === 0) return EMPTY;
  const sorted = [...frameMs].sort((a, b) => a - b);
  const total = sorted.reduce((sum, ms) => sum + ms, 0);
  const avgFrameMs = total / sorted.length;
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    frames: sorted.length,
    fps: avgFrameMs > 0 ? 1000 / avgFrameMs : 0,
    avgFrameMs,
    p95FrameMs: sorted[p95Index] ?? 0,
    worstFrameMs: sorted[sorted.length - 1] ?? 0,
  };
}

/** Fixed-size rolling window of frame durations. */
export class FrameWindow {
  private readonly values: number[] = [];

  constructor(private readonly capacity: number) {}

  push(frameMs: number): void {
    this.values.push(frameMs);
    if (this.values.length > this.capacity) this.values.shift();
  }

  clear(): void {
    this.values.length = 0;
  }

  summary(): FrameSummary {
    return summarizeFrames(this.values);
  }
}
