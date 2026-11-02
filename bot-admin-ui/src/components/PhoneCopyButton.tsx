import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { useUiPreferences } from "../hooks/useUiPreferences";
import { microsipUri, uzbekPhoneWithoutCountryCode } from "../lib/utils";

function stopRowAction(event: SyntheticEvent) {
  event.stopPropagation();
}

export default function PhoneCopyButton({ phone }: { phone: string }) {
  const { phoneAction } = useUiPreferences();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  const openInMicrosip = phoneAction === "microsip";

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const title = openInMicrosip ? "Открыть в MicroSIP" : copied ? "Скопировано" : "Скопировать номер";
  const ariaLabel = openInMicrosip
    ? `Открыть в MicroSIP ${phone}`
    : copied
      ? "Скопировано"
      : `Скопировать номер ${phone}`;

  return (
    <button
      type="button"
      className={`ticket-phone-copy${openInMicrosip ? " ticket-phone-copy--microsip" : ""}${copied ? " ticket-phone-copy--copied" : ""}`}
      title={title}
      aria-label={ariaLabel}
      onPointerDown={stopRowAction}
      onClick={(event) => {
        stopRowAction(event);
        if (openInMicrosip) {
          window.location.href = microsipUri(phone);
          return;
        }
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
