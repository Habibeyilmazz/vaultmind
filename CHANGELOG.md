# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Performance, accessibility and maintainability pass, round 2 (2026-11-22)

Checked the previous round's gaps first. One was a real bug: the file watcher ignored every dot-folder, including `.obsidian/app.json`, so a changed "Excluded files" setting only applied at the next rescan.

- Fixed: the watcher now reacts to `.obsidian/app.json` (and only that file in a dot-folder), so the setting applies about half a second after saving. Test; it fails without the fix (the test waits out the rescan `watch()` makes on start, so only the watcher can notice).
- Re-measured, nothing worth changing: `search` start-up 46 ms; web assets 28 KB `app.js`, 13 KB `style.css`, 2 KB HTML (unchanged); all six runtime dependencies are imported by `src`, nothing to delete. Lighthouse was not run; the last round's axe-core results stand and no markup changed.
- Not done: Obsidian itself, Windows by eye, Claude Desktop, live `ask`. The commit trailer names the model that wrote each commit.

### Obsidian's Excluded files (2026-11-22)

Used the CLI on a copy of the example vault with a `Templates/` folder, as most Obsidian vaults have: template text (`{{title}}`, placeholder checklists) showed up in search results, and Obsidian's own setting for hiding such folders was ignored. The previous round's gaps were checked: CJK per-character matching is a documented trade-off (recall over precision), not a bug; Windows by eye, Claude Desktop and live `ask` still cannot be done from here.

- Added: notes matched by Obsidian's "Excluded files" setting (`userIgnoreFilters` in `.obsidian/app.json`) are left out of the index. Plain entries are path prefixes, `/.../` entries are regular expressions; an invalid regular expression, a non-string entry or unreadable settings exclude nothing. Notes already indexed leave the index on the next sync and come back when the setting is cleared. `index` prints the entries it applied.
- Added: `write_note` refuses a path the setting covers, with an error that says why (the note would never be searchable).
- Tests: 2 new (69 in all). Tried by hand with `index` and `search` on a synthetic vault.
- Not done: no flag to ignore the setting; a changed setting is not picked up by the file watcher (it skips `.obsidian`), only by the next rescan; Obsidian's exact matching rules were not checked against Obsidian itself (written from how the setting is documented and stored).

### Launch pass (2026-11-22)

Checked README, CONTRIBUTING, issue templates, repo description and topics against the code: all present and accurate, so no change there. Only the open bug from last round was worth fixing.

- Fixed: Chinese and Japanese text without spaces was not searchable (`日本語` did not find `日本語のノート`). Han, Hiragana and Katakana characters are now indexed one by one and a query term becomes a phrase of characters; excerpts are rejoined. Schema version 3, so existing indexes rebuild themselves once on the next `index`. Not word segmentation: `京` also matches inside `東京`. Hangul already worked (it uses spaces). Test; it fails without the fix.
- Still not done: Windows by eye, Claude Desktop, `ask` against the live API.

### Reliability pass (2026-11-22)

Tried to break the tool on a synthetic vault: empty note, broken frontmatter, BOM, CRLF, invalid UTF-8, a 3 MB note without spaces, nonsense dates and wikilinks, CJK names; then odd CLI flags, an unreachable model hub, a missing vault, 14 odd web API URLs (including a 200 KB query) and 24 odd MCP calls. Nothing crashed or returned a 5xx; two real bugs came out of it, plus the last round's Windows gap.

- Fixed: `write_note` now refuses Windows reserved device names (`CON`, `NUL`, `COM1`, `LPT9`, ..., with or without an extension) and folder or note names ending in a dot or space. Test; it fails without the fix. Still not tried on an actual Windows machine.
- Fixed: `vaultmind search --json` left the internal highlight markers (`\u0001`, `\u0002`) in each hit's `snippet`. They are now removed from the JSON; the terminal and web UI still use them. New `test/cli.test.ts` (the first test that runs the CLI itself); it fails without the fix.
- Known, not fixed: search does not match inside a run of Chinese or Japanese text written without spaces (`日本語` does not find a note titled `日本語のノート`), because the SQLite tokenizer treats such a run as one word. Needs a different tokenizer or n-gram indexing and an index rebuild; not done.
- Checked, no change: an offline or unknown embedding model falls back to keyword search with a message; the end-to-end browser journey already exists in `e2e/`. Not tried from Claude Desktop; `ask` still untested against the live API; the symlink test is still skipped on Windows.

### Let Claude save notes (2026-11-22)

