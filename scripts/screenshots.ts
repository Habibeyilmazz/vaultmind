// Regenerates the README screenshots from a running server:
//   node src/cli.ts index --vault examples/vault && node src/cli.ts serve --vault examples/vault &
//   node scripts/screenshots.ts [http://127.0.0.1:4100] [outDir]
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:4100";
const out = process.argv[3] ?? "docs/screenshots";
const browser = await chromium.launch();
const errors: string[] = [];

const open = async (colorScheme: "light" | "dark") => {
  const page = await browser.newPage({ viewport: { width: 1360, height: 850 }, deviceScaleFactor: 2, colorScheme });
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.waitForSelector(".graph circle");
  return page;
};

const light = await open("light");
await light.screenshot({ path: `${out}/graph.png` });

const dark = await open("dark");
await dark.fill("#q", "when should the garden be watered");
await dark.waitForSelector("#list mark");
await dark.click("#list a");
await dark.waitForSelector("#side .graph");
await dark.mouse.move(700, 600);
await dark.screenshot({ path: `${out}/note.png` });

const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "light" });
phone.on("pageerror", (error) => errors.push(error.message));
await phone.goto(base);
await phone.waitForSelector(".graph circle");
await phone.fill("#q", "sourdough");
await phone.waitForSelector("#list mark");
await phone.click("#list a");
await phone.waitForSelector("#side .graph");
await phone.screenshot({ path: `${out}/phone.png` });
await browser.close();

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Wrote screenshots to ${out}`);
