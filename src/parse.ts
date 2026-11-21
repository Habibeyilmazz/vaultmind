import { parse as parseYaml } from "yaml";

export interface Chunk {
  /** Heading path, e.g. "Sourdough Starter > Feeding schedule". Empty for text before the first heading. */
  heading: string;
  text: string;
  /** 1-based line in the source file where the chunk starts. */
  line: number;
}

export interface ParsedNote {
  title: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  aliases: string[];
  /** Link targets as written (no "#heading", no "|alias"), deduplicated. */
  links: string[];
  chunks: Chunk[];
  /** Markdown without the frontmatter block. */
  body: string;
}

/** Sections longer than this are split at paragraph breaks. Small enough for a 256-token embedding model. */
export const MAX_CHUNK_CHARS = 1000;

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
// No "[" inside a link: each attempt then stops at the next link start, so a line of "[[[[..." is linear, not quadratic.
const WIKILINK = /!?\[\[([^[\]|#]*)(?:#[^[\]|]*)?(?:\|[^[\]]*)?\]\]/g;
const MD_LINK = /\[[^[\]]*\]\(([^[)\s#]+\.md)(?:#[^)\s]*)?\)/g;
const INLINE_TAG = /(?<=^|\s)#([\p{L}_][\p{L}\p{N}_/-]*)/gu;

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/[,\s]+/);
  return [];
}

function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string; offset: number } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw, offset: 0 };
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed: unknown = parseYaml(match[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frontmatter = parsed as Record<string, unknown>;
  } catch {
    // Broken YAML should not make a note unsearchable: index it without metadata.
  }
  return { frontmatter, body: raw.slice(match[0].length), offset: match[0].split("\n").length - 1 };
}

function splitLong(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const parts: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (current && current.length + paragraph.length + 2 > MAX_CHUNK_CHARS) {
      parts.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) parts.push(current);
  return parts;
}

export function parseNote(path: string, raw: string): ParsedNote {
  const { frontmatter, body, offset } = splitFrontmatter(raw.replace(/^﻿/, ""));
  const tags = new Set<string>();
  const links = new Set<string>();
  const chunks: Chunk[] = [];
  const headingPath: string[] = [];
  let firstH1 = "";
  const headings: string[] = [];
  /** The marker that opened the code fence we are in, e.g. "```" or "~~~~". Empty outside a fence. */
  let fence = "";
  let section: string[] = [];
  let sectionLine = offset + 1;

  const flush = () => {
    const text = section.join("\n").trim();
    if (text) {
      // Later pieces of a split section keep the section's start line: good enough to find it again.
      for (const part of splitLong(text)) chunks.push({ heading: headingPath.filter(Boolean).join(" > "), text: part, line: sectionLine });
    }
    section = [];
  };

  // Links and tags count wherever they are written, in a heading as much as in the text under it.
  const scan = (line: string) => {
    const prose = line.replace(/`[^`]*`/g, "");
    for (const m of prose.matchAll(INLINE_TAG)) tags.add(m[1].toLowerCase());
    for (const m of prose.matchAll(WIKILINK)) if (m[1].trim()) links.add(m[1].trim());
    for (const m of prose.matchAll(MD_LINK)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue; // http:, obsidian:, ...
      try {
        links.add(decodeURIComponent(m[1]));
      } catch {
        links.add(m[1]);
      }
    }
  };

  body.split(/\r?\n/).forEach((line, index) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      // Only the same character, at least as long, closes a fence: ``` inside ~~~ or ```` is just text.
      if (marker?.startsWith(fence)) fence = "";
      section.push(line);
      return;
    }
    if (marker) {
      fence = marker;
      section.push(line);
      return;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      headingPath.length = level - 1;
      headingPath[level - 1] = heading[2];
      headings.push(heading[2]);
      if (level === 1 && !firstH1) firstH1 = heading[2];
      sectionLine = offset + index + 1;
      scan(heading[2]);
      return;
    }
    section.push(line);
    scan(line);
  });
  flush();
  // A stub or outline with no body text still gets one chunk, so its title and headings are searchable.
  if (chunks.length === 0) chunks.push({ heading: "", text: headings.join("\n"), line: offset + 1 });

  for (const tag of [...stringList(frontmatter.tags), ...stringList(frontmatter.tag)]) {
    const clean = tag.trim().replace(/^#/, "").toLowerCase();
    if (clean) tags.add(clean);
  }
  const fileName = path.split("/").pop()!.replace(/\.md$/i, "");
  const title = typeof frontmatter.title === "string" && frontmatter.title.trim() ? frontmatter.title.trim() : firstH1 || fileName;

  return {
    title,
    frontmatter,
    tags: [...tags].sort(),
    aliases: [...stringList(frontmatter.aliases), ...stringList(frontmatter.alias)].map((a) => a.trim()).filter(Boolean),
    links: [...links],
    chunks,
    body,
  };
}
