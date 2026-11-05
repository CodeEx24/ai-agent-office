import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "./fixtures";
import { boneContract, countTriangles, parseGlbJson } from "./helpers/glb";

// AGO-64 acceptance criteria. The Playwright webServer runs a production build with
// ENABLE_DEV_3D=1, so /dev/3d/crowd is reachable. The console-error guard in ./fixtures fails
// every test on any console error or page error. No spec asserts an FPS threshold: CI has no GPU,
// so the frame rate is recorded in docs/tickets/AGO-64.md, not gated here.

const GLB_URLS = ["/models/spike-pixel.glb", "/models/spike-mannequin.glb"] as const;
const CLIPS = ["Idle", "Walk", "Talk"] as const;
// Style guide section 8, character row.
const MAX_TRIANGLES = 10_000;
const MAX_BONES = 40;

test.describe("/dev/3d/crowd", () => {
  test("AC1: renders 8 animated characters, 4 Pixel and 4 Mannequin", async ({ page }) => {
    const response = await page.goto("/dev/3d/crowd");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "3D crowd test page" })).toBeVisible();
    await expect(page.locator("canvas")).toBeVisible();
    await expect(page.getByTestId("crowd-count")).toContainText(
      "8 characters: 4 Pixel, 4 Mannequin",
    );

    await page.waitForFunction(() => window.__crowdPerf?.activeClips().length === 8, null, {
      timeout: 30_000,
    });
    const roster = await page.evaluate(() => window.__crowdPerf?.activeClips() ?? []);
    expect(roster.filter((member) => member.character === "pixel")).toHaveLength(4);
    expect(roster.filter((member) => member.character === "mannequin")).toHaveLength(4);
  });

  test("AC1: both characters play the same three clips and every character follows the switch", async ({
    page,
  }) => {
    await page.goto("/dev/3d/crowd");
    await page.waitForFunction(() => window.__crowdPerf?.activeClips().length === 8, null, {
      timeout: 30_000,
    });
    const canvas = page.locator("canvas");
    const canvasKeepsChanging = async (): Promise<boolean> => {
      const first = await canvas.screenshot();
      const second = await canvas.screenshot();
      return !first.equals(second);
    };

    for (const clip of CLIPS) {
      const button = page.getByRole("button", { name: clip, exact: true });
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "true");
      for (const other of CLIPS.filter((name) => name !== clip)) {
        await expect(page.getByRole("button", { name: other, exact: true })).toHaveAttribute(
          "aria-pressed",
          "false",
        );
      }
      // Each of the 8 mixers reports the selected clip as running.
      await expect
        .poll(
          async () => {
            const roster = await page.evaluate(() => window.__crowdPerf?.activeClips() ?? []);
            return roster.length === 8 && roster.every((m) => m.isRunning && m.clip === clip);
          },
          { timeout: 10_000, message: `all 8 characters play ${clip}` },
        )
        .toBe(true);
      await expect.poll(canvasKeepsChanging, { timeout: 10_000 }).toBe(true);
    }
  });

  test("AC1: both GLBs carry exactly Idle, Walk and Talk on an identical bone contract", async ({
    request,
  }) => {
    const contracts: string[][] = [];
    for (const url of GLB_URLS) {
      const response = await request.get(url);
      expect(response.status(), url).toBe(200);
      const gltf = parseGlbJson(await response.body());
      expect(gltf.animations.map((animation) => animation.name).sort(), url).toEqual(
        [...CLIPS].sort(),
      );
      for (const animation of gltf.animations) {
        expect(animation.channels.length, `${url} ${animation.name}`).toBeGreaterThan(0);
      }
      contracts.push(boneContract(gltf));
    }
    expect(contracts[0]).toHaveLength(24);
    expect(contracts[1]).toEqual(contracts[0]);
  });

  test("AC2: the page shows a live frame rate, draw calls and the GPU it ran on", async ({
    page,
  }) => {
    await page.goto("/dev/3d/crowd");
    const readout = page.getByTestId("crowd-fps");
    await expect(readout).toContainText(/\d+ fps, [\d.]+ ms avg/, { timeout: 30_000 });
    await expect(readout).toContainText("draw calls");
    const fps = Number(await readout.getAttribute("data-fps"));
    expect(fps).toBeGreaterThan(0);

    const perf = await page.evaluate(() => {
      const bridge = window.__crowdPerf;
      return bridge
        ? {
            renderer: bridge.renderer,
            drawCalls: bridge.drawCalls(),
            frames: bridge.summary().frames,
          }
        : null;
    });
    expect(perf?.renderer.length).toBeGreaterThan(0);
    expect(perf?.drawCalls).toBeGreaterThan(0);
    expect(perf?.frames).toBeGreaterThan(0);
  });

  test("AC2: each character stays inside the style guide budget", async ({ request }) => {
    for (const url of GLB_URLS) {
      const body = await (await request.get(url)).body();
      const gltf = parseGlbJson(body);
      expect(countTriangles(gltf), `${url} triangles`).toBeLessThanOrEqual(MAX_TRIANGLES);
      expect(gltf.skins[0]?.joints.length, `${url} bones`).toBeLessThanOrEqual(MAX_BONES);
      expect(gltf.materials, `${url} materials`).toHaveLength(1);
      expect(body.byteLength, `${url} bytes`).toBeLessThan(1_000_000);
    }
  });

  test("AC3: the ticket notes record the shared skeleton decision and the measured frame rate", () => {
    const notes = readFileSync(path.resolve(process.cwd(), "../../docs/tickets/AGO-64.md"), "utf8");
    expect(notes).toMatch(/Decision: shared skeleton (confirmed|changed)/i);
    expect(notes).toMatch(/^#{2,3} Frame rate/m);
    expect(notes).toMatch(/not a mid-range laptop/i);
    expect(notes).toMatch(/Bone mapping/i);
    expect(notes).toMatch(/CC0/);
  });
});
