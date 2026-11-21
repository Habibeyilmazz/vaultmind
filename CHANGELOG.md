# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Filter by tag and folder (2026-11-22)

Used the product as a newcomer for the "feature" round. The thing most missed: no way to say "only my project notes" or "only this folder", in the web UI, the CLI or the MCP tools. It was also first on the roadmap.

- Added: `tag:<tag>` and `path:<folder>` in the search box and in `vaultmind search`, alone or with words (Obsidian's own operator names). Nested tags count (`tag:project` finds `#project/active`), several `tag:` must all match, folders include subfolders, matching ignores case, quoted values may hold spaces. A filter with no words lists every matching note, newest first.
- Added: MCP `search_notes` and `recent_notes` take `tags` (array) and `folder`; `search_notes` also reads the operators in `query`. When no note has the tag or the folder is empty, the reply says so and lists the vault's tags with counts, so the model can retry with a real one.
- Added: tags in a note's header are buttons; one click lists every note with that tag through the search box.
- The filter is applied inside both rankings (keyword SQL and the vector scan), not to the top 100 afterwards, so a filtered search is never short of results that exist.
- Fixed: a note with a long run of `[a](`, `[a](<` or `![a](` took quadratic time to render in the web UI (the new regression test took 12 s before the fix, 0.4 s after). The cause was our own wikilink extension's `start()` (it searched the rest of the paragraph once per `[`), not `marked`; removing it makes those inputs linear. Regression test.
- Known gap, found while checking that fix: `marked` itself is quadratic on a long run of `*a` (128 KB: about 2 s). Web view only.
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
- Next steps, in rough order of value: file watching, graph filtering (could reuse `filterNotes`), a tested multilingual model, npm publishing.