Used the product as a newcomer would, from the CLI and as an MCP memory. Search, filters, the web UI and the four tools did their jobs; the gap that hurt most was that "use the vault as memory" only went one way. Claude could look things up but not remember anything new, and in Claude Desktop (no file tools of its own) there was no way at all. The previous round's reported gaps were checked: none is a bug (the `/security-review` skill still cannot run from this session's folder, `ask` still has no live key, nobody here can look at Windows by eye).

- Added: `vaultmind mcp --allow-write` registers a fifth tool, `write_note` (`path`, `content`, `append`). It creates a note, creating folders as needed, or with `append: true` adds a new paragraph to the end of one (creating it if missing). It never overwrites, renames or deletes: creating fails when the file exists (`wx`, so also when it appears in between). The note is indexed before the tool returns, so the next `search_notes` finds it; embedding follows in the background.
- Refused, with an error the model can act on: absolute paths, drive letters, `..`, empty parts, dot-folders (`.obsidian`, `.git`), `node_modules`, the characters `<>:"|?*#^[]` and control characters, paths through a symbolic link, a folder in the way, and notes that would pass 5 MB (the indexer skips those). `.md` is added when missing.
- Without the flag nothing changes: the server lists the four read-only tools, as a test checks. `--allow-write` with any other command is an error.
- Tests: 65 unit/MCP tests (6 new: path rules, create and no-overwrite, append separators, symlinks, and the tool end to end over stdio with `search_notes` finding the note at once). Removing the symlink check makes a test fail.
- Not done: Windows reserved device names (`CON`, `NUL`, ...) are not refused and what Windows does with them was not tried; the symlink test is skipped on Windows; not tried from Claude Desktop itself.

### Security pass (2026-11-22)

Reviewed the whole repository by hand: the web server, MCP tools, Markdown rendering, SQL and FTS query building, file walking, `ask`, CI workflows, git history and dependencies. Probed a running `serve` on port 4101 with curl.

