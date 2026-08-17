import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export type CheckboxSelectOption = {
  value: string;
  label: string;
};

type CheckboxSelectProps = {
  label: string;
  values: string[];
  options: readonly CheckboxSelectOption[];
  allLabel?: string;
  onChange: (values: string[]) => void;
};

export default function CheckboxSelect({
  label,
  values,
  options,
  allLabel = "Все",
  onChange,
}: CheckboxSelectProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selected = new Set(values);
  const allSelected = values.length === 0;
  const triggerLabel = allSelected
    ? allLabel
    : options
        .filter((option) => selected.has(option.value))
        .map((option) => option.label)
        .join(", ");

  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function toggleValue(value: string, checked: boolean) {
    if (checked) {
      onChange([...values.filter((item) => item !== value), value]);
      return;
    }
    onChange(values.filter((item) => item !== value));
  }

  return (
    <div className="ticket-filters__field checkbox-select" ref={wrapRef}>
      <span>{label}</span>
      <button
        type="button"
        className="checkbox-select__trigger"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={menuId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="checkbox-select__value">{triggerLabel}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div className="checkbox-select__menu" id={menuId} role="listbox" aria-multiselectable="true">
          <label className="columns-menu__item">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => onChange([])}
            />
            <span>{allLabel}</span>
          </label>
          {options.map((option) => (
            <label key={option.value} className="columns-menu__item">
              <input
                type="checkbox"
                checked={selected.has(option.value)}
                onChange={(event) => toggleValue(option.value, event.target.checked)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
