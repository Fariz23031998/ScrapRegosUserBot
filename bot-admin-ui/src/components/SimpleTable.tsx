import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ColumnDef,
  ColumnOrderState,
  ColumnSizingState,
  SortingState,
  VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getTablePrefs, saveTablePrefs } from "../lib/table-prefs-db";
import { matchesSearch } from "../lib/utils";
import LoadingState from "./LoadingState";
import SearchField from "./SearchField";

type SimpleTableProps<T> = {
  tableKey: string;
  data: T[];
  columns: ColumnDef<T, unknown>[];
  isLoading?: boolean;
  emptyMessage?: string;
  globalSearch?: string;
  onGlobalSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  toolbar?: ReactNode;
  getRowId?: (row: T) => string;
  onRowClick?: (row: T) => void;
  serverSideSearch?: boolean;
};

function SortableHeader({
  id,
  children,
  width,
  onResizeStart,
}: {
  id: string;
  children: ReactNode;
  width: number;
  onResizeStart: (event: React.MouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    width,
    minWidth: width,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <th ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <div className="table-header-cell">
        {children}
        <span className="column-resizer" onMouseDown={onResizeStart} onClick={(e) => e.stopPropagation()} />
      </div>
    </th>
  );
}

export default function SimpleTable<T>({
  tableKey,
  data,
  columns,
  isLoading,
  emptyMessage = "Нет данных",
  globalSearch = "",
  onGlobalSearchChange,
  searchPlaceholder,
  toolbar,
  getRowId,
  onRowClick,
  serverSideSearch = false,
}: SimpleTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>([]);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    let cancelled = false;
    void getTablePrefs(tableKey).then((prefs) => {
      if (cancelled || !prefs) {
        setPrefsLoaded(true);
        return;
      }
      setSorting(prefs.sorting || []);
      setColumnVisibility(prefs.columnVisibility || {});
      setColumnSizing(prefs.columnSizing || {});
      setColumnOrder(prefs.columnOrder || []);
      setPrefsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [tableKey]);

  useEffect(() => {
    if (!prefsLoaded) return;
    void saveTablePrefs(tableKey, {
      sorting,
      columnFilters: [],
      columnVisibility,
      columnSizing,
      columnOrder,
      filtersEnabled: false,
    });
  }, [tableKey, sorting, columnVisibility, columnSizing, columnOrder, prefsLoaded]);

  useEffect(() => {
    if (!columnsMenuOpen) return;
    function onDocClick(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setColumnsMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [columnsMenuOpen]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnVisibility, columnSizing, columnOrder },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    onColumnOrderChange: setColumnOrder,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getRowId: getRowId ? (row) => getRowId(row) : undefined,
    columnResizeMode: "onChange",
    enableColumnResizing: true,
    globalFilterFn: (row, _columnId, filterValue) => {
      if (serverSideSearch) return true;
      const values = Object.values(row.original as Record<string, unknown>);
      return matchesSearch(String(filterValue), ...values.map(String));
    },
  });

  useEffect(() => {
    if (!serverSideSearch) table.setGlobalFilter(globalSearch);
  }, [globalSearch, serverSideSearch, table]);

  const headerIds = useMemo(
    () => (columnOrder.length ? columnOrder : table.getAllLeafColumns().map((c) => c.id)),
    [columnOrder, table],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = headerIds.indexOf(String(active.id));
      const newIndex = headerIds.indexOf(String(over.id));
      if (oldIndex < 0 || newIndex < 0) return;
      setColumnOrder(arrayMove(headerIds, oldIndex, newIndex));
    },
    [headerIds],
  );

  function startResize(columnId: string, event: React.MouseEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = table.getColumn(columnId)?.getSize() ?? 120;

    function onMove(moveEvent: MouseEvent) {
      const next = Math.max(80, startWidth + moveEvent.clientX - startX);
      setColumnSizing((prev) => ({ ...prev, [columnId]: next }));
    }

    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  const headerGroup = table.getHeaderGroups()[0];
  const showToolbar = Boolean(onGlobalSearchChange || toolbar);

  const columnsMenu = (
    <div
      className="columns-menu-wrap columns-menu-wrap--header"
      ref={menuRef}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="columns-menu-trigger columns-menu-trigger--header"
        onClick={() => setColumnsMenuOpen((value) => !value)}
        aria-expanded={columnsMenuOpen}
        aria-haspopup="true"
        aria-label="Настройки колонок"
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
      </button>
      {columnsMenuOpen ? (
        <div className="columns-menu columns-menu--header" role="menu">
          {table.getAllLeafColumns().map((column) => (
            <label key={column.id} className="columns-menu__item">
              <input
                type="checkbox"
                checked={column.getIsVisible()}
                onChange={column.getToggleVisibilityHandler()}
              />
              <span>{typeof column.columnDef.header === "string" ? column.columnDef.header : column.id}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="simple-table">
      {showToolbar ? (
        <div className="simple-table__toolbar">
          {onGlobalSearchChange ? (
            <SearchField value={globalSearch} onChange={onGlobalSearchChange} placeholder={searchPlaceholder} />
          ) : null}
          {toolbar}
        </div>
      ) : null}

      {isLoading ? (
        <LoadingState />
      ) : data.length === 0 ? (
        <p className="empty-state">{emptyMessage}</p>
      ) : (
        <div className="table-scroll">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <table className="data-table">
              <thead>
                <SortableContext items={headerIds} strategy={horizontalListSortingStrategy}>
                  <tr>
                    {headerGroup.headers.map((header, index) => (
                      <SortableHeader
                        key={header.id}
                        id={header.column.id}
                        width={header.getSize()}
                        onResizeStart={(event) => startResize(header.column.id, event)}
                      >
                        <div className="table-header-cell__content">
                          {index === 0 ? columnsMenu : null}
                          <button
                            type="button"
                            className="table-sort-btn"
                            onClick={header.column.getToggleSortingHandler()}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {{
                              asc: " ▲",
                              desc: " ▼",
                            }[header.column.getIsSorted() as string] ?? null}
                          </button>
                        </div>
                      </SortableHeader>
                    ))}
                  </tr>
                </SortableContext>
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className={onRowClick ? "data-table__row--clickable" : undefined}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} style={{ width: cell.column.getSize(), minWidth: cell.column.getSize() }}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <DragOverlay>
              {activeDragId ? (
                <div className="table-drag-overlay">
                  {table.getColumn(activeDragId)?.columnDef.header as ReactNode}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      )}
    </div>
  );
}
