export type TelegramSegment = {
  type: "text" | "bold" | "code";
  text: string;
};

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseLine(line: string): TelegramSegment[] {
  const segments: TelegramSegment[] = [];
  const pattern = /<(b|code)>([\s\S]*?)<\/\1>/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) {
      segments.push({ type: "text", text: decodeEntities(line.slice(last, index)) });
    }
    segments.push({
      type: match[1] === "b" ? "bold" : "code",
      text: decodeEntities(match[2]),
    });
    last = index + match[0].length;
  }
  if (last < line.length) {
    segments.push({ type: "text", text: decodeEntities(line.slice(last)) });
  }
  return segments;
}

/** Split a Telegram firm card into lines of text, bold, and code. Other tags stay text. */
export function parseTelegramCard(message: string): TelegramSegment[][] {
  return String(message || "").split("\n").map(parseLine);
}
