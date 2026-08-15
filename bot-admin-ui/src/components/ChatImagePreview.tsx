import { useState, type ImgHTMLAttributes } from "react";
import Modal from "./Modal";

type ChatImagePreviewProps = {
  url: string;
  name: string;
  imgClassName?: string;
  onError?: ImgHTMLAttributes<HTMLImageElement>["onError"];
};

export default function ChatImagePreview({ url, name, imgClassName = "", onError }: ChatImagePreviewProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className="ticket-chat__image-link" onClick={() => setOpen(true)}>
        <img
          className={`ticket-chat__image${imgClassName ? ` ${imgClassName}` : ""}`}
          src={url}
          alt={name}
          loading="lazy"
          crossOrigin="use-credentials"
          onError={onError}
        />
      </button>
      <Modal
        open={open}
        title={name}
        onClose={() => setOpen(false)}
        size="wide"
        className="modal--image-preview"
        closeOnOverlayClick
      >
        <img className="ticket-chat__image-preview" src={url} alt={name} crossOrigin="use-credentials" />
      </Modal>
    </>
  );
}
