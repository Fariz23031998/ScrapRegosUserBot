import { describe, expect, it } from "vitest";
import {
  chatFileMimeType,
  chatMessageSearchText,
  findChatMessageMatchIds,
  isChatAudio,
  isChatVideo,
  mergeMessages,
  nextOlderMessagesOffset,
  recordedVoiceFile,
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

describe("recordedVoiceFile", () => {
  const stamp = 1_700_000_000_000;

  it("wraps webm blobs as weba audio so they are not classified as video", () => {
    const webm = recordedVoiceFile(new Blob(["opus"], { type: "audio/webm;codecs=opus" }), stamp);
    expect(webm.name).toBe(`voice-${stamp}.weba`);
    expect(webm.type).toBe("audio/webm");
    expect(isChatAudio(webm)).toBe(true);
    expect(isChatVideo(webm)).toBe(false);

    const asVideoMime = recordedVoiceFile(new Blob(["opus"], { type: "video/webm" }), stamp);
    expect(asVideoMime.name).toBe(`voice-${stamp}.weba`);
    expect(asVideoMime.type).toBe("audio/webm");
    expect(isChatAudio(asVideoMime)).toBe(true);
    expect(isChatVideo(asVideoMime)).toBe(false);

    const unlabeled = recordedVoiceFile(new Blob(["opus"]), stamp);
    expect(unlabeled.name).toBe(`voice-${stamp}.weba`);
    expect(unlabeled.type).toBe("audio/webm");
  });

  it("uses m4a for mp4/aac recorder output", () => {
    const mp4 = recordedVoiceFile(new Blob(["aac"], { type: "audio/mp4" }), stamp);
    expect(mp4.name).toBe(`voice-${stamp}.m4a`);
    expect(mp4.type).toBe("audio/mp4");
    expect(isChatAudio(mp4)).toBe(true);
    expect(isChatVideo(mp4)).toBe(false);

    const aac = recordedVoiceFile(new Blob(["aac"], { type: "audio/aac" }), stamp);
    expect(aac.name).toBe(`voice-${stamp}.m4a`);
    expect(aac.type).toBe("audio/aac");
    expect(isChatAudio(aac)).toBe(true);
  });

  it("still treats a real .webm file as video", () => {
    const clip = new File(["vid"], "clip.webm", { type: "video/webm" });
    expect(isChatVideo(clip)).toBe(true);
    expect(isChatAudio(clip)).toBe(false);
  });
});
