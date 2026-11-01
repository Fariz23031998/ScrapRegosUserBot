import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { uzbekPhoneWithoutCountryCode } from "../lib/utils";

function stopRowAction(event: SyntheticEvent) {
  event.stopPropagation();
}

export default function PhoneCopyButton({ phone }: { phone: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <button
      type="button"
      className={`ticket-phone-copy${copied ? " ticket-phone-copy--copied" : ""}`}
      title={copied ? "Скопировано" : "Скопировать номер"}
      aria-label={copied ? "Скопировано" : `Скопировать номер ${phone}`}
      onPointerDown={stopRowAction}
      onClick={(event) => {
        stopRowAction(event);
        void navigator.clipboard.writeText(uzbekPhoneWithoutCountryCode(phone)).then(
          () => {
            setCopied(true);
            if (timerRef.current != null) window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => setCopied(false), 1600);
          },
          () => setCopied(false),
        );
      }}
      onKeyDown={stopRowAction}
    >
      {phone}
    </button>
  );
}
