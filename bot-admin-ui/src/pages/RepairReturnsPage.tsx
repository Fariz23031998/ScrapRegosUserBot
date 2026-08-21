import { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Undo2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createRepairReturn, deleteRepairReturn, listRepairReturns } from "../api/repair-returns";
import { listTaskLocations } from "../api/tasks";
import EntityCards from "../components/EntityCards";
import OpsAgentFab from "../components/OpsAgentFab";
import InfiniteScrollSentinel from "../components/InfiniteScrollSentinel";
import ListFiltersChrome from "../components/ListFiltersChrome";
import Modal from "../components/Modal";
import SimpleTable from "../components/SimpleTable";
import { useConfirm } from "../contexts/ConfirmContext";
import { useAuth } from "../hooks/useAuth";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { usePagedInfiniteQuery } from "../hooks/usePagedInfiniteQuery";
import { useUiPreferences } from "../hooks/useUiPreferences";
import type { RepairReturnItem, TaskLocation } from "../lib/types";
import { formatDateTime } from "../lib/utils";

const RETURN_STATUSES = [
  { value: "pending", label: "Ожидают возврата" },
  { value: "returned", label: "Возвращены" },
] as const;

function clientLabel(item: RepairReturnItem): string {
  return item.task.client_name || item.task.client_phone || "—";
}

function rowKey(item: RepairReturnItem): string {
  return item.kind === "returned" ? `return:${item.id}` : `pending:${item.device_line_id}`;
}

