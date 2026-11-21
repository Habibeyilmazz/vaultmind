#!/usr/bin/env node
// Claude Desktop and other launchers often find an older Node than the terminal does: say so instead of a stack trace.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`vaultmind needs Node.js 22.18 or newer; this is ${process.version} (${process.execPath}).`);
  process.exit(1);
}

// node:sqlite still prints an ExperimentalWarning on Node 22. Hide that one warning, then load the program.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes("SQLite")) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { main } = await import("./main.ts");
process.exitCode = await main(process.argv.slice(2));
