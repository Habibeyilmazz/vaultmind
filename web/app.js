// vaultmind web UI. No framework, no build step: this file is served as written.

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

/** Creates an element. Children are nodes or strings; strings always become text, never HTML. */
function h(tag, attrs = {}, ...children) {
  const el = tag === "svg" || attrs.svg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name !== "svg" && value !== false && value != null) el.setAttribute(name, value === true ? "" : value);
  }
  el.append(...children.flat().filter((child) => child != null && child !== false));
  return el;
}
const s = (tag, attrs = {}, ...children) => h(tag, { ...attrs, svg: true }, ...children);

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({ error: `Unexpected response (${response.status}).` }));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

const noteHref = (path) => `#/note/${encodeURIComponent(path)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const folderOf = (path) => (path.includes("/") ? path.split("/")[0] : "");
const dateText = (ms) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

const q = $("q");
const list = $("list");
const main = $("main");
const side = $("side");
let currentPath = null;
let graphCache = null;

// ---------- list column: recent notes or search results ----------

/** Search snippets mark matches with \u0001 ... \u0002; turn those into <mark> without touching innerHTML. */
function snippetNodes(snippet) {
  return snippet.split("\u0001").flatMap((part, i) => {
    if (i === 0) return [part];
    const [hit, rest = ""] = part.split("\u0002");
    return [h("mark", {}, hit), rest];
  });
}

function renderList(title, hint, items) {
  $("list-title").textContent = title;
  $("list-hint").textContent = hint;
  list.replaceChildren(
    ...items.map((item) =>
      h(
        "li",
        {},
        h(
          "a",
          { href: noteHref(item.path), "aria-current": item.path === currentPath ? "page" : null },
          h("span", { class: "title" }, item.title),
          h("span", { class: "where" }, item.where),
          item.snippet ? h("span", { class: "snippet" }, snippetNodes(item.snippet)) : null,
        ),
      ),
    ),
  );
}

async function showRecent(run = searchRun) {
  const { total, notes } = await api("/api/recent?limit=30");
  if (run !== searchRun) return; // a search started meanwhile
  renderList(
    "Recent notes",
    total === 0 ? "This vault has no Markdown notes yet. Add a .md file and it shows up here." : "",
    notes.map((note) => ({ ...note, where: `Edited ${dateText(note.modified)}${folderOf(note.path) ? ` in ${folderOf(note.path)}` : ""}` })),
  );
}

let searchRun = 0;
let lastQuery = null;
async function runSearch() {
  const query = q.value.trim();
  if (query === lastQuery) return;
  lastQuery = query;
  const run = ++searchRun;
  try {
    if (!query) return await showRecent(run);
    const result = await api(`/api/search?limit=30&q=${encodeURIComponent(query)}`);
    if (run !== searchRun) return; // a newer keystroke already answered
    renderList(
      `${plural(result.total, "note")} for “${query}”`,
      result.total === 0 ? "Nothing matches. Try fewer or different words." : `${result.mode} search, best section per note`,
      result.hits.map((hit) => {
        const section = hit.heading.startsWith(`${hit.title} > `) ? hit.heading.slice(hit.title.length + 3) : hit.heading === hit.title ? "" : hit.heading;
        return { ...hit, where: section ? `${hit.path}, ${section}` : hit.path };
      }),
    );
  } catch (error) {
    if (run === searchRun) renderList("Search failed", error.message, []);
  }
}

let debounce;
q.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(runSearch, 120);
});
$("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearTimeout(debounce);
  await runSearch();
  list.querySelector("a")?.click();
});
q.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    list.querySelector("a")?.focus();
  }
});
list.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const links = [...list.querySelectorAll("a")];
  const next = links[links.indexOf(document.activeElement) + (event.key === "ArrowDown" ? 1 : -1)];
  (next ?? (event.key === "ArrowUp" ? q : null))?.focus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !event.metaKey && !event.ctrlKey && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
    event.preventDefault();
    q.focus();
    q.select();
  }
});

function markCurrent() {
  for (const link of list.querySelectorAll("a")) {
    if (link.getAttribute("href") === (currentPath && noteHref(currentPath))) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

// ---------- link graph ----------

/**
 * Fruchterman-Reingold layout, run to completion before drawing (no animation, same picture every time).
 * shortcut: O(n^2) per step with a capped step count; fine for a few thousand notes, then use a quadtree.
 */
function layout(nodes, edges, width, height) {
  const n = nodes.length;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  nodes.forEach((node, i) => {
    const radius = Math.sqrt((i + 0.5) / n) * Math.min(width, height) * 0.42;
    node.x = width / 2 + radius * Math.cos(i * 2.39996);
    node.y = height / 2 + radius * Math.sin(i * 2.39996);
  });
  const k = Math.sqrt((width * height) / Math.max(n, 1)) * 0.72;
  const steps = Math.max(40, Math.min(400, Math.floor(3e7 / (n * n + 1))));
  const pad = 46;
  for (let step = 0; step < steps; step++) {
    for (const node of nodes) node.dx = node.dy = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = a.x - b.x || 0.01;
        const dy = a.y - b.y || 0.01;
        const force = (k * k) / (dx * dx + dy * dy);
        a.dx += dx * force;
        a.dy += dy * force;
        b.dx -= dx * force;
        b.dy -= dy * force;
      }
    }
    for (const edge of edges) {
      const a = byId.get(edge.source);
      const b = byId.get(edge.target);
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const force = Math.hypot(dx, dy) / k;
      a.dx -= dx * force;
      a.dy -= dy * force;
      b.dx += dx * force;
      b.dy += dy * force;
    }
    const heat = (1 - step / steps) * k * 0.5;
    for (const node of nodes) {
      // A little gravity keeps unlinked notes from drifting to the corners.
      node.dx += (width / 2 - node.x) * 0.06;
      node.dy += (height / 2 - node.y) * 0.06;
      const length = Math.hypot(node.dx, node.dy) || 1;
      node.x = Math.min(width - pad, Math.max(pad, node.x + (node.dx / length) * Math.min(length, heat)));
      node.y = Math.min(height - pad, Math.max(pad - 22, node.y + (node.dy / length) * Math.min(length, heat)));
    }
  }
  // Stretch the result to the frame, leaving room for the labels under the circles.
  const fit = (value, min, max, from, to) => (max - min < 1 ? (from + to) / 2 : from + ((value - min) / (max - min)) * (to - from));
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  for (const node of nodes) {
    node.x = fit(node.x, Math.min(...xs), Math.max(...xs), 72, width - 72);
    node.y = fit(node.y, Math.min(...ys), Math.max(...ys), 26, height - 48);
  }
}

/**
 * A colour for each of the six largest top-level folders; everything else shares grey.
 * Computed over the whole vault so the small and the large graph agree.
 */
function folderPalette(nodes) {
  const sizes = new Map();
  for (const node of nodes) sizes.set(folderOf(node.path), (sizes.get(folderOf(node.path)) ?? 0) + 1);
  const named = [...sizes.keys()].filter(Boolean).sort((a, b) => sizes.get(b) - sizes.get(a) || a.localeCompare(b)).slice(0, 6).sort();
  const colour = (path) => `f${named.indexOf(folderOf(path)) + 1}`;
  const dot = (cls) => s("svg", { viewBox: "0 0 10 10", "aria-hidden": "true" }, s("circle", { cx: 5, cy: 5, r: 5, class: cls }));
  const legend = h(
    "ul",
    { class: "legend", "aria-label": "Folder colours" },
    named.map((folder, i) => h("li", {}, dot(`f${i + 1}`), folder)),
    named.length < sizes.size && h("li", {}, dot("f0"), named.length ? "everything else" : "notes"),
  );
  return { colour, legend };
}

function drawGraph(graph, { width, height, focusId, label, colour }) {
  const nodes = graph.nodes.map((node) => ({ ...node }));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  layout(nodes, edges, width, height);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const neighbours = new Map(nodes.map((node) => [node.id, new Set([node.id])]));
  for (const edge of edges) {
    neighbours.get(edge.source).add(edge.target);
    neighbours.get(edge.target).add(edge.source);
  }
  const quiet = nodes.length > 60; // too many labels to read: show them on hover only
  const shrink = Math.max(0.35, Math.min(1, Math.sqrt(150 / nodes.length))); // smaller circles in crowded graphs
  const radius = (degree) => (6 + Math.min(Math.sqrt(degree) * 2.6, 12)) * shrink;

  const lines = edges.map((edge) => {
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    return Object.assign(s("line", { x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1) }), { edge });
  });
  const svg = s("svg", { class: quiet ? "graph dense" : "graph", viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": label }, lines);
  const anchors = nodes.map((node) => {
    const degree = neighbours.get(node.id).size - 1;
    const anchor = s(
      "a",
      { href: noteHref(node.path), class: [node.id === focusId ? "focus" : "", quiet && node.id !== focusId ? "quiet" : ""].join(" ").trim() || null },
      s("title", {}, `${node.title} (${plural(degree, "link")})`),
      node.id === focusId && s("circle", { cx: node.x.toFixed(1), cy: node.y.toFixed(1), r: (radius(degree) + 7).toFixed(1), class: "halo" }),
      s("circle", { cx: node.x.toFixed(1), cy: node.y.toFixed(1), r: radius(degree).toFixed(1), class: colour(node.path) }),
      // The focused note needs no label: its title is the page heading.
      node.id !== focusId &&
        s("text", { x: node.x.toFixed(1), y: (node.y + radius(degree) + 20).toFixed(1) }, node.title.length > 26 ? `${node.title.slice(0, 25)}…` : node.title),
    );
    const near = neighbours.get(node.id);
    const setHover = (on) => {
      svg.classList.toggle("hovering", on);
      anchors.forEach((other, i) => other.classList.toggle("near", on && near.has(nodes[i].id)));
      lines.forEach((line) => line.classList.toggle("near", on && (line.edge.source === node.id || line.edge.target === node.id)));
    };
    anchor.addEventListener("pointerenter", () => setHover(true));
    anchor.addEventListener("pointerleave", () => setHover(false));
    anchor.addEventListener("focus", () => setHover(true));
    anchor.addEventListener("blur", () => setHover(false));
    return anchor;
  });
  svg.append(...anchors);
  return svg;
}

// Bumped on every navigation, so a slow response for an older view is dropped instead of drawn over the newer one.
let view = 0;

async function showGraph() {
  const mine = ++view;
  const graph = await api("/api/graph");
  if (mine !== view) return;
  graphCache = graph;
  currentPath = null;
  markCurrent();
  side.hidden = true;
  document.title = "vaultmind";
  if (graph.nodes.length === 0) {
    main.replaceChildren(h("p", { class: "problem" }, "This vault has no Markdown notes yet. Add a .md file, then reload."));
    return;
  }
  const { colour, legend } = folderPalette(graph.nodes);
  const slot = h("div", { class: "graph" });
  main.replaceChildren(
    h(
      "div",
      { class: "graph-view" },
      h(
        "div",
        { class: "graph-head" },
        h("h1", {}, "Link graph"),
        h("p", {}, `${plural(graph.nodes.length, "note")}, ${plural(graph.edges.length, "link")}. Select a note to read it.`),
      ),
      slot,
      legend,
    ),
  );
  // Lay the graph out for the space it actually gets, so labels keep a readable size.
  const box = slot.getBoundingClientRect();
  slot.replaceWith(
    drawGraph(graph, {
      width: Math.max(360, Math.round(box.width)),
      height: Math.max(320, Math.round(box.height)),
      colour,
      label: "Link graph of the vault. Each circle is a note; select one to open it.",
    }),
  );
}

let resizing;
window.addEventListener("resize", () => {
  clearTimeout(resizing);
  resizing = setTimeout(() => main.querySelector(".graph-view") && showGraph(), 200);
});

// ---------- note view ----------

async function showNote(path) {
  const mine = ++view;
  let note;
  let related;
  try {
    const loaded = await Promise.all([
      api(`/api/note?path=${encodeURIComponent(path)}`),
      api(`/api/related?path=${encodeURIComponent(path)}`),
      api("/api/graph"),
    ]);
    if (mine !== view) return;
    [note, { related }, graphCache] = loaded;
  } catch (error) {
    if (mine !== view) return;
    currentPath = null;
    side.hidden = true;
    main.replaceChildren(h("p", { class: "problem" }, error.message, " ", h("a", { href: "#/" }, "Back to the link graph")));
    return;
  }
  currentPath = note.path;
  markCurrent();
  document.title = `${note.title} - vaultmind`;

  const body = h("div", { class: "body" });
  body.innerHTML = note.html; // rendered and escaped on the server; the page's CSP blocks scripts regardless
  const first = body.firstElementChild;
  if (first?.tagName === "H1" && first.textContent.trim() === note.title) first.remove();
  main.replaceChildren(
    h(
      "article",
      { class: "note" },
      h("h1", {}, note.title),
      h(
        "p",
        { class: "meta" },
        h("span", {}, note.path),
        h("span", {}, `Edited ${dateText(note.modified)}`),
        note.tags.map((tag) => h("span", { class: "tag" }, `#${tag}`)),
      ),
      body,
    ),
  );
  main.scrollTop = 0;

  // Connections: this note, its direct neighbours, and the links among them.
  const self = graphCache.nodes.find((node) => node.path === note.path);
  const near = new Set([self?.id]);
  for (const edge of graphCache.edges) {
    if (edge.source === self?.id) near.add(edge.target);
    if (edge.target === self?.id) near.add(edge.source);
  }
  const local = { nodes: graphCache.nodes.filter((node) => near.has(node.id)), edges: graphCache.edges };
  const parts = [
    h("h2", {}, near.size > 1 ? `Linked notes (${near.size - 1})` : "No links yet"),
    near.size > 1 &&
      drawGraph(local, {
        width: 340,
        height: 300,
        focusId: self.id,
        colour: folderPalette(graphCache.nodes).colour,
        label: "This note and the notes it is linked with",
      }),
    h("h2", {}, "Related"),
    related.length
      ? h("ul", {}, related.map((item) => h("li", {}, h("a", { href: noteHref(item.path) }, item.title), h("span", { class: "why" }, item.reasons.join(", ")))))
      : h("p", { class: "hint" }, "Nothing related yet. Links, shared tags and similar wording all count."),
    note.unresolved.length > 0 && h("h2", {}, "Links to notes that do not exist"),
    note.unresolved.length > 0 && h("ul", {}, note.unresolved.map((name) => h("li", {}, h("span", { class: "missing" }, name)))),
  ];
  side.replaceChildren(...parts.filter(Boolean));
  side.hidden = false;
}

