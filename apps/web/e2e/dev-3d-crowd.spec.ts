import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { expect, test } from "./fixtures";
import { withGatedServer } from "./helpers/gated-server";
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
    test.setTimeout(180_000);
    await page.goto("/dev/3d/crowd");
    await page.waitForFunction(() => window.__crowdPerf?.activeClips().length === 8, null, {
      timeout: 30_000,
    });
    const readRoster = () => page.evaluate(() => window.__crowdPerf?.activeClips() ?? []);
    // SwiftShader can render only a few frames per second, so budgets are generous. The proof is
    // state-based (clip names and mixer clocks), never sampled pixels.
    const budget = 30_000;

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
            const roster = await readRoster();
            return roster.length === 8 && roster.every((m) => m.isRunning && m.clip === clip);
          },
          { timeout: budget, message: `all 8 characters play ${clip}` },
        )
        .toBe(true);
      // Every mixer clock keeps advancing, so each character is animating rather than frozen.
      const before = new Map((await readRoster()).map((m) => [m.id, m.mixerTime]));
      await expect
        .poll(
          async () => {
            const roster = await readRoster();
            return (
              roster.length === 8 &&
              roster.every((m) => m.clip === clip && m.mixerTime > (before.get(m.id) ?? Infinity))
            );
          },
          { timeout: budget, message: `all 8 mixers advance while playing ${clip}` },
        )
        .toBe(true);
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

  test("AC1 (edge): double clicking a clip button leaves exactly one clip selected on all 8", async ({
    page,
  }) => {
    await page.goto("/dev/3d/crowd");
    await page.waitForFunction(() => window.__crowdPerf?.activeClips().length === 8, null, {
      timeout: 30_000,
    });
    const talk = page.getByRole("button", { name: "Talk", exact: true });
    await talk.dblclick();
    await expect(talk).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('button[aria-pressed="true"]')).toHaveCount(1);
    // Same generous budget as the clip-switch test: SwiftShader under CI load renders few fps.
    await expect
      .poll(
        async () => {
          const roster = await page.evaluate(() => window.__crowdPerf?.activeClips() ?? []);
          return roster.length === 8 && roster.every((m) => m.isRunning && m.clip === "Talk");
        },
        { timeout: 30_000, message: "all 8 characters play Talk after a double click" },
      )
      .toBe(true);
  });

  test("AC1 (negative): a production build without ENABLE_DEV_3D answers 404 for the crowd page", async ({
    request,
  }) => {
    await withGatedServer(async (baseUrl) => {
      const gated = await request.get(`${baseUrl}/dev/3d/crowd`, { failOnStatusCode: false });
      expect(gated.status()).toBe(404);
      // The rendered page content must be absent. The metadata title can appear in the streamed
      // payload of any gated page (same as /dev/3d), so assert on the body content instead.
      const html = await gated.text();
      expect(html).not.toContain("Eight animated characters");
      expect(html).not.toContain("crowd-count");
      expect(html).not.toContain("<canvas");
    }, request);
  });

  test("AC1 (isolation): the home page requests no spike model", async ({ page }) => {
    const modelRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().endsWith(".glb")) modelRequests.push(req.url());
    });
    await page.goto("/", { waitUntil: "networkidle" });
    expect(modelRequests).toEqual([]);
  });

  test("AC1: every animation channel targets a bone of the shared 24-bone contract", async ({
    request,
  }) => {
    for (const url of GLB_URLS) {
      const gltf = parseGlbJson(await (await request.get(url)).body());
      // boneContract entries are "bone:parent"; keep the bone name.
      const contract = new Set(boneContract(gltf).map((entry) => entry.split(":")[0]));
      for (const animation of gltf.animations) {
        const targets = (animation.channels as { target: { node: number } }[]).map(
          (channel) => gltf.nodes[channel.target.node]?.name ?? "",
        );
        expect(targets.length, `${url} ${animation.name}`).toBeGreaterThan(0);
        for (const name of targets) {
          expect(contract.has(name), `${url} ${animation.name} targets unknown bone ${name}`).toBe(
            true,
          );
        }
      }
    }
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

  test("AC3: the decision records the reasoning, the bone contract and the mapping table", () => {
    const notes = readFileSync(path.resolve(process.cwd(), "../../docs/tickets/AGO-64.md"), "utf8");
    expect(notes).toMatch(/## Decision: shared skeleton confirmed with changes/);
    expect(notes).toMatch(/names and hierarchy, not rest pose/);
    expect(notes).toMatch(/24-bone humanoid bone contract/);
    expect(notes).toMatch(/\| UAL joint \| Humanoid bone \|/);
    for (const joint of ["pelvis", "spine_01", "thigh_l", "upperarm_r", "hand_l"]) {
      expect(notes, `mapping row for ${joint}`).toContain(`\`${joint}\``);
    }
  });

  test("AC3: every committed model is listed in SOURCES.md with a licence and stays under 5 MB", () => {
    const modelsDir = path.resolve(process.cwd(), "../../packages/assets/models");
    const sources = readFileSync(path.join(modelsDir, "SOURCES.md"), "utf8");
    const glbs = readdirSync(modelsDir).filter((file) => file.endsWith(".glb"));
    expect(glbs.length).toBeGreaterThanOrEqual(3);
    for (const glb of glbs) {
      const row = sources.split("\n").find((line) => line.startsWith(`| \`${glb}\``));
      expect(row, `${glb} has a SOURCES.md row`).toBeDefined();
      expect(row, `${glb} row names a licence`).toMatch(/CC0|Project asset/);
      expect(statSync(path.join(modelsDir, glb)).size, `${glb} bytes`).toBeLessThan(5_000_000);
    }
    // The second character and the clip source are CC0, with the source page recorded.
    expect(sources).toMatch(/`spike-mannequin\.glb`[^\n]*CC0 1\.0/);
    expect(sources).toContain("https://quaternius.itch.io/universal-animation-library");
  });
});
