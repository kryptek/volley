/**
 * A small, safe inline Markdown renderer for text the Desk did not write (a release's changelog
 * entries): paragraphs, `-` / `*` bullet lists, `code`, **bold**, *italic* and links to `http(s)`
 * only, emitted as React elements. It never emits raw HTML: anything else, tags included, is
 * text (React escapes it). Input past `MARKDOWN_MAX_CHARS` is cut and ends with an ellipsis.
 */
import { Fragment, type ReactNode, createElement } from "react";

/** The most characters rendered; longer input is truncated with `…`. */
export const MARKDOWN_MAX_CHARS = 4000;

const BULLET = /^\s*[-*]\s+(.*)$/;
/** `code`, **bold**, *italic*, [text](url): the first that matches at a position wins. */
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

function safeHref(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > at) out.push(text.slice(at, i));
    const k = `${key}.${n++}`;
    const [whole, code, bold, em, label, url] = m;
    if (code !== undefined) out.push(createElement("code", { key: k }, code));
    else if (bold !== undefined) out.push(createElement("strong", { key: k }, inline(bold, k)));
    else if (em !== undefined) out.push(createElement("em", { key: k }, inline(em, k)));
    else {
      const href = safeHref(url ?? "");
      out.push(
        href === null
          ? whole
          : createElement(
              "a",
              { key: k, href, target: "_blank", rel: "noopener noreferrer" },
              inline(label ?? "", k),
            ),
      );
    }
    at = i + whole.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** `text` as React elements (see the module comment); an empty input renders nothing. */
export function renderInlineMarkdown(text: string): ReactNode {
  const src = text.length > MARKDOWN_MAX_CHARS ? `${text.slice(0, MARKDOWN_MAX_CHARS)}…` : text;
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    const k = `b${blocks.length}`;
    if (para.length > 0) blocks.push(createElement("p", { key: k }, inline(para.join(" "), k)));
    else if (list.length > 0)
      blocks.push(
        createElement(
          "ul",
          { key: k },
          list.map((item, i) => createElement("li", { key: i }, inline(item, `${k}.${i}`))),
        ),
      );
    para = [];
    list = [];
  };
  for (const line of src.split("\n")) {
    const bullet = BULLET.exec(line);
    if (line.trim() === "") flush();
    else if (bullet) {
      if (para.length > 0) flush();
      list.push(bullet[1] ?? "");
    } else {
      if (list.length > 0) flush();
      para.push(line.trim());
    }
  }
  flush();
  return createElement(Fragment, null, ...blocks);
}
