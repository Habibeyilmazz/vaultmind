# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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

### Known gaps

- `ask` has only been exercised with a stubbed client, never against the live API.
- English-only stop words, stemming and default embedding model.
- No zoom or pan in the link graph.

## Notes for the next contributor

- Source is TypeScript run directly by Node 22.18+ (type stripping), so imports use `.ts` extensions and only erasable syntax is allowed (no enums, no parameter properties). `npm run build` emits `dist/` with `.js` imports.
- The index is a cache. Change the schema in `src/db.ts` freely, but bump `SCHEMA_VERSION`: a mismatch drops and rebuilds the index on open.
- `src/vault.ts` is the object all three fronts share. `keepFresh()` is the only place long-running commands re-index; embeddings are computed in the background and queries use whatever vectors exist.
- `src/web.ts` exports `handle(vault, Request)`; test the API through it instead of opening a port. `e2e/ui.test.ts` starts a real server on port 4107 (`E2E_PORT` overrides).
- Screenshots: `node src/cli.ts serve --vault examples/vault`, then `node scripts/screenshots.ts`.
- Unit tests never download the model; `test/helpers.ts` has a hashing stand-in. To try the real model, run `node src/cli.ts index --vault examples/vault`.
- Next steps, in rough order of value: tag/folder filter for `search_notes` and the UI, file watching, graph zoom, a tested multilingual model, npm publishing.
