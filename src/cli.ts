#!/usr/bin/env node
// node:sqlite still prints an ExperimentalWarning on Node 22. Hide that one warning, then load the program.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes("SQLite")) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { main } = await import("./main.ts");
process.exitCode = await main(process.argv.slice(2));
