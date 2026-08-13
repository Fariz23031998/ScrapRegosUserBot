import { useRef, type FormEvent, type ReactNode } from "react";
import filterFunnelIcon from "../assets/filter-funnel.png";
import { useStickyOffsetVar } from "../hooks/useStickyOffsetVar";
import Modal from "./Modal";
import SearchField from "./SearchField";

export type ListFiltersChromeProps = {
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  desktopFilters?: ReactNode;
  sheetFilters?: ReactNode;
  filtersActive?: boolean;
  filtersModalOpen?: boolean;
  onFiltersModalOpenChange?: (open: boolean) => void;
  onApplyFilters?: () => void;
  onResetFilters?: () => void;
  stickyClassName?: string;
  children?: ReactNode;
};

export default function ListFiltersChrome({
  search,
  onSearchChange,
  searchPlaceholder = "Поиск…",
  desktopFilters,
  sheetFilters,
  filtersActive = false,
  filtersModalOpen = false,
  onFiltersModalOpenChange,
  onApplyFilters,
  onResetFilters,
  stickyClassName = "filters-sticky-head",
  children,
}: ListFiltersChromeProps) {
  const stickyRef = useRef<HTMLDivElement>(null);
  useStickyOffsetVar(stickyRef);
  const showFilterButton = Boolean(sheetFilters && onFiltersModalOpenChange);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onApplyFilters?.();
    onFiltersModalOpenChange?.(false);
  }

  return (
    <>
      <div className={stickyClassName} ref={stickyRef}>
        {children}
        <form className="ticket-filters" onSubmit={handleSubmit}>
          {desktopFilters ? (
            <div className="ticket-filters__row ticket-filters__row--desktop">{desktopFilters}</div>
          ) : null}
          <div className="ticket-filters__row ticket-filters__row--search">
            {showFilterButton ? (
              <button
                type="button"
                className={`ticket-filters__open-btn${filtersActive ? " ticket-filters__open-btn--active" : ""}`}
                aria-label="Фильтры"
                title="Фильтры"
                onClick={() => onFiltersModalOpenChange?.(true)}
              >
                <img
                  src={filterFunnelIcon}
                  alt=""
                  className="ticket-filters__open-icon"
                  width={26}
                  height={26}
                  draggable={false}
                />
                {filtersActive ? <span className="ticket-filters__open-dot" aria-hidden="true" /> : null}
              </button>
            ) : null}
            <label className="ticket-filters__search">
              <SearchField
                value={search}
                onChange={onSearchChange}
                placeholder={searchPlaceholder}
                className="ticket-filters__search-box"
              />
            </label>
          </div>
        </form>
      </div>

      {showFilterButton ? (
        <Modal
          open={filtersModalOpen}
          title="Фильтры"
          size="sheet"
          onClose={() => onFiltersModalOpenChange?.(false)}
        >
          <form className="ticket-filters-modal" onSubmit={handleSubmit}>
            <div className="ticket-filters-modal__fields">{sheetFilters}</div>
            <div className="ticket-filters-modal__actions">
              {onResetFilters ? (
                <button type="button" className="btn-secondary" onClick={onResetFilters}>
                  Сбросить
                </button>
              ) : null}
              <button type="submit" className="btn-primary">
                Применить
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
