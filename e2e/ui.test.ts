// Drives the real web UI in Chromium. Run with: npm run e2e (needs `npx playwright install chromium` once).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/** Pairs of visible note names in the graph whose boxes overlap. */
const overlappingNames = (page: Page) =>
  page.$$eval("#main .graph a:not(.quiet) text", (texts) => {
    const boxes = texts.map((text) => [text.textContent, text.getBoundingClientRect()] as const);
    return boxes.flatMap(([a, x], i) =>
      boxes.slice(i + 1).flatMap(([b, y]) => (x.left < y.right && x.right > y.left && x.top < y.bottom && x.bottom > y.top ? [`${a} / ${b}`] : [])),
    );
  });

test("graph: note names never cover each other, on a desktop or a phone", async () => {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 700 }]) {
    const page = await open("", { viewport });
    await page.waitForSelector("#main .graph circle");
    assert.deepEqual(await overlappingNames(page), [], `at ${viewport.width}px`);
    assert.ok((await page.locator("#main .graph a:not(.quiet) text").count()) >= 6, `most names still fit at ${viewport.width}px`);
    await page.close();
  }
});

test("graph: zoom with buttons, wheel and drag; a drag never opens a note", async () => {
  const page = await open();
  await page.waitForSelector("#main .graph circle");
  const state = () =>
    page.evaluate(() => {
      const [a, b] = [...document.querySelectorAll("#main .graph a")].slice(0, 2).map((link) => link.querySelector("circle:last-of-type")!);
      const at = (c: Element) => [Number(c.getAttribute("cx")), Number(c.getAttribute("cy"))];
      return { gap: Math.hypot(at(a)[0] - at(b)[0], at(a)[1] - at(b)[1]), first: at(a), r: a.getAttribute("r"), zoomed: document.querySelector("#main .graph")!.classList.contains("zoomed") };
    });
  const pressed = (name: string) => page.getAttribute(`button[aria-label="${name}"]`, "aria-disabled");
  const start = await state();
  assert.equal(start.zoomed, false);
  assert.deepEqual([await pressed("Zoom out"), await pressed("Zoom in"), await pressed("Reset zoom")], ["true", "false", "true"]);

  // Keyboard: the buttons are ordinary buttons.
  await page.focus('button[aria-label="Zoom in"]');
  await page.keyboard.press("Enter");
  const once = await state();
  assert.ok(Math.abs(once.gap / start.gap - 1.6) < 0.01, "notes move apart");
  assert.equal(once.r, start.r, "circles keep their size");
  assert.equal(once.zoomed, true);
  assert.equal(await pressed("Zoom out"), "false");
  assert.deepEqual(await overlappingNames(page), []);

  // Wheel zooms around the pointer; dragging pans.
  const box = (await page.locator("#main svg.graph").boundingBox())!;
  const centre = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(centre[0], centre[1]);
  await page.mouse.wheel(0, -300);
  let wheeled = await state();
  for (let i = 0; i < 100 && wheeled.gap <= once.gap * 1.5; i++) {
    await page.waitForTimeout(20);
    wheeled = await state();
  }
  assert.ok(wheeled.gap > once.gap * 1.5, "the wheel zooms in");
  await page.mouse.down();
  await page.mouse.move(centre[0] + 120, centre[1] + 60, { steps: 4 });
  await page.mouse.up();
  const panned = await state();
  assert.ok(Math.abs(panned.first[0] - wheeled.first[0] - 120) < 2 && Math.abs(panned.first[1] - wheeled.first[1] - 60) < 2, "a drag moves the drawing with the pointer");
  assert.equal(panned.gap.toFixed(1), wheeled.gap.toFixed(1));

  // A drag that starts and ends on a note is still a drag, not a click.
  const home = page.locator("#main .graph a", { hasText: "Home" }).locator("circle");
  await home.scrollIntoViewIfNeeded();
  const spot = (await home.boundingBox())!;
  await page.mouse.move(spot.x + 4, spot.y + 4);
  await page.mouse.down();
  await page.mouse.move(spot.x + 40, spot.y + 30, { steps: 4 });
  await page.mouse.up();
  assert.equal(new URL(page.url()).hash, "", "still on the graph");

  // Tab to a note that is off screen: it is brought into view.
  while ((await pressed("Zoom in")) === "false") await page.click('button[aria-label="Zoom in"]');
  assert.equal(await pressed("Zoom in"), "true", "the zoom stops at its limit");
  for (const link of await page.locator("#main .graph a").all()) {
    await link.focus();
    const inside = await link.locator("circle").last().evaluate((circle) => {
      const [, , width, height] = (circle as SVGCircleElement).ownerSVGElement!.getAttribute("viewBox")!.split(" ").map(Number);
      const [x, y] = [Number(circle.getAttribute("cx")), Number(circle.getAttribute("cy"))];
      return x >= 0 && x <= width && y >= 0 && y <= height;
    });
    assert.equal(inside, true, "the focused note is on screen");
  }

  await page.click('button[aria-label="Reset zoom"]');
  const back = await state();
  assert.deepEqual([back.gap.toFixed(1), back.zoomed, back.first], [start.gap.toFixed(1), false, start.first]);
  await page.close();
});

