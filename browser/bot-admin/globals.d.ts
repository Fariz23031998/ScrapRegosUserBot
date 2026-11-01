interface AdminSession {
  permissions?: Record<string, boolean>;
  profile?: {
    display_name?: string;
    phone?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

declare const PAGE_SIZES: number[];
declare const NAV_PERMISSION_LINKS: Array<{ href: string; permission: string }>;
declare const LANDING_REDIRECTS: Array<{ permission: string; href: string }>;

declare function api(path: string, options?: any): Promise<any>;
declare function renderLoadingState(message?: string): string;
declare function setButtonLoading(button: HTMLButtonElement | null, busy: boolean): void;
declare function escapeHtml(value: unknown): string;
declare function hasPermission(session: AdminSession | null | undefined, key: string): boolean;
declare function firstAllowedAdminHref(session: AdminSession | null | undefined): string;
declare function applyNavPermissions(session: AdminSession | null | undefined): void;
declare function showNoSectionAccess(): void;
declare function ensureSession(options?: {
  requiredPermission?: string | null;
  redirectIfMissingUsersHome?: boolean;
}): Promise<AdminSession>;
declare function updateSearchBoxUi(
  searchInput: HTMLInputElement | null,
  searchClearBtn: HTMLElement | null,
  searchBox: HTMLElement | null,
  query: string
): void;
declare function bindSearchBox(options: {
  input: HTMLInputElement | null;
  clearBtn: HTMLElement | null;
  box: HTMLElement | null;
  onSearch: (query: string) => void;
  debounceMs?: number;
}): void;
declare function paginationHtml(state: { page: number; limit: number; total: number }): string;
declare function bindPagination(
  container: HTMLElement | null,
  state: {
    page: number;
    limit: number;
    total: number;
    onPageChange: (page: number) => void;
    onLimitChange: (limit: number) => void;
  }
): void;
declare function renderPagination(container: HTMLElement | null, state: any, handlers: any): void;
declare function initialsFromProfile(profile: any): string;
declare function ensureCredentialsModal(): HTMLElement;
declare function setAccountCredentialsMessage(type: string, text: string): void;
declare function openAccountCredentialsModal(): void;
declare function closeAccountCredentialsModal(): void;
declare function updateAccountMenuProfile(profile: any): void;
declare function logoutAdmin(): Promise<void>;
declare function closeAccountMenuDropdown(): void;
declare function mountAccountMenu(session: AdminSession | null | undefined): void;
declare function setupLogout(): void;
declare const TicketSummary: any;