// ---------- ask ----------

async function showAnswer(question) {
  const mine = ++view;
  currentPath = null;
  markCurrent();
  side.hidden = true;
  const body = h("div", { class: "body", "aria-live": "polite" }, h("p", {}, "Reading your notes…"));
  main.replaceChildren(h("article", { class: "answer" }, h("h1", {}, question), body));
  try {
    const result = await api("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) });
    if (mine !== view) return;
    const byNumber = new Map(result.sources.map((source) => [String(source.n), source]));
    const paragraphs = result.answer.split(/\n{2,}/).map((paragraph) =>
      h(
        "p",
        {},
        paragraph.split(/(\[\d+\])/).map((part) => {
          const source = byNumber.get(part.slice(1, -1));
          return /^\[\d+\]$/.test(part) && source ? h("a", { class: "cite", href: noteHref(source.path), title: source.title }, part) : part;
        }),
      ),
    );
    body.replaceChildren(
      ...paragraphs,
      result.sources.length
        ? h(
            "section",
            { class: "sources" },
            h("h2", {}, "Sources"),
            h(
              "ol",
              {},
              result.sources.map((source) =>
                h(
                  "li",
                  {},
                  h("a", { href: noteHref(source.path) }, source.title),
                  source.heading ? ` (${source.heading.split(" > ").pop()})` : "",
                  source.quotes.map((quote) => h("q", {}, quote.trim())),
                ),
              ),
            ),
          )
        : null,
      h("p", { class: "model" }, `Answered by ${result.model} from the note sections above.`),
    );
  } catch (error) {
    if (mine === view) body.replaceChildren(h("p", {}, error.message));
  }
}

$("ask").addEventListener("click", () => {
  const question = q.value.trim();
  if (question) showAnswer(question);
  else q.focus();
});

// ---------- start ----------

function route() {
  const match = /^#\/note\/(.+)$/.exec(location.hash);
  let path = null;
  try {
    path = match && decodeURIComponent(match[1]);
  } catch {
    // malformed escape in the address bar: fall back to the graph
  }
  const done = path ? showNote(path) : showGraph();
  done.then(() => {
    if (document.activeElement !== q) main.focus({ preventScroll: true });
  });
}
window.addEventListener("hashchange", route);

try {
  const status = await api("/api/status");
  $("status").textContent = `${status.vault}: ${plural(status.notes, "note")}, ${status.semantic ? "hybrid" : "keyword"} search`;
  $("ask").hidden = !status.ask;
  if (status.ask) q.placeholder = "Search your notes, or ask a question";
  await showRecent();
  lastQuery = "";
  route();
} catch (error) {
  main.replaceChildren(h("p", { class: "problem" }, `vaultmind could not load: ${error.message}`));
}
