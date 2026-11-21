// Drives the real web UI in Chromium. Run with: npm run e2e (needs `npx playwright install chromium` once).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import { Vault } from "../src/vault.ts";
import { startWeb } from "../src/web.ts";
import { tempVault } from "../test/helpers.ts";

const PORT = Number(process.env.E2E_PORT ?? 4107);
const BASE = `http://127.0.0.1:${PORT}`;
let server: Server;
let browser: Browser;
let vault: Vault;
const problems: string[] = [];

async function open(hash = "", options: Parameters<Browser["newPage"]>[0] = {}): Promise<Page> {
  const page = await browser.newPage(options);
  page.on("console", (message) => message.type() === "error" && problems.push(message.text()));
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(`${BASE}/${hash}`);
  return page;
}

before(async () => {
  const dir = tempVault();
  writeFileSync(
    join(dir, "Hostile.md"),
    '# Hostile\n\n<script>window.pwned = 1</script>\n\n<img src="x" onerror="window.pwned = 2">\n\n[click me](javascript:window.pwned=3)\n\nstill readable',
  );
  vault = new Vault({ dir, dbPath: ":memory:", embed: false });
  vault.sync();
  server = await startWeb(vault, PORT);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});

test("home shows the whole link graph and recent notes", async () => {
  const page = await open();
  await page.waitForSelector("#main .graph circle");
  assert.equal(await page.textContent("#status"), `${vault.dir.split("/").pop()}: 14 notes, keyword search`);
  assert.equal(await page.locator("#main .graph circle").count(), 14);
  assert.deepEqual(await page.locator(".legend li").allTextContents(), ["health", "kitchen", "projects", "reading", "travel", "everything else"]);
  assert.equal(await page.locator("#list li").count(), 14);
  assert.equal(await page.isHidden("#ask"), true, "Ask stays hidden without an API key");
  // Every circle is inside the drawing.
  const outside = await page.$$eval("#main .graph circle", (circles) => {
    const [, , width, height] = (circles[0] as SVGCircleElement).ownerSVGElement!.getAttribute("viewBox")!.split(" ").map(Number);
    return circles.filter((c) => +c.getAttribute("cx")! < 0 || +c.getAttribute("cx")! > width || +c.getAttribute("cy")! < 0 || +c.getAttribute("cy")! > height).length;
  });
  assert.equal(outside, 0);
  await page.locator("#main .graph a", { hasText: "Weather Station" }).locator("text").click();
  await page.waitForSelector(".note h1");
  assert.equal(await page.textContent(".note h1"), "Weather Station");
  await page.close();
});

test("search as you type, open with Enter, follow links", async () => {
  const page = await open();
  await page.keyboard.press("/");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "q");
  await page.keyboard.type("feeding sched");
  await page.waitForSelector("#list mark");
  assert.match((await page.textContent("#list-title"))!, /notes? for “feeding sched”/);
  assert.equal(await page.textContent("#list li:first-child .title"), "Sourdough Starter");
  assert.match((await page.textContent("#list li:first-child .where"))!, /Feeding schedule/);

  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.closest("li")?.matches("#list li:first-child")), true);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".note h1");
  assert.equal(await page.textContent(".note h1"), "Sourdough Starter");
  assert.equal(await page.locator(".note h1").count(), 1, "the note's own H1 is not repeated");
  assert.equal(await page.getAttribute("#list li:first-child a", "aria-current"), "page");
  assert.match(await page.title(), /^Sourdough Starter/);

  assert.match((await page.textContent("#side"))!, /Linked notes \(3\)/);
  assert.match((await page.textContent("#side li:first-child"))!, /Weekend Loaf.*shares #baking/s);
  assert.equal(await page.locator("#side .graph circle:not(.halo)").count(), 4);
  assert.equal(await page.locator("#side .graph .halo").count(), 1, "the note being read is marked");

  await page.click(".body a.wikilink >> text=Weekend Loaf");
  await page.waitForFunction(() => document.querySelector(".note h1")?.textContent === "Weekend Loaf");
  assert.match(page.url(), /#\/note\/kitchen%2FWeekend%20Loaf\.md$/);
  assert.equal(await page.locator(".body table tr").count(), 6);
  await page.goBack();
  await page.waitForFunction(() => document.querySelector(".note h1")?.textContent === "Sourdough Starter");

  await page.fill("#q", "zzzqqq");
  await page.waitForFunction(() => document.querySelector("#list-hint")?.textContent?.startsWith("Nothing matches"));
  await page.fill("#q", "");
  await page.waitForFunction(() => document.querySelector("#list-title")?.textContent === "Recent notes");
  await page.close();
});

