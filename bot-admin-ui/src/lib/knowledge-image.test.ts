import { describe, expect, it } from "vitest";
import {
  escapeKnowledgeImageAlt,
  insertMarkdownAtCaret,
  knowledgeImageMarkdown,
} from "./knowledge-image";

describe("knowledgeImageMarkdown", () => {
  it("builds markdown with escaped alt", () => {
    expect(
      knowledgeImageMarkdown({
        id: 1,
        url: "/bot-admin/api/knowledge/articles/12/images/34",
        original_name: "Shot [1].png",
      }),
    ).toBe("![Shot 1.png](/bot-admin/api/knowledge/articles/12/images/34)");
  });

  it("falls back to screenshot", () => {
    expect(escapeKnowledgeImageAlt("")).toBe("");
    expect(
      knowledgeImageMarkdown({
        id: 2,
        url: "/bot-admin/api/knowledge/articles/1/images/2",
      }),
    ).toBe("![screenshot](/bot-admin/api/knowledge/articles/1/images/2)");
  });
});

describe("insertMarkdownAtCaret", () => {
  it("inserts at caret with spacing", () => {
    const result = insertMarkdownAtCaret("Hello", "![a](/x)", 5, 5);
    expect(result.body).toBe("Hello\n\n![a](/x)");
    expect(result.caret).toBe(result.body.length);
  });

  it("replaces selection", () => {
    const result = insertMarkdownAtCaret("aa bb cc", "![img](/u)", 3, 5);
    expect(result.body).toBe("aa \n\n![img](/u)\n\n cc");
  });
});
