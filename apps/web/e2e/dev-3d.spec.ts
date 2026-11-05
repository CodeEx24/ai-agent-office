import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";

import { expect, test } from "./fixtures";

// AGO-49 acceptance criteria, one spec each. The Playwright webServer runs a production build
// with ENABLE_DEV_3D=1, so /dev/3d is reachable there. The console-error guard in ./fixtures
// fails every test on any console error or page error.

const GLB_URL = "/models/pixel-v1.glb";
// Style guide section 8, character row.
const MAX_TRIANGLES = 10_000;
const MAX_BONES = 40;
const MAX_TEXTURE_SIDE = 1024;

interface GltfJson {
  accessors: { count: number }[];
  meshes: { primitives: { indices?: number; attributes: Record<string, number> }[] }[];
  skins: { joints: number[] }[];
  materials: unknown[];
  animations: { name: string; channels: unknown[] }[];
}

/** Reads the JSON chunk of a binary glTF (geometry is meshopt-compressed, the JSON is not). */
function parseGlbJson(buffer: Buffer): GltfJson {
  expect(buffer.toString("ascii", 0, 4)).toBe("glTF");
  const jsonLength = buffer.readUInt32LE(12);
  return JSON.parse(buffer.toString("utf8", 20, 20 + jsonLength)) as GltfJson;
}

