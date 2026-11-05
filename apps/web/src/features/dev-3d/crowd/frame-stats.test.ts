import { describe, expect, it } from "vitest";

import { FrameWindow, summarizeFrames } from "./frame-stats";

describe("summarizeFrames", () => {
  it("returns zeros for no frames", () => {
    expect(summarizeFrames([])).toEqual({
      frames: 0,
      fps: 0,
      avgFrameMs: 0,
      p95FrameMs: 0,
      worstFrameMs: 0,
    });
  });

  it("derives fps from the mean frame time", () => {
    const summary = summarizeFrames([16, 17, 16, 17]);
    expect(summary.frames).toBe(4);
    expect(summary.avgFrameMs).toBeCloseTo(16.5, 6);
    expect(summary.fps).toBeCloseTo(1000 / 16.5, 6);
  });

  it("reports the 95th percentile and the worst frame", () => {
    const frames = Array.from({ length: 100 }, (_, i) => (i === 99 ? 120 : 10));
    const summary = summarizeFrames(frames);
    expect(summary.p95FrameMs).toBe(10);
    expect(summary.worstFrameMs).toBe(120);
  });

  it("does not mutate its input", () => {
    const frames = [30, 10, 20];
    summarizeFrames(frames);
    expect(frames).toEqual([30, 10, 20]);
  });
});

describe("FrameWindow", () => {
  it("keeps only the most recent frames", () => {
    const window = new FrameWindow(3);
    [10, 10, 10, 40, 40, 40].forEach((ms) => {
      window.push(ms);
    });
    expect(window.summary().frames).toBe(3);
    expect(window.summary().avgFrameMs).toBe(40);
  });

  it("clears", () => {
    const window = new FrameWindow(3);
    window.push(10);
    window.clear();
    expect(window.summary().frames).toBe(0);
  });
});
