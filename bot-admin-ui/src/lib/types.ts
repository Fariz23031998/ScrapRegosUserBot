export type Permissions = Record<string, boolean>;

export type SessionActor = {
  type: "password" | "user" | "telegram";
  telegramId?: number;
  userId?: number;
  regosUserId?: number;
};

export type SessionProfile = {
  displayName?: string | null;
  phone?: string;
  username?: string;
  login?: string | null;
  canChangeCredentials?: boolean;
  /** @deprecated use login */
  adminLogin?: string;
  /** @deprecated use canChangeCredentials */
  hasCredentials?: boolean;
};

export type SessionResponse = {
  ok: boolean;
  actor: SessionActor;
  profile: SessionProfile;
  permissions: Permissions;
};

export type PaginatedResponse<T> = {
  items?: T[];
  total: number;
  page: number;
  limit: number;
};

export type BotUser = {
  id: number;
  phone?: string;
  display_name?: string;
  admin_login?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  telegram_id?: number;
  regos_user_id?: number;
  regos_full_name?: string;
  regos_login?: string;
  rights?: Permissions;
  linked_at?: string;
  role?: string;
};

export type RegosUser = {
  id: number;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  login?: string;
  main_phone?: string;
  phones?: string;
};

export type RightMeta = {
  key: string;
  label: string;
  group?: string;
};

export type Order = {
  id: string;
  created_at?: string;
  status?: string;
  status_label?: string;
  amount?: number;
  client_phone?: string;
  additional_phone?: string;
  employee_name?: string;
  payment_provider?: string;
  payment_provider_label?: string;
  ticket_id?: number;
};

export type OrderLog = {
  id: number;
  created_at?: string;
  action?: string;
  action_label?: string;
  order_id?: string;
  order_amount?: number;
  client_phone?: string;
  additional_phone?: string;
  payment_provider?: string;
  payment_provider_label?: string;
  actor_name?: string;
  actor_phone?: string;
  actor_telegram_id?: number;
};

export type AdminLog = {
  id: number;
  created_at?: string;
  action?: string;
  action_label?: string;
  entity_type?: string;
  entity_label?: string;
  description?: string;
  changes?: Array<{ field: string; before: unknown; after: unknown }>;
  actor_name?: string;
  actor_phone?: string;
};

export type TicketClient = {
  id?: number;
  name?: string;
  phone?: string;
  email?: string;
  external_id?: string;
  description?: string;
};

export type TicketFirmLink = {
  id: number;
  firm_type: string;
  firm_record_id: string | number;
  firm_name?: string;
  firm_phone?: string;
  firm_message?: string;
};

export type TicketLocalData = {
  unpaid_orders?: {
    count: number;
    total_amount: number;
    orders?: Array<{
      id?: string;
      amount?: number;
      client_phone?: string;
    }>;
  };
  technical_support?: {
    status?: "none" | "active" | "expired";
    ends_at?: string;
  };
  firms?: TicketFirmLink[];
  recording?: {
    url?: string | null;
    duration_seconds?: number | null;
  };
};

export type TicketField = {
  key?: string;
  name?: string;
  value?: string;
};

export type Ticket = {
  id: number;
  subject?: string;
  client_id?: number;
  client?: TicketClient;
  channel_id?: number;
  status?: string;
  direction?: string;
  responsible_user_id?: number;
  created_date?: number;
  sla_breached?: boolean;
  rating?: number | null;
  fields?: TicketField[];
  local?: TicketLocalData;
  description?: string;
  /** Legacy flat aliases used in some views */
  client_name?: string;
  client_phone?: string;
  channel_name?: string;
  status_label?: string;
  direction_label?: string;
  responsible_name?: string;
  created_at?: string;
  has_recording?: boolean;
  duration_seconds?: number;
  [key: string]: unknown;
};

export type TicketDetail = Ticket & {
  last_update?: number;
  participant_user_ids?: number[];
  chat_id?: string | null;
  external_dialog_id?: string | null;
  audio_recording_file_id?: string | number | null;
  sla_breached_date?: number | null;
  first_response_date?: number | null;
  first_response_due_date?: number | null;
  resolve_due_date?: number | null;
  resolved_date?: number | null;
  missed?: boolean;
  rating_comment?: string | null;
  client_sentiment_score?: number | string | null;
  client_sentiment_comment?: string | null;
  client_sentiment_user_id?: number | null;
  client_sentiment_date?: number | null;
  supervisor_review_score?: number | string | null;
  supervisor_review_comment?: string | null;
  supervisor_review_user_id?: number | null;
  supervisor_review_date?: number | null;
  mood?: string;
  supervisor_check?: string;
  links?: Array<{ label: string; url: string }>;
  extra_fields?: Record<string, unknown>;
};

export type RegosTicketUser = {
  id: number;
  full_name?: string | null;
  login?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

export type FirmSearchResult = {
  type?: string | null;
  phone?: string | null;
  recordId?: string | number | null;
  clientName?: string | null;
  message?: string | null;
};

export type ChatFile = {
  id: number | string;
  name?: string | null;
  extension?: string | null;
  mime_type?: string | null;
  media_type?: string | null;
  /** Legacy alias */
  mime?: string | null;
  type?: string | null;
};

export type ChatMessage = {
  id: number | string;
  text?: string;
  display_text?: string;
  created_date?: number;
  created_at?: string;
  message_type?: string;
  author_entity_type?: string;
  author_entity_id?: number | string;
  author_entity_name?: string;
  author_role?: string;
  author_name?: string;
  is_staff?: boolean;
  is_system?: boolean;
  reply_id?: number | string;
  replay_text?: string;
  file_ids?: Array<number | string>;
  files?: ChatFile[];
};

export type ChatMessagesPage = {
  chat_id: string | null;
  messages: ChatMessage[];
  next_offset?: number;
  total?: number;
  offset?: number;
  has_older?: boolean;
  has_more?: boolean;
};

export type ChatUploadFile = {
  name: string;
  extension: string;
  data: string;
};

export type ChannelSetting = {
  id: number;
  name: string;
  active?: boolean;
  available?: boolean;
  interaction_mode: "message_only" | "call";
};

export type TechnicalSupportSubscription = {
  id: number;
  phone?: string;
  months?: number;
  amount?: number;
  order_id?: string;
  starts_at?: string;
  ends_at?: string;
  status?: string;
  status_label?: string;
};

export type PriceCatalog = {
  title_ru?: string;
  title_uz?: string;
  notice_ru?: string;
  notice_uz?: string;
  categories?: PriceCategory[];
};

export type PriceCategory = {
  id: string;
  name_ru?: string;
  name_uz?: string;
  items?: PriceItem[];
};

export type PriceItem = {
  id: string;
  name_ru?: string;
  name_uz?: string;
  fixed?: number;
  min5?: number;
  min30?: number;
  hour1?: number;
  hour2?: number;
};

export const PAGE_SIZES = [10, 25, 50, 100] as const;