function countTriangles(gltf: GltfJson): number {
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

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

test.describe("/dev/3d", () => {
  test("AC1: renders the rigged model and the idle and walk clips play and switch", async ({
    page,
  }) => {
    const response = await page.goto("/dev/3d");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "3D model test page" })).toBeVisible();

    const canvas = page.locator("canvas");
    await expect(canvas).toBeVisible();
    const stats = page.getByTestId("dev-3d-stats");
    await expect(stats).not.toContainText("loading", { timeout: 30_000 });
    await expect(stats).toContainText("Idle");
    await expect(stats).toContainText("Walk");

    const idle = page.getByRole("button", { name: "Idle" });
    const walk = page.getByRole("button", { name: "Walk" });
    await expect(idle).toHaveAttribute("aria-pressed", "true");
    await expect(walk).toHaveAttribute("aria-pressed", "false");

    // A real clip drives the mixer, so the rendered canvas keeps changing under each clip.
    const canvasKeepsChanging = async (): Promise<boolean> => {
      const first = await canvas.screenshot();
      const second = await canvas.screenshot();
      return !first.equals(second);
    };

    await walk.click();
    await expect(walk).toHaveAttribute("aria-pressed", "true");
    await expect(idle).toHaveAttribute("aria-pressed", "false");
    await expect.poll(canvasKeepsChanging, { timeout: 10_000 }).toBe(true);

    await idle.click();
    await expect(idle).toHaveAttribute("aria-pressed", "true");
    await expect(walk).toHaveAttribute("aria-pressed", "false");
    await expect.poll(canvasKeepsChanging, { timeout: 10_000 }).toBe(true);
  });

  test("AC1 (edge): double clicking a clip button keeps exactly one clip selected", async ({
    page,
  }) => {
    await page.goto("/dev/3d");
    await expect(page.getByTestId("dev-3d-stats")).not.toContainText("loading", {
      timeout: 30_000,
    });

    const walk = page.getByRole("button", { name: "Walk" });
    await walk.dblclick();
    await expect(walk).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Idle" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.locator("canvas")).toBeVisible();
  });

  test("AC1 (negative): a production build without ENABLE_DEV_3D answers 404", async ({
    request,
  }) => {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    // Playwright runs with apps/web as the working directory.
    const nextBin = createRequire(path.join(process.cwd(), "package.json")).resolve(
      "next/dist/bin/next",
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      APP_ENV: "local",
      NEXT_PUBLIC_APP_URL: baseUrl,
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    };
    delete env.ENABLE_DEV_3D;

    let server: ChildProcess | undefined;
    try {
      server = spawn(
        process.execPath,
        [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)],
        { env, cwd: process.cwd(), stdio: "ignore" },
      );
      await expect
        .poll(
          async () => {
            try {
              return (await request.get(`${baseUrl}/`)).status();
            } catch {
              return 0;
            }
          },
          { timeout: 60_000 },
        )
        .toBe(200);

      const gated = await request.get(`${baseUrl}/dev/3d`, { failOnStatusCode: false });
      expect(gated.status()).toBe(404);
      expect(await gated.text()).not.toContain("3D model test page");
    } finally {
      server?.kill();
    }
  });

  test("AC1 (isolation): the home page loads neither three.js nor the model", async ({ page }) => {
    const scriptUrls: string[] = [];
    const modelRequests: string[] = [];
    page.on("response", (response) => {
      if (response.request().resourceType() === "script") scriptUrls.push(response.url());
    });
    page.on("request", (request) => {
      if (request.url().endsWith(".glb")) modelRequests.push(request.url());
    });

    await page.goto("/", { waitUntil: "networkidle" });

    expect(scriptUrls.length).toBeGreaterThan(0);
    for (const url of scriptUrls) {
      const body = await (await page.request.get(url)).text();
      expect(body, `${url} must not bundle three.js or react-three-fiber`).not.toMatch(
        /WebGLRenderer|__R3F/,
      );
    }
    expect(modelRequests).toEqual([]);
  });

  test("AC2: the shipped GLB is a skinned model with idle and walk AnimationClips", async ({
    request,
  }) => {
    const response = await request.get(GLB_URL);
    expect(response.status()).toBe(200);
    const gltf = parseGlbJson(await response.body());

    expect(gltf.skins).toHaveLength(1);
    expect(gltf.animations.map((animation) => animation.name)).toEqual(
      expect.arrayContaining(["Idle", "Walk"]),
    );
    for (const animation of gltf.animations) {
      expect(animation.channels.length, `${animation.name} has channels`).toBeGreaterThan(0);
    }
  });

  test("AC2: the ticket findings say whether the output is rigged and give a fallback path", () => {
    const notes = readFileSync(path.resolve(process.cwd(), "../../docs/tickets/AGO-49.md"), "utf8");
    expect(notes).toMatch(/Is Higgsfield's output rigged and usable\? Yes/);
    expect(notes).toMatch(/### Fallbacks/);
    expect(notes).toMatch(/CC0 clip packs/);
    expect(notes).toMatch(/Rigify/);
  });

  test("AC3: triangles, bones, materials and texture are within the style guide budget", async ({
    page,
    request,
  }) => {
    const gltf = parseGlbJson(await (await request.get(GLB_URL)).body());
    const triangles = countTriangles(gltf);
    const bones = gltf.skins[0]?.joints.length ?? 0;
    expect(triangles).toBeGreaterThan(5000);
    expect(triangles).toBeLessThanOrEqual(MAX_TRIANGLES);
    expect(bones).toBeGreaterThan(0);
    expect(bones).toBeLessThanOrEqual(MAX_BONES);
    expect(gltf.materials).toHaveLength(1);

    // The page reports the same figures once three.js has parsed the model.
    await page.goto("/dev/3d");
    const stats = page.getByTestId("dev-3d-stats");
    await expect(stats).not.toContainText("loading", { timeout: 30_000 });
    await expect(stats).toContainText(String(triangles));
    await expect(stats).toContainText(String(bones));
    const texture = await stats
      .getByText(/^\d+x\d+$/)
      .first()
      .innerText();
    const [width, height] = texture.split("x").map(Number);
    expect(width).toBeLessThanOrEqual(MAX_TEXTURE_SIDE);
    expect(height).toBeLessThanOrEqual(MAX_TEXTURE_SIDE);
  });

  test("AC3: the shipped GLB stays small (meshopt, under 1 MB)", async ({ request }) => {
    const response = await request.get(GLB_URL);
    expect((await response.body()).byteLength).toBeLessThan(1_000_000);
  });
});
