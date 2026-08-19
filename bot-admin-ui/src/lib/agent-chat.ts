import type { ChatComposeUpload } from "../components/ChatCompose";
import type { AgentChatMessageItem } from "../components/AgentChatMessages";
import type { AgentChatFile, ChatFile } from "./types";
import { isChatAudio, isChatImage, isChatVideo } from "./ticket-chat";

export function toOptimisticAgentFiles(files: ChatComposeUpload[]): AgentChatFile[] {
  return files.map((file) => {
    const mime = String(file.mime_type || "").split(";")[0].trim() || "application/octet-stream";
    const probe = {
      id: file.name,
      name: file.name,
      extension: file.extension,
      mime_type: mime,
    } as ChatFile;
    const kind = isChatImage(probe)
      ? "image"
      : isChatAudio(probe)
        ? "audio"
        : isChatVideo(probe)
          ? "video"
          : "file";
    return {
      name: file.name,
      extension: file.extension,
      mime_type: mime,
      kind,
      data_url: `data:${mime};base64,${file.data}`,
    };
  });
}

export function makePendingUserMessage(text: string, files: ChatComposeUpload[]): AgentChatMessageItem {
  return {
    id: `pending-${Date.now()}`,
    role: "user",
    content: String(text || "").trim(),
    files: toOptimisticAgentFiles(files),
  };
}

export function makeStreamingAssistantMessage(content = ""): AgentChatMessageItem {
  return {
    id: "streaming-assistant",
    role: "assistant",
    content,
    streaming: true,
  };
}
