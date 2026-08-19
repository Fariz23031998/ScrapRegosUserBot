import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("returns empty for blank input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("   \n")).toBe("");
  });

  it("escapes raw HTML", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).toContain("&lt;script&gt;");
    expect(renderMarkdown("<script>alert(1)</script>")).not.toContain("<script>");
  });

  it("renders headings, lists, emphasis, and safe links", () => {
    const html = renderMarkdown(
      "# Title\n\nParagraph with **bold** and *italic*.\n\n- one\n- two\n\n[Site](https://example.com)",
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("drops javascript links", () => {
    const html = renderMarkdown("[x](javascript:alert)");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("href=");
    expect(html).toContain(">x<");
  });

  it("keeps fenced code escaped", () => {
    const html = renderMarkdown("```\n<img>\n```");
    expect(html).toContain("<pre><code>&lt;img&gt;</code></pre>");
  });
});
