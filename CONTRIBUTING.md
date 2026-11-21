# Contributing

Thanks for looking. vaultmind is small on purpose: Markdown in, SQLite index, three thin fronts (CLI, MCP, web). Changes that keep it that way are easiest to merge.

## Setup

Node.js 22.18 or newer and git.

```bash
git clone https://github.com/Habibeyilmazz/vaultmind.git
cd vaultmind
npm install
npm run typecheck
npm test          # unit and MCP tests, no network, never downloads the model
npm run e2e       # browser tests; run `npx playwright install chromium` once
```

Source is TypeScript run directly by Node (type stripping): imports end in `.ts`, and only erasable syntax is allowed (no enums, no parameter properties). `npm run build` emits `dist/`.

## Pull requests

- One topic per PR. Open an issue first for anything large.
- New logic comes with a test; a bug fix comes with a test that fails without the fix.
- If you change the index schema in `src/db.ts`, bump `SCHEMA_VERSION`.
- Add a line to `CHANGELOG.md` under Unreleased. Keep README claims to what you ran.
- Tests and examples use only `examples/vault` (made up). Never commit real notes, keys or personal data.

The map of the code is in the README ("How it works") and the notes at the end of `CHANGELOG.md`.

## Reporting a problem

Use the issue templates. Include your OS, Node version and the command you ran. Do not paste private notes; a minimal made-up note that shows the problem is better.

Security problems: please do not open a public issue; use GitHub's private vulnerability reporting on this repository if it is enabled, otherwise open an issue that says only that you have a security report.