test("graph: two fingers pinch it larger on a touch screen", async () => {
  const page = await open("", { viewport: { width: 375, height: 700 }, hasTouch: true });
  await page.waitForSelector("#main .graph circle");
  await page.locator("#main svg.graph").scrollIntoViewIfNeeded();
  const box = (await page.locator("#main svg.graph").boundingBox())!;
  const [x, y] = [Math.round(box.x + box.width / 2), Math.round(box.y + Math.min(box.height, 300) / 2)];
  const touch = await page.context().newCDPSession(page);
  const fingers = (spread: number) => [{ x: x - spread, y, id: 1 }, { x: x + spread, y, id: 2 }];
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: fingers(30) });
  for (const spread of [45, 60, 75, 90]) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: fingers(spread) });
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForSelector("#main .graph.zoomed");
  assert.equal(await page.getAttribute('button[aria-label="Reset zoom"]', "aria-disabled"), "false");
  assert.equal(new URL(page.url()).hash, "");
  await page.close();
});

test("the vault opening, and the server going away, are both said in words", async () => {
  const page = await browser.newPage(); // not open(): the aborted request below is meant to log an error
  let release = () => {};
  await page.route("**/api/status", async (route) => {
    await new Promise<void>((resolve) => (release = resolve));
    await route.continue();
  });
  await page.goto(BASE);
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".loading")!).visibility === "visible");
  assert.equal(await page.textContent("#main .loading"), "Opening your vault…");
  release();
  await page.waitForSelector("#main .graph circle");
  assert.equal(await page.locator(".loading").count(), 0);

  assert.equal(await page.locator("[aria-live] #list-title").count(), 1, "the result count is announced");
  await page.route("**/api/search*", (route) => route.abort());
  await page.fill("#q", "starter");
  await page.waitForFunction(() => document.querySelector("#list-title")?.textContent === "Search failed");
  assert.match((await page.textContent("#list-hint"))!, /not answering.*vaultmind serve/);
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

test("a tag in a note lists every note with it; tag: and path: narrow a search", async () => {
  const page = await open("#/note/kitchen%2FSourdough%20Starter.md");
  await page.click(".note .meta button.tag >> text=#baking");
  await page.waitForFunction(() => document.querySelector("#list-title")?.textContent === "2 notes for “tag:baking”");
  assert.equal(await page.inputValue("#q"), "tag:baking");
  assert.equal(await page.textContent("#list-hint"), "Newest first");
  assert.deepEqual((await page.locator("#list .title").allTextContents()).sort(), ["Sourdough Starter", "Weekend Loaf"]);
  assert.equal(await page.evaluate(() => document.activeElement?.closest("li")?.matches("#list li:first-child")), true, "focus moves to the list");

  await page.fill("#q", "path:reading sleep");
  await page.waitForFunction(() => document.querySelector("#list-title")?.textContent?.includes("path:reading sleep"));
  assert.ok((await page.locator("#list .where").allTextContents()).every((where) => where.startsWith("reading/")));
  await page.fill("#q", "tag:nosuchtag");
  await page.waitForFunction(() => document.querySelector("#list-hint")?.textContent === "No note has that tag or is in that folder.");
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

test("tablet: the list stays beside the note and its connections", async () => {
  const page = await open("#/note/kitchen%2FWeekend%20Loaf.md", { viewport: { width: 820, height: 700 } });
  await page.waitForSelector("#side .graph circle");
  const rect = (selector: string) => page.locator(selector).evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  const [list, main, side] = [await rect("nav.list"), await rect("#main"), await rect("#side")];
  assert.ok(list.bottom >= 699, `the list reaches the bottom of the window (${list.bottom})`);
  assert.ok(Math.abs(side.left - main.left) <= 1 && side.top >= main.bottom - 1, "connections sit under the note, in its column");
  assert.ok(list.right <= main.left + 1);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  assert.ok(Math.abs((await rect("nav.list")).top) < 1, "the list stays in view while the note scrolls");
  // Opening another note from the list starts at its top.
  await page.click("#list a >> text=Sourdough Starter");
  await page.waitForFunction(() => document.querySelector(".note h1")?.textContent === "Sourdough Starter");
  const top = (await rect(".note h1")).top;
  assert.ok(top >= 0 && top < 200, `the new note starts at the top (${top})`);
  await page.close();
});

test("phone: a note opened from the list comes to the top of the screen", async () => {
  const page = await open("", { viewport: { width: 375, height: 700 } });
  await page.waitForSelector("#main .graph circle");
  await page.click("#list a >> text=Running Log");
  await page.waitForFunction(() => document.querySelector(".note h1")?.textContent === "Running Log");
  const top = await page.locator(".note h1").evaluate((el) => el.getBoundingClientRect().top);
  assert.ok(top >= 0 && top < 700 / 3, `the heading is near the top (${top})`);
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

test("a vault with thousands of notes still opens: the graph draws the best-connected 400", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vaultmind-big-"));
  for (let i = 0; i < 1500; i++) writeFileSync(join(dir, `n${i}.md`), `# Note ${i}\n\nlinks to [[n${(i * 7) % 1500}]] and [[n${i % 10}]]`);
  const big = new Vault({ dir, dbPath: ":memory:", embed: false });
  big.sync();
  const bigServer = await startWeb(big, PORT + 1);
  try {
    const page = await browser.newPage();
    const started = Date.now();
    await page.goto(`http://127.0.0.1:${PORT + 1}/`);
    await page.waitForSelector("#main .graph circle", { timeout: 20_000 });
    assert.equal(await page.locator("#main .graph circle").count(), 400);
    assert.match(await page.textContent(".graph-head p") ?? "", /400 best-connected of 1,500 notes/);
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
    await page.close();
  } finally {
    bigServer.close();
    big.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no console errors or CSP violations along the way", () => {
  // The one expected error: the unmocked /api/ask call above returns 503 without a key, and /api/note 404.
  const unexpected = problems.filter((p) => !/status of (404|503)/.test(p));
  assert.deepEqual(unexpected, []);
});