test("missing links and unknown notes are explained", async () => {
  const page = await open("#/note/Inbox.md");
  await page.waitForSelector(".note h1");
  assert.equal(await page.textContent(".body .missing"), "Fermentation Science");
  assert.match((await page.textContent("#side"))!, /Links to notes that do not exist\s*Fermentation Science/);
  assert.match((await page.textContent(".body pre"))!, /\[\[Not A Link\]\]/);

  await page.goto(`${BASE}/#/note/Nope.md`);
  await page.waitForSelector(".problem");
  assert.match((await page.textContent(".problem"))!, /No such note/);
  assert.equal(await page.isHidden("#side"), true);
  await page.close();
});

test("a hostile note cannot run script", async () => {
  const page = await open("#/note/Hostile.md");
  await page.waitForSelector(".note h1");
  assert.match((await page.textContent(".body"))!, /<script>window\.pwned = 1<\/script>/, "raw HTML is shown as text");
  assert.match((await page.textContent(".body"))!, /still readable/);
  assert.equal(await page.locator(".body img, .body script, .body a[href^='javascript']").count(), 0);
  assert.equal(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned), undefined);
  await page.close();
});

test("ask: answer with numbered citations (API mocked in the browser)", async () => {
  const page = await browser.newPage();
  page.on("pageerror", (error) => problems.push(error.message));
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), ask: true } });
  });
  await page.route("**/api/ask", (route) =>
    route.fulfill({
      json: {
        answer: "Feed it once a day at room temperature. [1]\n\nIn the fridge, once a week is enough. [1]",
        model: "mock-model",
        sources: [{ n: 1, path: "kitchen/Sourdough Starter.md", title: "Sourdough Starter", heading: "Sourdough Starter > Feeding schedule", line: 12, quotes: ["Feed once a day at room temperature"] }],
      },
    }),
  );
  await page.goto(BASE);
  await page.waitForSelector("#ask:not([hidden])");
  await page.fill("#q", "How often do I feed the starter?");
  await page.click("#ask");
  await page.waitForSelector(".answer .cite");
  assert.equal(await page.textContent(".answer h1"), "How often do I feed the starter?");
  assert.equal(await page.locator(".answer .body > p").count(), 3);
  assert.equal(await page.getAttribute(".answer .cite", "href"), "#/note/kitchen%2FSourdough%20Starter.md");
  assert.match((await page.textContent(".sources"))!, /Sourdough Starter \(Feeding schedule\)Feed once a day/);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, "ask-mocked.png") });

  await page.unroute("**/api/ask");
  await page.click("#ask");
  await page.waitForFunction(() => document.querySelector(".answer .body")?.textContent?.includes("ANTHROPIC_API_KEY"));
  await page.close();
});

test("phone layout has no sideways scrolling", async () => {
  const page = await open("#/note/kitchen%2FWeekend%20Loaf.md", { viewport: { width: 375, height: 700 } });
  // Elements that stick out past the right edge of the screen.
  const overflowing = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
        .map((el) => `${el.tagName}.${el.getAttribute("class") ?? ""}`)
        .concat(document.documentElement.scrollWidth > window.innerWidth ? [`page is ${document.documentElement.scrollWidth}px wide`] : []),
    );
  await page.waitForSelector("#side .graph");
  assert.deepEqual(await overflowing(), []);
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector("#main .graph circle");
  assert.deepEqual(await overflowing(), []);
  await page.close();
});

test("no console errors or CSP violations along the way", () => {
  // The one expected error: the unmocked /api/ask call above returns 503 without a key, and /api/note 404.
  const unexpected = problems.filter((p) => !/status of (404|503)/.test(p));
  assert.deepEqual(unexpected, []);
});
