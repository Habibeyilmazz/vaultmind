import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_NOTE_BYTES } from "./indexer.ts";

/**
 * Checks a vault-relative note path given by a model and returns it as POSIX segments with ".md" on the end.
 * Only paths the indexer would index pass: no absolute paths, no "..", no dot-folders (.obsidian, .git),
 * no node_modules, no characters Windows or Obsidian refuse in file names.
 */
export function notePath(input: string): string {
  let path = input.trim().replaceAll("\\", "/");
  if (!/\.md$/i.test(path)) path += ".md";
  const parts = path.split("/");
  const bad = (why: string) => new Error(`Cannot write '${input}': ${why}. Give a vault-relative path such as 'inbox/Idea.md'.`);
  if (/^[a-z]:/i.test(path) || path.startsWith("/")) throw bad("the path must be relative to the vault");
  for (const part of parts) {
    if (!part.trim() || part === "." || part === "..") throw bad("empty, '.' and '..' path parts are not allowed");
    if (part.startsWith(".") || part === "node_modules") throw bad(`'${part}' is a hidden or skipped folder that is never indexed`);
    // Windows cannot create these names (with or without an extension) and strips trailing dots and spaces.
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(part) || /[. ]$/.test(part.replace(/\.md$/i, ""))) throw bad(`'${part}' is a name Windows refuses`);
    if (/[<>:"|?*#^[\]\u0000-\u001f]/.test(part)) throw bad(`'${part}' holds a character not allowed in note names`);
  }
  return parts.join("/");
}

/**
 * Creates a note, or appends to one. Never overwrites, renames or deletes: creating fails when the file exists.
 * Appending starts the new text on its own paragraph and creates the note when it is missing.
 * Refuses to go through symbolic links, which the indexer does not follow either.
 */
export function writeNote(vaultDir: string, input: string, content: string, append = false): { path: string; created: boolean } {
  const path = notePath(input);
  const parts = path.split("/");
  let existing: ReturnType<typeof lstatSync> | undefined;
  for (let i = 1; i <= parts.length; i++) {
    existing = lstatSync(join(vaultDir, ...parts.slice(0, i)), { throwIfNoEntry: false });
    if (!existing) break;
    if (existing.isSymbolicLink()) throw new Error(`Cannot write '${path}': it goes through a symbolic link.`);
    if (i < parts.length && !existing.isDirectory()) throw new Error(`Cannot write '${path}': '${parts.slice(0, i).join("/")}' is a file, not a folder.`);
  }
  const file = join(vaultDir, ...parts);
  const text = content.endsWith("\n") ? content : `${content}\n`;
  if (existing && !existing.isFile()) throw new Error(`Cannot write '${path}': it is a folder.`);
  if (existing && !append) throw new Error(`'${path}' already exists. Pass append: true to add to it, or choose another path.`);
  if (existing) {
    if (Number(existing.size) + Buffer.byteLength(text) + 2 > MAX_NOTE_BYTES) throw new Error(`Cannot append to '${path}': the note would grow past 5 MB, which is not indexed.`);
    // A blank line before the new text, so it never runs on into the note's last line or paragraph.
    const old = readFileSync(file, "utf8");
    appendFileSync(file, (!old || old.endsWith("\n\n") ? "" : old.endsWith("\n") ? "\n" : "\n\n") + text);
    return { path, created: false };
  }
  if (Buffer.byteLength(text) > MAX_NOTE_BYTES) throw new Error(`Cannot write '${path}': over 5 MB, which is not indexed.`);
  mkdirSync(join(vaultDir, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(file, text, { flag: "wx" }); // wx: a file that appeared in the meantime is never overwritten
  return { path, created: true };
}
