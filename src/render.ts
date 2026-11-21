import { Marked } from "marked";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char]);

export const noteHref = (path: string) => `#/note/${encodeURIComponent(path)}`;

/**
 * Renders a note body to HTML that is safe to put in the page:
 * raw HTML in the note is shown as text, links are limited to http(s), mailto and other notes,
 * and images become their alt text (the UI never loads remote or vault files).
 * resolve maps a link target to a note path, or undefined when no such note exists.
 */
export function renderNote(body: string, resolve: (target: string) => string | undefined): string {
  const noteLink = (target: string, label: string) => {
    const path = resolve(target);
    return path
      ? `<a class="wikilink" href="${escapeHtml(noteHref(path))}">${label}</a>`
      : `<span class="missing" title="No note with this name yet">${label}</span>`;
  };
  const marked = new Marked({
    gfm: true,
    renderer: {
      html: ({ text }) => escapeHtml(text),
      image: ({ text }) => `<em class="image-alt">[image: ${escapeHtml(text || "untitled")}]</em>`,
      link({ href, tokens }) {
        const label = this.parser.parseInline(tokens);
        if (/^(https?:|mailto:)/i.test(href)) return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return label; // javascript:, data:, file:, obsidian: ...
        if (/\.md(#.*)?$/i.test(href)) {
          let target = href.replace(/#.*$/, "");
          try {
            target = decodeURIComponent(target);
          } catch {
            // keep the raw target
          }
          return noteLink(target, label);
        }
        return label;
      },
    },
    extensions: [
      {
        name: "wikilink",
        level: "inline",
        // No start(): marked already stops plain text at "[" and "!", and a start() that searches the rest of the
        // text would run once per "[" in a paragraph, which is quadratic on a long run of "[a](".
        tokenizer(src) {
          // Same classes as WIKILINK in parse.ts: no "[" inside, so a long run of "[[" stays linear.
          const match = /^!?\[\[([^[\]|#]*)(#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/.exec(src);
          if (!match) return undefined;
          const target = match[1].trim();
          const heading = match[2]?.slice(1).trim();
          return { type: "wikilink", raw: match[0], target, label: match[3]?.trim() || [target, heading].filter(Boolean).join(" > ") };
        },
        renderer: (token) => (token.target ? noteLink(token.target, escapeHtml(token.label)) : escapeHtml(token.label)),
      },
    ],
  });
  return marked.parse(body, { async: false });
}
