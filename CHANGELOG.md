# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- No zoom or pan in the link graph.
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
- Next steps, in rough order of value: tag/folder filter for `search_notes` and the UI, file watching, graph zoom, a tested multilingual model, npm publishing.
