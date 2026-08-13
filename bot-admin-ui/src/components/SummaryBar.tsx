import type { ReactNode } from "react";

export type SummaryChipTone = "neutral" | "muted" | "danger" | "warn" | "ok" | "info";

export type SummaryChip = {
  key?: string;
  label: string;
  value: number | string;
  tone?: SummaryChipTone;
  valueFirst?: boolean;
};

export default function SummaryBar({
  items,
  placeholder,
}: {
  items?: SummaryChip[];
  placeholder?: ReactNode;
}) {
  return (
    <div className="summary-bar" role="status">
      {placeholder ? (
        <span className="summary-bar__placeholder">{placeholder}</span>
      ) : (
        (items || []).map((item) => (
          <span
            key={item.key || item.label}
            className={`summary-chip summary-chip--${item.tone || "neutral"}`}
          >
            {item.valueFirst ? (
              <>
                <strong className="summary-chip__value">{item.value}</strong> {item.label}
              </>
            ) : (
              <>
                {item.label}: <strong className="summary-chip__value">{item.value}</strong>
              </>
            )}
          </span>
        ))
      )}
    </div>
  );
}
