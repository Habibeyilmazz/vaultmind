import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { notePath, writeNote } from "../src/write.ts";
import { tempVault } from "./helpers.ts";

test("notePath accepts vault-relative note paths and adds .md", () => {
  assert.equal(notePath("inbox/Idea"), "inbox/Idea.md");
  assert.equal(notePath(" kitchen\\Bread Notes.MD "), "kitchen/Bread Notes.MD");
  assert.equal(notePath("Café ☕ list"), "Café ☕ list.md");
});

test("notePath refuses paths outside the indexed part of the vault", () => {
  for (const bad of ["/etc/passwd", "C:/x", "c:x", "../outside", "a/../../b", "a//b", "./a", ".obsidian/app", "notes/.git/x", "node_modules/x", "a/ /b", "what?", "a:b", "x[1]", "tag#1", "a\u0000b", "", "CON", "nul.txt", "a/aux", "Com1", "LPT9.md", "trailing.", "dir /x", "x/name ."]) {
    assert.throws(() => notePath(bad), /Cannot write/, bad);
  }
});

test("writeNote creates a note and its folders, and never overwrites", () => {
  const dir = tempVault();
  assert.deepEqual(writeNote(dir, "inbox/new/Idea", "# Idea\nno newline"), { path: "inbox/new/Idea.md", created: true });
  assert.equal(readFileSync(join(dir, "inbox/new/Idea.md"), "utf8"), "# Idea\nno newline\n");
  const before = readFileSync(join(dir, "kitchen/Sourdough Starter.md"), "utf8");
  assert.throws(() => writeNote(dir, "kitchen/Sourdough Starter.md", "gone"), /already exists\. Pass append: true/);
  assert.equal(readFileSync(join(dir, "kitchen/Sourdough Starter.md"), "utf8"), before);
  mkdirSync(join(dir, "Folder.md"));
  assert.throws(() => writeNote(dir, "Folder.md", "x", true), /it is a folder/);
  assert.throws(() => writeNote(dir, "Home.md/child", "x"), /'Home\.md' is a file, not a folder/);
});

test("writeNote appends as a new paragraph, whatever the note ends with", () => {
  const dir = mkdtempSync(join(tmpdir(), "vaultmind-write-"));
  const cases: [string, string][] = [
    ["", "added\n"],
    ["last line", "last line\n\nadded\n"],
    ["last line\n", "last line\n\nadded\n"],
    ["last line\n\n", "last line\n\nadded\n"],
  ];
  cases.forEach(([start, expected], i) => {
    writeFileSync(join(dir, `n${i}.md`), start);
    assert.deepEqual(writeNote(dir, `n${i}.md`, "added", true), { path: `n${i}.md`, created: false });
    assert.equal(readFileSync(join(dir, `n${i}.md`), "utf8"), expected, JSON.stringify(start));
  });
  assert.deepEqual(writeNote(dir, "log/Daily", "first", true), { path: "log/Daily.md", created: true });
});

test("writeNote does not follow symbolic links out of the vault", { skip: process.platform === "win32" && "symlinks need extra rights on Windows" }, () => {
  const dir = tempVault();
  const outside = mkdtempSync(join(tmpdir(), "vaultmind-outside-"));
  writeFileSync(join(outside, "secret.md"), "keep\n");
  symlinkSync(outside, join(dir, "linked"));
  symlinkSync(join(outside, "secret.md"), join(dir, "Pointer.md"));
  assert.throws(() => writeNote(dir, "linked/new.md", "x"), /symbolic link/);
  assert.throws(() => writeNote(dir, "Pointer.md", "x", true), /symbolic link/);
  assert.equal(readFileSync(join(outside, "secret.md"), "utf8"), "keep\n");
  mkdirSync(join(dir, "real"));
  assert.equal(writeNote(dir, "real/ok", "fine").created, true);
});

test("writeNote refuses a path Obsidian's Excluded files setting covers, since it would never be indexed", () => {
  const dir = tempVault();
  mkdirSync(join(dir, ".obsidian"));
  writeFileSync(join(dir, ".obsidian/app.json"), JSON.stringify({ userIgnoreFilters: ["Archive/"] }));
  assert.throws(() => writeNote(dir, "Archive/Old idea", "x"), /Excluded files/);
  assert.deepEqual(writeNote(dir, "Archived thought", "x"), { path: "Archived thought.md", created: true });
});
