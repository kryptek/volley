import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { MARKDOWN_MAX_CHARS, renderInlineMarkdown } from "../src/lib/markdown";

const html = (md: string) => {
  const { container } = render(createElement("div", null, renderInlineMarkdown(md)));
  return container.firstElementChild as HTMLElement;
};

describe("renderInlineMarkdown", () => {
  it("renders paragraphs, bullet lists, code, bold, italic and an https link", () => {
    const el = html(
      "First **bold** and *italic* with `code`.\n\n- one\n- two with [docs](https://example.com/x)",
    );
    const p = el.querySelector("p");
    expect(p?.querySelector("strong")?.textContent).toBe("bold");
    expect(p?.querySelector("em")?.textContent).toBe("italic");
    expect(p?.querySelector("code")?.textContent).toBe("code");
    const items = [...el.querySelectorAll("ul > li")].map((li) => li.textContent);
    expect(items).toEqual(["one", "two with docs"]);
    const a = el.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com/x");
    expect(a?.getAttribute("rel")).toContain("noopener");
    expect(a?.getAttribute("target")).toBe("_blank");
  });

  it("accepts * bullets and keeps a paragraph's lines together", () => {
    const el = html("a line\nnext line\n\n* x\n* y");
    expect(el.querySelectorAll("p")).toHaveLength(1);
    expect(el.querySelector("p")?.textContent).toBe("a line next line");
    expect(el.querySelectorAll("li")).toHaveLength(2);
  });

  it("never renders HTML as elements: tags are text", () => {
    const el = html('<img src=x onerror="alert(1)"> <script>alert(2)</script> **<b>hi</b>**');
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("b")).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(el.textContent).toContain("<script>alert(2)</script>");
    expect(el.querySelector("strong")?.textContent).toBe("<b>hi</b>");
  });

  it("links only to http(s): javascript:, data: and relative links stay text", () => {
    const el = html(
      "[a](javascript:alert(1)) [b](data:text/html,x) [c](/local) [d](http://ok.example/)",
    );
    const links = [...el.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["http://ok.example/"]);
    expect(el.textContent).toContain("[a](javascript:alert(1))");
    expect(el.textContent).toContain("[c](/local)");
  });

  it("does not let link text carry markup into an href", () => {
    const el = html('[x](https://e.example/" onclick="y)');
    expect(el.querySelector("[onclick]")).toBeNull();
    for (const a of el.querySelectorAll("a")) expect(a.getAttribute("href")).not.toContain('"');
  });

  it("truncates input over the cap with an ellipsis", () => {
    const el = html("x".repeat(MARKDOWN_MAX_CHARS + 500));
    expect(el.textContent?.length).toBe(MARKDOWN_MAX_CHARS + 1);
    expect(el.textContent?.endsWith("…")).toBe(true);
  });

  it("renders nothing for empty input", () => {
    expect(html("").childNodes).toHaveLength(0);
  });
});