function ReturnFilterFields({
  locationId,
  status,
  locations,
  onLocationChange,
  onStatusChange,
  showActions,
  onApply,
}: {
  locationId: string;
  status: string;
  locations: TaskLocation[];
  onLocationChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  showActions?: boolean;
  onApply?: () => void;
}) {
  return (
    <>
      <label className="ticket-filters__field">
        <span>Статус</span>
        <select value={status} onChange={(event) => onStatusChange(event.target.value)}>
          {RETURN_STATUSES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label className="ticket-filters__field">
        <span>Филиал</span>
        <select value={locationId} onChange={(event) => onLocationChange(event.target.value)}>
          <option value="">Все</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
      </label>
      {showActions ? (
        <div className="ticket-filters__actions">
          <button type="button" className="btn-primary" onClick={onApply}>
            Применить
          </button>
        </div>
      ) : null}
    </>
  );
}

export default function RepairReturnsPage() {
  const { hasPermission } = useAuth();
  const { dateTimeFormat } = useUiPreferences();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const canEdit = hasPermission("tasks_edit");
  const [search, setSearch] = useState("");
  const [locationId, setLocationId] = useState("");
  const [status, setStatus] = useState("pending");
  const [appliedLocationId, setAppliedLocationId] = useState("");
  const [appliedStatus, setAppliedStatus] = useState("pending");
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);
  const [returnTarget, setReturnTarget] = useState<RepairReturnItem | null>(null);
  const [returnQty, setReturnQty] = useState("1");
  const [selectedSerialIds, setSelectedSerialIds] = useState<number[]>([]);
  const [scanCode, setScanCode] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);

  const locationsQuery = useQuery({
    queryKey: ["task-locations"],
    queryFn: listTaskLocations,
  });

  const listQuery = usePagedInfiniteQuery({
    queryKey: ["repair-returns", search, appliedStatus, appliedLocationId],
    queryFn: (page, pageSize) =>
      listRepairReturns({
        page,
        limit: pageSize,
        q: search || undefined,
        status: appliedStatus as "pending" | "returned",
        location_id: appliedLocationId || undefined,
      }),
    getItems: (data) => data.items || [],
    getItemId: rowKey,
  });

  const locations = locationsQuery.data?.locations || [];
  const showingReturned = appliedStatus === "returned";
  const requireSerials = Boolean(listQuery.data?.pages?.[0]?.require_serials);

  function closeReturnModal() {
    setReturnTarget(null);
    setSelectedSerialIds([]);
    setScanCode("");
    setScanError(null);
  }

  function invalidateReturns() {
    void queryClient.invalidateQueries({ queryKey: ["repair-returns"] });
    void queryClient.invalidateQueries({ queryKey: ["task"] });
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  }

  const returnMutation = useMutation({
    mutationFn: ({
      device_line_id,
      quantity,
      serial_ids,
    }: {
      device_line_id: number;
      quantity?: number;
      serial_ids?: number[];
    }) => createRepairReturn({ device_line_id, quantity, serial_ids }),
    onSuccess: () => {
      closeReturnModal();
      invalidateReturns();
    },
  });

  const undoMutation = useMutation({
    mutationFn: deleteRepairReturn,
    onSuccess: invalidateReturns,
  });

  function applyFilters() {
    setAppliedLocationId(locationId);
    setAppliedStatus(status);
  }

  function openReturn(item: RepairReturnItem) {
    const remaining = item.remaining_quantity || 1;
    const available = (item.serials || []).filter((serial) => !serial.returned_at);
    setReturnQty(String(remaining));
    setSelectedSerialIds(available.length === 1 ? [available[0].id] : []);
    setScanCode("");
    setScanError(null);
    setReturnTarget(item);
  }

  async function handleReturn(item: RepairReturnItem) {
    if (requireSerials || item.remaining_quantity > 1) {
      openReturn(item);
      return;
    }
    const ok = await confirm({
      message: `Вернуть устройство «${item.device_name || item.device_id}» клиенту?`,
      confirmLabel: "Вернуть",
    });
    if (ok) returnMutation.mutate({ device_line_id: item.device_line_id, quantity: 1 });
  }

  function addScannedSerial() {
    if (!returnTarget) return;
    const code = scanCode.trim().toUpperCase();
    if (!code) return;
    const serial = (returnTarget.serials || []).find(
      (item) => item.code.toUpperCase() === code && !item.returned_at,
    );
    if (!serial) {
      setScanError("Серийный номер не найден или уже возвращён.");
      return;
    }
    setSelectedSerialIds((current) => (current.includes(serial.id) ? current : [...current, serial.id]));
    setScanCode("");
    setScanError(null);
  }

  function toggleSerial(id: number, checked: boolean) {
    setScanError(null);
    setSelectedSerialIds((current) => {
      if (checked) return current.includes(id) ? current : [...current, id];
      return current.filter((serialId) => serialId !== id);
    });
  }

  async function submitReturn() {
    if (!returnTarget) return;
    if (requireSerials) {
      if (!selectedSerialIds.length) {
        setScanError("Укажите серийные номера для возврата устройства.");
        return;
      }
      returnMutation.mutate({
        device_line_id: returnTarget.device_line_id,
        serial_ids: selectedSerialIds,
      });
      return;
    }
    const remaining = returnTarget.remaining_quantity || 1;
    const qty = Math.trunc(Number(returnQty));
    if (!Number.isFinite(qty) || qty < 1 || qty > remaining) return;
    returnMutation.mutate({ device_line_id: returnTarget.device_line_id, quantity: qty });
  }

  async function handleUndo(item: RepairReturnItem) {
    if (!item.return_id) return;
    const ok = await confirm({
      message: `Отменить возврат устройства «${item.device_name || item.device_id}»?`,
      variant: "danger",
      confirmLabel: "Отменить возврат",
    });
    if (ok) undoMutation.mutate(item.return_id);
  }

  function itemActions(item: RepairReturnItem): ReactNode {
    if (!canEdit) return null;
    if (showingReturned) {
      return (
        <button
          type="button"
          className="btn-secondary btn-icon btn-sm"
          aria-label="Отменить возврат"
          title="Отменить возврат"
          disabled={undoMutation.isPending}
          onClick={(event) => {
            event.stopPropagation();
            void handleUndo(item);
          }}
        >
          <RotateCcw size={15} aria-hidden="true" />
        </button>
      );
    }
    return (
      <button
        type="button"
        className="btn-primary btn-icon btn-sm"
        aria-label="Вернуть"
        title="Вернуть"
        disabled={returnMutation.isPending}
        onClick={(event) => {
          event.stopPropagation();
          void handleReturn(item);
        }}
      >
        <Undo2 size={15} aria-hidden="true" />
      </button>
    );
  }

  const columns = useMemo<ColumnDef<RepairReturnItem>[]>(
    () => [
      {
        id: "id",
        header: "ID",
        accessorFn: (row) => (row.kind === "returned" ? row.return_id ?? row.id : row.device_line_id),
      },
      {
        id: "device",
        header: "Устройство",
        accessorFn: (row) => row.device_name || `Устройство #${row.device_id}`,
      },
      {
        id: "quantity",
        header: "Количество",
        cell: ({ row }) =>
          showingReturned
            ? `${row.original.return_quantity || 0} из ${row.original.quantity}`
            : `${row.original.remaining_quantity} из ${row.original.quantity}`,
      },
      {
        id: "serials",
        header: "Серийники",
        accessorFn: (row) => (row.serials || []).map((serial) => serial.code).join(", ") || "—",
      },
      {
        id: "task",
        header: "Задача",
        cell: ({ row }) => (
          <Link to={`/tasks/${row.original.task.id}`} onClick={(event) => event.stopPropagation()}>
            {row.original.task.title}
          </Link>
        ),
      },
      {
        id: "client",
        header: "Клиент",
        accessorFn: (row) => clientLabel(row),
      },
      {
        id: "location",
        header: "Филиал",
        accessorFn: (row) => row.task.location?.name || "—",
      },
      {
        id: "technician",
        header: "Техник",
        accessorFn: (row) => row.task.technician?.name || "—",
      },
      {
        id: "date",
        header: showingReturned ? "Возвращён" : "Обновлено",
        accessorFn: (row) => formatDateTime(showingReturned ? row.created_at : row.task.updated_at),
      },
      ...(showingReturned
        ? [
            {
              id: "author",
              header: "Кто вернул",
              accessorFn: (row: RepairReturnItem) => row.created_by?.name || "—",
            },
          ]
        : []),
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="cell-actions" onClick={(event) => event.stopPropagation()}>
            {itemActions(row.original)}
          </div>
        ),
      },
    ],
    [dateTimeFormat, showingReturned, canEdit, returnMutation.isPending, undoMutation.isPending],
  );

  const items = listQuery.items;
  const total = listQuery.total;
  const emptyMessage =
    search || appliedLocationId
      ? "Ничего не найдено. Измените фильтры."
      : showingReturned
        ? "Возвращённых устройств пока нет."
        : "Нет устройств, ожидающих возврата.";

  return (
    <section className="card">
      <ListFiltersChrome
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Поиск по устройству, задаче, клиенту…"
        filtersActive={Boolean(appliedLocationId || appliedStatus !== "pending")}
        filtersModalOpen={filtersModalOpen}
        onFiltersModalOpenChange={setFiltersModalOpen}
        onApplyFilters={applyFilters}
        onResetFilters={() => {
          setLocationId("");
          setStatus("pending");
        }}
        desktopFilters={
          <ReturnFilterFields
            locationId={locationId}
            status={status}
            locations={locations}
            onLocationChange={setLocationId}
            onStatusChange={setStatus}
            showActions
            onApply={applyFilters}
          />
        }
        sheetFilters={
          <ReturnFilterFields
            locationId={locationId}
            status={status}
            locations={locations}
            onLocationChange={setLocationId}
            onStatusChange={setStatus}
          />
        }
      />

      <div className="ticket-table-section">
        {compact ? (
          <EntityCards
            items={items}
            isLoading={listQuery.isPending}
            emptyMessage={emptyMessage}
            getKey={rowKey}
            getTitle={(item) => item.device_name || `Устройство #${item.device_id}`}
            getSubtitle={(item) => item.task.title}
            getFields={(item) => [
              { label: "Клиент", value: clientLabel(item) },
              { label: "Филиал", value: item.task.location?.name || "—" },
              { label: "Техник", value: item.task.technician?.name || "—" },
              {
                label: "Количество",
                value: showingReturned
                  ? `${item.return_quantity || 0} из ${item.quantity}`
                  : `${item.remaining_quantity} из ${item.quantity}`,
              },
              {
                label: "Серийники",
                value: (item.serials || []).map((serial) => serial.code).join(", ") || "—",
              },
              {
                label: showingReturned ? "Возвращён" : "Обновлено",
                value: formatDateTime(showingReturned ? item.created_at : item.task.updated_at),
              },
              ...(showingReturned ? [{ label: "Кто вернул", value: item.created_by?.name || "—" }] : []),
            ]}
            getActions={(item) => itemActions(item)}
            onOpen={(item) => navigate(`/tasks/${item.task.id}`)}
          />
        ) : (
          <SimpleTable
            tableKey="bot-admin.repair-returns"
            data={items}
            columns={columns}
            isLoading={listQuery.isPending}
            serverSideSearch
            emptyMessage={emptyMessage}
            getRowId={rowKey}
            onRowClick={(item) => navigate(`/tasks/${item.task.id}`)}
          />
        )}
        <InfiniteScrollSentinel
          loaded={items.length}
          total={total}
          hasNextPage={Boolean(listQuery.hasNextPage)}
          isFetchingNextPage={listQuery.isFetchingNextPage}
          fetchNextPage={listQuery.fetchNextPage}
        />
      </div>

      <Modal
        open={Boolean(returnTarget)}
        title="Вернуть устройство"
        onClose={closeReturnModal}
        size={requireSerials ? "default" : "confirm"}
      >
        {returnTarget ? (
          <div>
            <p>
              {returnTarget.device_name || `Устройство #${returnTarget.device_id}`} · задача «
              {returnTarget.task.title}»
            </p>
            {requireSerials ? (
              <>
                <label className="ticket-filters__field">
                  <span>Сканируйте или введите серийный номер</span>
                  <input
                    type="text"
                    autoFocus
                    value={scanCode}
                    onChange={(event) => {
                      setScanCode(event.target.value);
                      setScanError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addScannedSerial();
                      }
                    }}
                  />
                </label>
                <div className="return-serials" role="group" aria-label="Серийные номера">
                  {(returnTarget.serials || [])
                    .filter((serial) => !serial.returned_at)
                    .map((serial) => (
                      <label key={serial.id} className="field-checkbox return-serials__item">
                        <input
                          type="checkbox"
                          checked={selectedSerialIds.includes(serial.id)}
                          onChange={(event) => toggleSerial(serial.id, event.target.checked)}
                        />
                        <code>{serial.code}</code>
                      </label>
                    ))}
                </div>
                <p className="muted-copy">Выбрано: {selectedSerialIds.length}</p>
              </>
            ) : (
              <label className="ticket-filters__field">
                <span>Количество</span>
                <input
                  type="number"
                  min={1}
                  max={returnTarget.remaining_quantity}
                  value={returnQty}
                  onChange={(event) => setReturnQty(event.target.value)}
                />
              </label>
            )}
            <div className="form-actions">
              <button type="button" className="btn-secondary" onClick={closeReturnModal}>
                Отмена
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={returnMutation.isPending || (requireSerials && !selectedSerialIds.length)}
                onClick={() => void submitReturn()}
              >
                Вернуть
              </button>
            </div>
            {scanError ? <p className="message error">{scanError}</p> : null}
            {returnMutation.isError ? (
              <p className="message error">{(returnMutation.error as Error).message}</p>
            ) : null}
          </div>
        ) : null}
      </Modal>
      <OpsAgentFab />
    </section>
  );
}