- Fixed: `--db` pointed at a SQLite file that another program owns (any file whose schema version is not vaultmind's) dropped that file's `notes`, `links`, `tags` and `meta` tables while rebuilding the index. vaultmind now marks its index files (`PRAGMA application_id`) and refuses to rebuild a database that has tables but is neither marked nor an older vaultmind index. Older vaultmind indexes are still rebuilt as before. Test; it fails without the fix.
- Checked, no change: requests with Host `evil.com`, `127.0.0.1.evil.com`, `localhost@evil.com` are refused (403/400); `/api/ask` refuses cross-site and `Origin: null` posts, non-JSON bodies, and bodies over 16 KB; `OPTIONS` gets 405 with no CORS headers; `../` in paths and `?path=` reach nothing outside the index; the CSP is sent. Every SQL statement is parameterised and FTS input is reduced to quoted words. Symlinks in the vault are not followed. Rendered notes escape raw HTML and allow only http(s), mailto and note links. MCP tools are read-only with strict zod schemas.
- Checked, no change: `npm audit` reports 0 vulnerabilities; both workflows use `contents: read`, actions pinned to commit SHAs, `persist-credentials: false`. Git history has no secrets, `.env` or index files, and only the noreply identity.
- The `/security-review` skill could not run here: it needs the session to start inside the git repository, and this session started in a different folder.
- Still not done: `ask` against the live API; the web UI looked at by eye on Windows; the per-note graph measured on a 10,000-note vault.

### Design and UX pass (2026-11-22)

Looked at the running web UI in Chromium at 1360, 900 and 390 px, light and dark: home graph, search, empty results, a note, a missing note, keyboard focus, touch target sizes. The layout, type, colours, focus rings and reduced-motion handling held up; nothing was restyled. What was wrong was state, plus two items from the last round's gaps.

- Fixed: opening a note downloaded the whole-vault link graph to draw its few neighbours. `/api/graph?path=<note>` now returns only the note, the notes it links with and the links among them, plus per-folder note counts so the colours match the big graph (`folders` is also on the whole graph now). Test. Not re-measured on the 10,000-note vault.
- Fixed: the flaky "watched vault re-indexes on its own" test was a real bug. On macOS, changes in the moment after `fs.watch()` returns are not reported (longer on a busy machine), so a note written right after `serve` or `mcp` started stayed unfindable for up to 30 s. The watcher now rescans once about a second after it starts. Before: 15 of 24 parallel runs of that test failed; after: 0 of 24, and 5 sequential full runs passed.
- Fixed: a filter-only search (`tag:baking`) switched the header from "hybrid search" to "keyword search" even with the model loaded, because a filter listing always reports keyword mode. Browser test.
- Fixed: opening a note that does not exist left the previous note highlighted in the list and in the tab title. Browser test.
- Changed: `vaultmind search` in a terminal prints titles in bold and locations dimmed, and honours `NO_COLOR`. Piped output is unchanged.
- Checked, no change: README screenshots regenerated with `scripts/screenshots.ts` came out byte-identical (nothing visual changed), so the files did not change. Tag buttons and the related-notes links are 20-21 px tall at 390 px, under 24 px but spaced far enough apart for WCAG 2.2's target-size exception. The README has the demo GIF at the top; no separate hero image was made.
- Still not done: `ask` against the live API; the web UI looked at by eye on Windows.

### First-run review (2026-11-22)

Cloned the repository fresh into a separate folder and followed the README quickstart word for word (macOS, Node 22.23, npm 12.2): `npm install` (3 s, the install-script warning appears as the README says), `npm run build`, `index` (model downloaded, 44/44 sections embedded, 4.2 s), `search`, `serve` on 4100 (looked at in Chromium: home graph, search, note view, no console errors), `mcp` over stdio (initialize, tools/list, search_notes), and `ask` without a key (clear error, exit 1).

- Fixed: every search result showed the same excerpt, taken from whichever section matched first (on the quickstart query, all six hits showed the Home note's list of areas). This came in with the performance pass's "excerpt for the returned page only". node:sqlite binds JS numbers as REAL, and FTS5 (SQLite 3.51) then drops `rowid = ?` and returns the first match. The query now casts to INTEGER. Affected the CLI, the web UI and nothing else (MCP returns full section text). The new test fails without the fix.
- Fixed: `index` and `/api/status` said 31 links where the web UI's graph said 30 for the same vault. Two wikilinks from one note to the same note (`[[Levain]]` and `[[Sourdough Starter]]`) counted twice. Links are now counted the way the graph counts them: one per pair of notes, self-links left out. Test.
- Reviewed, no change: `ask.ts` request shape (model, effort, citations, server-side fallback) matches the current API documentation; MCP tool handlers; web server Host and Origin checks; the indexer.
- Seen once, not reproduced: the "watched vault re-indexes on its own" test failed one full `npm test` run out of ten on this machine while other jobs were running. The next nine runs passed. No cause found.
- Still not done: `ask` against the live API (no key used in this run); the web UI looked at by eye on Windows; the per-note graph endpoint (opening a note still downloads the whole graph).

### Performance and accessibility pass (2026-11-22)

Measured on a generated vault of 10,000 notes (50,000 sections, 150,000 links, 78 MB of Markdown; Apple M3 Pro, keyword mode) before changing anything.

- Fixed: the web UI's home page (the link graph) did not finish drawing within two minutes on 10,000 notes, because the layout is quadratic. It now draws the 400 best-connected notes and says so ("The 400 best-connected of 10,300 notes. Search for the others."); the page is ready in 0.3 s. Small vaults are unchanged. Browser test with 1,500 notes.
- Fixed: opening a note in the web UI built the whole-vault link resolver once per wikilink: 260 ms, now 28 ms.
- Fixed: search computed its highlighted excerpt for every matching section before ranking. A query matching every section took 590 ms through the web API, now 250 ms (the excerpt costs about 7 ms a row and is now made only for the 20 rows returned); related notes 600 ms, now 90 ms. Queries that match few sections were already fast.
- Changed: `vaultmind search` and `index` no longer load the MCP and Anthropic SDKs: 150 ms, now 50 ms (bare `node` is 37 ms). `mcp`, `serve` and `ask` load them as before (`VERSION` moved to `src/vault.ts`).
- Changed: CI runs the browser tests on Windows as well as Linux. The 15 browser tests passed on Windows (GitHub runner, Chromium), so the web UI has been exercised there, though nobody has looked at it by eye.
- Measured, no change needed: index of 10,000 notes 3.1 s, re-index with nothing changed 0.1 s (0.28 s with process start), index file 176 MB keyword-only, `tag:` filter query 35 ms. axe-core 4 (WCAG 2.2 AA and best practices) found no violation on the home, note and search views, light and dark, at 1360 and 390 px. The web assets are 28 KB (app.js) and 13 KB (style.css) uncompressed and the server does not compress them; on localhost that does not matter.
- Known, not fixed: opening a note downloads the whole-vault graph (5 MB on 10,000 notes, about 0.4 s end to end) because the connections panel is cut from it in the browser; a per-note endpoint would fix it. Embedding and the vector scan were not re-measured on this vault.
- Deleted nothing: no unused dependency or dead code found (the only unreferenced exports are types).
- Environment note for the next agent: the shared scratchpad directory is also written by other agents; keep generated vaults in a uniquely named subfolder.

### Watch the vault (2026-11-22)

Used the product as an MCP memory: a note written while `serve` or `mcp` was running stayed unfindable for up to 30 seconds (checked: a new note was missing from `/api/search` one second after it was written). First item on the roadmap.

- Added: `serve` and `mcp` watch the vault folder (`fs.watch`, recursive) and re-index about 0.3 s after a change; a query arriving sooner re-indexes first. Adds, edits, deletes and new subfolders are picked up. Changes inside dot-folders (`.obsidian`, `.git`, our own `.vaultmind`) and `node_modules` are ignored, so writing the index does not trigger itself. New and changed notes are embedded in the background as before.
- If the folder cannot be watched, the server logs it to stderr and falls back to the 30-second rescan. Watching never stops a server: a failed re-index is logged.
- Tests: 57 unit/MCP tests (2 new; both fail when the re-index trigger or the dot-folder filter is removed). Checked by hand with `serve` on port 4100: a note added in a new subfolder was found 1 s later, and gone 0.1 s after deletion.
- On Windows CI a scan that read files was followed by change events for those files (most likely last-access times; inferred from CI, not inspected on a Windows machine), so a re-index that read files is followed by one extra rescan, which only compares sizes and times and stops there.
- Not checked: watching on Windows and Linux outside CI, network drives, vaults with tens of thousands of files (each change rescans file sizes and times, not contents).

### Launch polish (2026-11-22)

- Added: `docs/demo.gif`, recorded from the running app on the example vault by `scripts/demo.ts` (needs ffmpeg), at the top of the README.
- Added: README section comparing vaultmind with Obsidian search, Obsidian plugins, plain filesystem MCP servers, hosted products and a DIY script, with no benchmark claims; Contributing section.
- Added: `CONTRIBUTING.md`, bug and feature issue templates.
- Checked: `npm test` passed 3 times in a row locally (55 tests), CI green on main; the timing tests were not flaky here. Still not done: `ask` against the live API, the web UI on Windows.

### Reliability pass (2026-11-22)

Tried to break the tool with hostile, odd and concurrent input; every bug below has a test that failed first.

- Fixed: `marked` took quadratic to cubic time on blocks with thousands of `*`, `_` or `~` (`*a_` x 8000: 6 s), and 20 000 nested `>` or `- ` overflowed its stack, which the web server answered with "Bad request". A block with over 2000 such characters now shows them literally, and a render failure falls back to the note as plain text. The known gap about `*a` runs is closed.
- Fixed: several processes opening a brand-new index together (for example `serve` and the MCP server started at once) could fail with "database is locked". The WAL switch is retried and the schema is built under the write lock.
- Fixed: one folder that cannot be read (permissions, a sync client) made every command fail; it is now skipped. An unreadable vault root still fails.
- Fixed: frontmatter `tags` or `aliases` holding `null`, `true`, a map or a nested list produced tags called `null` and `[object object]`; a numeric `title:` was ignored.
- Fixed: links match across Unicode forms, so `[[café]]` finds a file whose name uses a combining accent (how macOS can store names).
- Fixed: MCP `get_note` pages and search excerpts no longer cut an emoji in half (the half became a replacement character).
- Checked, no bug found: CLI with missing, empty or invalid arguments, an empty vault, 30 odd search strings (quotes, FTS operators, NUL, emoji, CJK), BOM, CRLF, invalid UTF-8, broken frontmatter, notes in a folder named `x.md`, self links.
- Tests: 55 unit/MCP tests, 14 browser tests (all pass). Not done: the web UI on Windows, `ask` against the live API, retaking README screenshots (nothing visual changed).

### Filter by tag and folder (2026-11-22)

Used the product as a newcomer for the "feature" round. The thing most missed: no way to say "only my project notes" or "only this folder", in the web UI, the CLI or the MCP tools. It was also first on the roadmap.

- Added: `tag:<tag>` and `path:<folder>` in the search box and in `vaultmind search`, alone or with words (Obsidian's own operator names). Nested tags count (`tag:project` finds `#project/active`), several `tag:` must all match, folders include subfolders, matching ignores case, quoted values may hold spaces. A filter with no words lists every matching note, newest first.
- Added: MCP `search_notes` and `recent_notes` take `tags` (array) and `folder`; `search_notes` also reads the operators in `query`. When no note has the tag or the folder is empty, the reply says so and lists the vault's tags with counts, so the model can retry with a real one.
- Added: tags in a note's header are buttons; one click lists every note with that tag through the search box.
- The filter is applied inside both rankings (keyword SQL and the vector scan), not to the top 100 afterwards, so a filtered search is never short of results that exist.
- Fixed: a note with a long run of `[a](`, `[a](<` or `![a](` took quadratic time to render in the web UI (the new regression test took 12 s before the fix, 0.4 s after). The cause was our own wikilink extension's `start()` (it searched the rest of the paragraph once per `[`), not `marked`; removing it makes those inputs linear. Regression test.
- Known gap, found while checking that fix: `marked` itself is quadratic on a long run of `*a` (fixed in the reliability pass above).
- Tests: 48 unit/MCP tests (4 new), 14 browser tests (1 new). README screenshots not retaken: the tag buttons look the same as before until hovered.

### Security pass (2026-11-22)

Reviewed every trust boundary (web API and Host check, `/api/ask`, note rendering, MCP inputs, the indexer, the CI workflows), ran `npm audit` (0 vulnerabilities) and searched the git history for keys and personal data (none).

- Fixed: DNS-rebinding bypass of the web server's Host check. A page on another domain that resolves to 127.0.0.1 could `fetch("/.//127.0.0.1/api/recent")`; the browser sends the path `//127.0.0.1/api/recent`, and the server resolved it as a URL whose host replaced the attacker's Host header, so every note was readable cross-site. The request URL is now joined from Host and path. Regression test over a real socket (port 4105, `WEB_TEST_PORT` overrides).
- Fixed: a note containing a long run of unclosed `[[`, `![[`, `[[a|` or `[a](` took quadratic time to index and render (a 400 KB note: minutes, with the web and MCP servers frozen). Link targets, headings and labels can no longer contain `[`, which Obsidian does not allow in link names anyway.
- CI: actions pinned to commit SHAs, and `actions/checkout` no longer leaves the token in `.git/config`. Workflows already had `contents: read` only.
- Checked and left as is: the note renderer (raw HTML escaped, links allow-listed, tried 20+ XSS payloads), `/api/ask` cross-site protection (Origin + JSON content type), FTS query quoting, YAML alias bombs (the `yaml` package caps them), static file serving (fixed map, no path joins), symlinks (skipped).
- Known gap (fixed later the same day, see above): a long run of `[a](` rendered in quadratic time.
- Stopped four leftover `serve` processes from earlier runs on ports 4100-4103.

### Design pass (2026-11-22)

Looked at the running web UI at 1360, 900 and 390 px wide, light and dark, with the keyboard and with the server stopped.

- Link graph zooms and pans: `−`, `+` and Reset buttons, the mouse wheel (only where the page itself does not scroll), drag, and two-finger pinch. Zooming spreads notes apart while circles and names keep their size. A drag that ends on a note does not open it; a note reached with Tab while zoomed in is brought into view.
- Graph note names never overlap: best-connected notes are labelled first, a name that would cover another name or circle stays hidden until hover or zoom. The connections graph is drawn at its real column width so names stay 12.5 px.
- Tablet widths (46 to 68 rem) keep the list beside the note, with connections below it; on a phone a note or answer opened from the list scrolls to the top of the screen.
- States: "Opening your vault…" appears only if loading takes over 0.4 s; when the server stops answering the page says so and what to do; a `<noscript>` note.
- The result count and hint are one live region; focus rings follow the rounded buttons; the search box's clear button is no longer system blue.
- Search excerpts keep list items apart with `•` (they used to run together).
- README screenshots retaken from the running app, plus a phone screenshot (`scripts/screenshots.ts` writes all three).

Found by cloning the repository fresh, following the README literally, and reading the code as a reviewer.

### Fixed

- Parser: a ` ``` ` line inside a `~~~` or ` ```` ` fence no longer closes it. Before, code could turn into headings and the rest of the note could be swallowed as code.
- Parser: wikilinks, Markdown links and tags written in a heading line are indexed (they were dropped).
- A query that arrived while the embedding model was still loading ran as keyword search, and `mode: "semantic"` failed, even with a fully embedded index. The CLI, MCP server, web UI and `ask` now wait for the model when the index already has vectors (`Vault.queryEmbedder()`); an index without vectors still answers by keyword at once.
- Web UI: the header kept saying "keyword search" until a reload when embeddings arrived after the page loaded.
- On Node older than 22.18 the CLI prints which Node it found and what it needs, instead of an `ERR_UNKNOWN_BUILTIN_MODULE` stack trace.
- Tests delete their temporary vault copies on exit (each run used to leave about a dozen folders in the system temp directory).

### Changed

- CI runs on Node 22.18.0 (the documented minimum, with the browser tests), Node 24, and Windows with Node 22. `.gitattributes` pins LF line endings so the fixture vault is identical on every platform.
- New manual workflow `embeddings.yml` (`gh workflow run embeddings.yml`) indexes the example vault with the real model and runs a semantic search on Linux, Windows and macOS. It passed on all three on 2026-11-21. It is manual because it downloads the model from the Hugging Face hub.
- README: where the model is cached, the npm "install scripts blocked" warning, re-measured timings, symlinks are not followed, what is and is not tested on Windows.

### Known gaps

- `ask` has still never run against the live Anthropic API (no key on the build machine). A new test sends it through the real SDK over HTTP to a local stand-in server (port 4108, `ASK_TEST_PORT` overrides), which covers the client wiring but not what the live API accepts.
- English-only stop words, stemming and default embedding model.
- The web UI has not been opened in a browser on Windows (its API tests do run there).
- Symbolic links inside a vault are skipped.

## [0.1.0] - 2026-11-21

First release.

### Added

- Markdown parser: YAML frontmatter (`title`, `tags`, `aliases`), inline tags, wikilinks (alias, heading, embed), relative Markdown links, heading-aware chunks.
- SQLite index (`node:sqlite`, FTS5) with incremental updates by size, modification time and content hash.
- Search: BM25 keywords, local embeddings (`Xenova/all-MiniLM-L6-v2` via transformers.js, optional dependency), reciprocal rank fusion; automatic keyword fallback when the model is unavailable.
  Fusion works on sections, with at most three sections per note in each ranking, and ties go to the semantic ranking.
- Related notes (links, shared tags, content similarity), recent notes, link graph.
- CLI: `index`, `search`, `serve`, `mcp`, `ask`.
- MCP server on stdio with four read-only tools: `search_notes`, `get_note`, `related_notes`, `recent_notes`.
- Web UI on 127.0.0.1: search as you type, note reader, connections panel, whole-vault link graph, light and dark themes.
- Optional `ask`: answers with citations through the Anthropic API when `ANTHROPIC_API_KEY` is set.
- Synthetic example vault in `examples/vault`, used by the tests and the screenshots.
- CI: typecheck, unit and MCP tests, build, CLI smoke test, browser tests.
- `evals/example-vault.xml`: ten hand-checked question/answer pairs for the MCP server (not yet run through an LLM harness).

### Known gaps

- `ask` has only been exercised with a stubbed client, never against the live API.
- English-only stop words, stemming and default embedding model.
- No zoom or pan in the link graph.

## Notes for the next contributor

- Source is TypeScript run directly by Node 22.18+ (type stripping), so imports use `.ts` extensions and only erasable syntax is allowed (no enums, no parameter properties). `npm run build` emits `dist/` with `.js` imports.
- The index is a cache. Change the schema in `src/db.ts` freely, but bump `SCHEMA_VERSION`: a mismatch drops and rebuilds the index on open.
- `src/vault.ts` is the object all three fronts share. `keepFresh()` is the only place long-running commands re-index; embeddings are computed in the background and queries use whatever vectors exist. Pass `await vault.queryEmbedder()` to `search()`, never `vault.embedder` directly.
- `src/web.ts` exports `handle(vault, Request)`; test the API through it instead of opening a port. `e2e/ui.test.ts` starts a real server on port 4107 (`E2E_PORT` overrides).
- Screenshots: `node src/cli.ts serve --vault examples/vault`, then `node scripts/screenshots.ts`.
- Unit tests never download the model; `test/helpers.ts` has a hashing stand-in. To try the real model, run `node src/cli.ts index --vault examples/vault`.
- Filters: `parseQuery()` and `filterNotes()` in `src/search.ts` are the only places that understand `tag:` / `path:`; every front goes through them.
- `Vault.watch()` only marks the index stale and schedules `keepFresh()`; all re-indexing still goes through `sync()`.
- Next steps, in rough order of value: graph filtering (could reuse `filterNotes`), a tested multilingual model, npm publishing.
