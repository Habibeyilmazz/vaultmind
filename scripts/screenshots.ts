// Regenerates the README screenshots from a running server:
//   node src/cli.ts serve --vault examples/vault &
//   node scripts/screenshots.ts [http://127.0.0.1:4100] [outDir]
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:4100";
const out = process.argv[3] ?? "docs/screenshots";
const browser = await chromium.launch();
const errors: string[] = [];

for (const scheme of ["light", "dark"] as const) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.waitForSelector(".graph circle");
  await page.screenshot({ path: `${out}/graph-${scheme}.png` });

  await page.fill("#q", "why is my coffee sour");
  await page.waitForSelector("#list mark");
  await page.click("#list a");
  await page.waitForSelector("#side .graph");
  await page.screenshot({ path: `${out}/search-${scheme}.png` });
  await page.close();
}

const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await phone.goto(`${base}/#/note/${encodeURIComponent("kitchen/Weekend Loaf.md")}`);
await phone.waitForSelector(".note h1");
await phone.screenshot({ path: `${out}/note-phone.png`, fullPage: true });
await browser.close();

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Wrote screenshots to ${out}`);
