import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import SearchField from "./SearchField";

export type TicketParticipantUser = {
  id: number;
  full_name?: string | null;
  login?: string | null;
};

export type TicketParticipantsPickerProps = {
  users: TicketParticipantUser[];
  value: number[];
  onChange: (ids: number[]) => void;
  disabled?: boolean;
};

function userLabel(user: TicketParticipantUser): string {
  return user.full_name || user.login || `Пользователь #${user.id}`;
}

function userMeta(user: TicketParticipantUser): string {
  const parts = [user.login, user.id ? `ID ${user.id}` : ""].filter(Boolean);
  return parts.join(" · ");
}

function matchesQuery(user: TicketParticipantUser, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [user.full_name, user.login, String(user.id)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export default function TicketParticipantsPicker({
  users,
  value,
  onChange,
  disabled = false,
}: TicketParticipantsPickerProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [query, setQuery] = useState("");

  const usersById = useMemo(() => {
    const map = new Map<number, TicketParticipantUser>();
    for (const user of users) map.set(user.id, user);
    return map;
  }, [users]);

  const selectedIds = useMemo(
    () => [...new Set(value.map(Number).filter((id) => Number.isFinite(id) && id > 0))],
    [value],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const selectedUsers = useMemo(
    () =>
      selectedIds.map((id) => usersById.get(id) || { id, full_name: null, login: null }),
    [selectedIds, usersById],
  );

  const searchResults = useMemo(() => {
    return users
      .filter((user) => !selectedSet.has(user.id))
      .filter((user) => matchesQuery(user, query));
  }, [users, selectedSet, query]);

  useEffect(() => {
    if (!modalOpen) setQuery("");
  }, [modalOpen]);

  function removeParticipant(id: number) {
    onChange(selectedIds.filter((item) => item !== id));
  }

  function addParticipant(id: number) {
    if (selectedSet.has(id)) return;
    onChange([...selectedIds, id]);
  }

  return (
    <div className="field ticket-participants-picker">
      <span>Участники</span>
      <div className="ticket-participants-picker__selected">
        {selectedUsers.length === 0 ? (
          <p className="ticket-participants-picker__empty">Участники не выбраны.</p>
        ) : (
          <ul className="ticket-participants-picker__chips">
            {selectedUsers.map((user) => (
              <li key={user.id} className="ticket-participants-picker__chip">
                <span className="ticket-participants-picker__chip-label" title={userMeta(user)}>
                  {userLabel(user)}
                </span>
                <button
                  type="button"
                  className="ticket-participants-picker__chip-remove"
                  aria-label={`Удалить ${userLabel(user)}`}
                  disabled={disabled}
                  onClick={() => removeParticipant(user.id)}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="btn-secondary btn-sm ticket-participants-picker__add"
          disabled={disabled}
          onClick={() => setModalOpen(true)}
        >
          <Plus size={16} aria-hidden="true" />
          Добавить
        </button>
      </div>

      <TicketParticipantsSearchModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        query={query}
        onQueryChange={setQuery}
        results={searchResults}
        onAdd={(user) => {
          addParticipant(user.id);
        }}
      />
    </div>
  );
}

function TicketParticipantsSearchModal({
  open,
  onClose,
  query,
  onQueryChange,
  results,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  query: string;
  onQueryChange: (value: string) => void;
  results: TicketParticipantUser[];
  onAdd: (user: TicketParticipantUser) => void;
}) {
  return (
    <Modal title="Добавить участников" open={open} onClose={onClose} size="wide">
      <div className="ticket-participants-modal">
        <SearchField
          value={query}
          onChange={onQueryChange}
          placeholder="Поиск по имени или логину…"
          className="ticket-participants-modal__search"
        />
        <div className="firm-search-results ticket-participants-modal__results">
          {results.length === 0 ? (
            <p className="firm-search-status">
              {query.trim() ? "Сотрудники не найдены." : "Нет доступных сотрудников."}
            </p>
          ) : (
            results.map((user) => (
              <button
                key={user.id}
                type="button"
                className="firm-search-result"
                onClick={() => onAdd(user)}
              >
                <strong>{userLabel(user)}</strong>
                <span className="firm-search-result__meta">{userMeta(user)}</span>
              </button>
            ))
          )}
        </div>
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Готово
          </button>
        </div>
      </div>
    </Modal>
  );
}
