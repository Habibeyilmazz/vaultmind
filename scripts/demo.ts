// Records docs/demo.gif from a running server (needs ffmpeg):
//   node src/cli.ts serve --vault examples/vault --port 4100 &
//   node scripts/demo.ts [http://127.0.0.1:4100]
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:4100";
const dir = mkdtempSync(join(tmpdir(), "vm-demo-"));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 680 }, colorScheme: "light" });
await page.goto(base);
await page.waitForSelector(".graph circle");
let n = 0;
const frame = async (count = 1) => {
  for (let i = 0; i < count; i++) await page.screenshot({ path: join(dir, `f${String(n++).padStart(4, "0")}.png`) });
};
await frame(8);
await page.click("#q");
for (const ch of "when should the garden be watered") {
  await page.keyboard.type(ch);
  await frame();
}
await page.waitForSelector("#list mark");
await frame(10);
await page.click("#list a");
await page.waitForSelector("#side .graph");
await page.mouse.move(900, 640);
await frame(14);
await browser.close();
// 6 frames per second, palette-optimised
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "6", "-i", join(dir, "f%04d.png"),
  "-vf", "scale=900:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", "docs/demo.gif"]);
rmSync(dir, { recursive: true });
console.log("Wrote docs/demo.gif");
