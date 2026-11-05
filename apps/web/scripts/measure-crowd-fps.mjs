// Measures the frame rate of the dev-only crowd page (AGO-64) in a real browser and prints JSON.
//
//   pnpm --filter @ago/web build && PORT=$(node scripts/free-port.mjs) ENABLE_DEV_3D=1 pnpm --filter @ago/web start
//   node apps/web/scripts/measure-crowd-fps.mjs http://127.0.0.1:<port> [flags]
//
// Flags: --headed  --uncapped (no vsync or frame limit)  --low-power-gpu (integrated GPU)
//        --high-performance-gpu (discrete GPU)  --width=<px> --height=<px> --dpr=<n>
//        --cpu-throttle=<n> (CDP CPU slowdown, 4 is roughly a mid-range laptop CPU)  --seconds=<n>
// The result records the browser, the real GPU string and the settings, so the number can be
// read honestly. A vsync-capped run reports the display refresh rate, not the headroom.
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const baseUrl = args.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:3100";
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? Number(found.split("=")[1]) : fallback;
};
const seconds = value("seconds", 8);
const cpuThrottle = value("cpu-throttle", 1);

const launchArgs = [];
if (flag("uncapped")) launchArgs.push("--disable-frame-rate-limit", "--disable-gpu-vsync");
if (flag("low-power-gpu")) launchArgs.push("--force_low_power_gpu");
if (flag("high-performance-gpu")) launchArgs.push("--force_high_performance_gpu");

const browser = await chromium.launch({
  channel: process.env.E2E_BROWSER_CHANNEL ?? "msedge",
  headless: !flag("headed"),
  args: launchArgs,
});
const page = await browser.newPage({
  viewport: { width: value("width", 1280), height: value("height", 900) },
  deviceScaleFactor: value("dpr", 1),
});
if (cpuThrottle > 1) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
}
await page.goto(`${baseUrl}/dev/3d/crowd`);
await page.waitForFunction(() => window.__crowdPerf?.activeClips().length === 8, null, { timeout: 60_000 });

const results = {};
for (const clip of ["Idle", "Walk", "Talk"]) {
  await page.getByRole("button", { name: clip }).click();
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.__crowdPerf?.reset());
  await page.waitForTimeout(seconds * 1000);
  results[clip] = await page.evaluate(() => {
    const perf = window.__crowdPerf;
    return { ...perf?.summary(), drawCalls: perf?.drawCalls(), triangles: perf?.triangles() };
  });
}
const environment = await page.evaluate(() => ({
  renderer: window.__crowdPerf?.renderer,
  userAgent: navigator.userAgent,
  devicePixelRatio: window.devicePixelRatio,
}));
console.log(
  JSON.stringify(
    { baseUrl, headed: flag("headed"), viewport: [value("width", 1280), value("height", 900), value("dpr", 1)], uncapped: flag("uncapped"), lowPowerGpu: flag("low-power-gpu"), cpuThrottle, seconds, environment, results },
    null,
    2,
  ),
);
await browser.close();
