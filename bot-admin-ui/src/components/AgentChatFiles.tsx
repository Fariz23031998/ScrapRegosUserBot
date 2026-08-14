import { formatFileSize } from "../lib/ticket-chat";
import type { AgentChatFile } from "../lib/types";

function AgentChatFileItem({ file }: { file: AgentChatFile }) {
  const name = file.name || "file";
  if (file.kind === "image" && file.data_url) {
    return (
      <a className="ticket-chat__image-link" href={file.data_url} target="_blank" rel="noopener noreferrer">
        <img className="ticket-chat__image" src={file.data_url} alt={name} />
      </a>
    );
  }
  if (file.kind === "audio" && file.data_url) {
    return (
      <div className="ticket-chat__media ticket-chat__media--audio">
        <audio className="ticket-chat__audio" controls preload="metadata" src={file.data_url} />
        <span className="ticket-chat__media-link">{name}</span>
      </div>
    );
  }
  if (file.kind === "video" && file.data_url) {
    return (
      <div className="ticket-chat__media ticket-chat__media--video">
        <video className="ticket-chat__video" controls preload="metadata" playsInline src={file.data_url} />
        <span className="ticket-chat__media-link">{name}</span>
      </div>
    );
  }
  return (
    <span className="ticket-chat__file-link">
      {name}
      {file.size ? ` (${formatFileSize(file.size)})` : ""}
    </span>
  );
}

export default function AgentChatFiles({ files }: { files?: AgentChatFile[] | null }) {
  if (!files?.length) return null;
  return (
    <div className="ticket-chat__files">
      {files.map((file, index) => (
        <AgentChatFileItem key={`${file.name}-${index}`} file={file} />
      ))}
    </div>
  );
}
