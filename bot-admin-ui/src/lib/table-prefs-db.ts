import type {
  ColumnFiltersState,
  ColumnOrderState,
  ColumnSizingState,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table";

const DB_NAME = "bot-admin-table-prefs";
const STORE_NAME = "prefs";
const DB_VERSION = 1;

export type TablePrefs = {
  sorting: SortingState;
  columnFilters: ColumnFiltersState;
  columnVisibility: VisibilityState;
  columnSizing: ColumnSizingState;
  columnOrder?: ColumnOrderState;
  filtersEnabled: boolean;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Failed to open table prefs IndexedDB"));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const request = fn(store);
    let result: T | undefined;

    request.onerror = () => reject(request.error ?? new Error("Table prefs IndexedDB request failed"));
    request.onsuccess = () => {
      result = request.result as T;
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result as T);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Table prefs IndexedDB transaction failed"));
    };
  });
}

export async function getTablePrefs(key: string): Promise<TablePrefs | null> {
  const row = await withStore("readonly", (store) => store.get(key));
  return (row as { key: string; value: TablePrefs } | undefined)?.value ?? null;
}

export async function saveTablePrefs(key: string, value: TablePrefs): Promise<void> {
  await withStore("readwrite", (store) => store.put({ key, value }));
}
