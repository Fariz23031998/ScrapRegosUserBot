import { describe, expect, it } from "vitest";
import {
  chatFileMimeType,
  chatMessageSearchText,
  findChatMessageMatchIds,
  mergeMessages,
  nextOlderMessagesOffset,
  splitSearchHighlight,
} from "./ticket-chat";
import type { ChatMessage } from "./types";

function msg(id: string, created_date: number, text = ""): ChatMessage {
  return { id, created_date, text };
}

describe("ticket chat paging", () => {
  it("uses next_offset as the cursor for older newest-first pages", () => {
    expect(nextOlderMessagesOffset({ next_offset: 50, offset: 0, messages: new Array(50) })).toBe(50);
    expect(nextOlderMessagesOffset({ offset: 50, messages: new Array(30) })).toBe(80);
    expect(nextOlderMessagesOffset({ messages: [] }, 0)).toBe(0);
  });

  it("keeps already loaded history when merging a newer tail page", () => {
    const existing = [msg("old", 1), msg("mid", 2), msg("new", 3)];
    const tail = [msg("mid", 2), msg("new", 3), msg("newer", 4)];
    expect(mergeMessages(existing, tail).map((item) => item.id)).toEqual(["old", "mid", "new", "newer"]);
  });
});

describe("chat history search", () => {
  it("prefers display_text over text", () => {
    expect(chatMessageSearchText({ id: 1, text: "raw", display_text: "shown" })).toBe("shown");
    expect(chatMessageSearchText({ id: 2, text: "  raw  " })).toBe("raw");
  });

  it("finds case-insensitive matches in order", () => {
    const messages: ChatMessage[] = [
      msg("1", 1, "Hello world"),
      msg("2", 2, "nothing"),
      { id: "3", created_date: 3, display_text: "HELLO again" },
    ];
    expect(findChatMessageMatchIds(messages, " hello ")).toEqual(["1", "3"]);
    expect(findChatMessageMatchIds(messages, "   ")).toEqual([]);
  });

  it("splits text for inline highlight segments", () => {
    expect(splitSearchHighlight("Hello world", "lo")).toEqual([
      { text: "Hel", match: false },
      { text: "lo", match: true },
      { text: " world", match: false },
    ]);
    expect(splitSearchHighlight("abc", "")).toEqual([{ text: "abc", match: false }]);
  });
});

describe("chatFileMimeType", () => {
  it("maps ogg voice files away from generic octet-stream", () => {
    expect(
      chatFileMimeType({
        id: 1,
        name: "voice_161871.ogg",
        extension: "ogg",
        mime_type: "application/octet-stream",
        media_type: "voice",
      }),
    ).toBe("audio/ogg");
  });

  it("keeps real audio mime types", () => {
    expect(
      chatFileMimeType({
        id: 2,
        name: "note.mp3",
        extension: "mp3",
        mime_type: "audio/mpeg",
      }),
    ).toBe("audio/mpeg");
  });
});
