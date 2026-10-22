// Smoke test: serve the app, open each example in headless Chrome, poke every
// entry point through window.codeworld, and screenshot the world mid-run.
// Fails on any page error or console error. Shots land in shots/.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const only = process.argv[2];
mkdirSync("shots", { recursive: true });
const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=metal", "--enable-gpu"] });
const errors = [];
try {
  for (const name of only ? [only] : ["hello-pipeline", "order-service", "batch-ledger"]) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
    await page.goto(`http://localhost:5199/?example=${name}`);
    await page.waitForFunction(() => window.codeworld, null, { timeout: 30000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `shots/${name}-0-idle.png` });
    const fired = await page.evaluate(() => {
      const cw = window.codeworld;
      const out = [];
      for (const f of cw.graph.fns)
        for (const t of f.triggers) {
          try {
            if (t.kind === "route") out.push(cw.request(t.method, t.path.replace(/:\w+/g, "1001"), t.example ?? {}).label);
            if (t.kind === "inbox" && t.sample) out.push(cw.drop(t.sample.split("/").pop(), cw.samples[t.sample]).label);
          } catch (e) { out.push(`threw: ${e.message}`); }
        }
      // timers last, so a batch has something staged
      for (const f of cw.graph.fns) for (const t of f.triggers) if (t.kind === "cron") out.push(cw.tick(f.name).label);
      return out;
    });
    console.log(name, fired);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `shots/${name}-1-running.png` });
    // a close-up of the busiest machine
    await page.evaluate(() => {
      const cw = window.codeworld;
      const busiest = cw.graph.fns.map((f) => [f.id, cw.graph.calls.filter((c) => c.from === f.id).length]).sort((a, b) => b[1] - a[1])[0][0];
      cw.select("machine", busiest);
    });
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `shots/${name}-1b-closeup.png` });
    await page.evaluate(() => window.codeworld.setSpeed(8));
    await page.evaluate(() => window.codeworld.idle());
    await page.waitForTimeout(300);
    await page.screenshot({ path: `shots/${name}-2-done.png` });
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("smoke ok");
