import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";

export type SearchFieldProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
};

export default function SearchField({
  value,
  onChange,
  placeholder = "Поиск…",
  className = "",
}: SearchFieldProps) {
  const [local, setLocal] = useState(value);

  useEffect(() => {
    setLocal(value);
  }, [value]);

  return (
    <div className={`search-box ${className}`.trim()}>
      <Search className="search-box__icon" size={18} aria-hidden="true" />
      <input
        type="search"
        className="search-box__input"
        value={local}
        placeholder={placeholder}
        aria-label="Поиск"
        autoComplete="off"
        onChange={(event) => {
          setLocal(event.target.value);
          onChange(event.target.value);
        }}
      />
      {local ? (
        <button
          type="button"
          className="search-box__clear"
          aria-label="Очистить поиск"
          onClick={() => {
            setLocal("");
            onChange("");
          }}
        >
          <X size={16} />
        </button>
      ) : null}
    </div>
  );
}
