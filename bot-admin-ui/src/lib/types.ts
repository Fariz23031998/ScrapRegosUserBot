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
  job_title?: string | null;
  description?: string | null;
};

export type AiGroupTopic = {
  key: string;
  id: number | string;
  name: string;
  when?: string;
};

export type AiPromptSlug = "customer" | "customer_assist" | "kb" | "ops" | "ticket_summary";
export type AiToolAgentSlug = "customer" | "customer_assist" | "kb" | "ops";

export type AiAgentTool = {
  name: string;
  title: string;
  description: string;
  agents: AiToolAgentSlug[];
  default_agents?: AiToolAgentSlug[];
  enabled: boolean;
  enabled_agents?: Partial<Record<AiToolAgentSlug, boolean>>;
};

export type AiToolSchema = {
  name: string;
  title: string;
  description: string;
  agents: AiToolAgentSlug[];
  parameters?: Record<string, unknown>;
  requires_ticket: boolean;
};

export type AiToolTestResult = {
  ok: boolean;
  tool?: string;
  result?: unknown;
  duration_ms?: number;
  error?: string;
  message?: string;
};

export type AiSettings = {
  enabled: boolean;
  test_mode: boolean;
  provider: string;
  model: string;
  agent_models?: Partial<Record<AiPromptSlug, string>>;
  agent_max_steps?: Partial<Record<AiPromptSlug, number | "">>;
  transcribe_model?: string;
  reasoning_effort?: string;
  history_limit: number;
  customer_replies_per_hour?: number;
  customer_replies_per_ticket?: number;
  group_chat_id?: string;
  group_topics?: AiGroupTopic[];
  disabled_tools?: string[];
  disabled_agent_tools?: Partial<Record<AiToolAgentSlug, string[]>>;
  default_agent_tools?: Partial<Record<AiToolAgentSlug, string[]>>;
  ignored_customer_messages?: string[];
  agent_tools?: AiAgentTool[];
  providers?: string[];
  models?: string[];
  models_by_provider?: Partial<Record<string, string[]>>;
  transcribe_models?: string[];
  reasoning_efforts?: string[];
  agent_model_slugs?: AiPromptSlug[];
  history_limit_min?: number;
  history_limit_max?: number;
  agent_max_steps_min?: number;
  agent_max_steps_max?: number;
  agent_max_steps_default?: number;
  customer_replies_per_hour_min?: number;
  customer_replies_per_hour_max?: number;
  customer_replies_per_ticket_min?: number;
  customer_replies_per_ticket_max?: number;
  group_topics_max?: number;
  ignored_customer_messages_max?: number;
  openai_api_key_configured?: boolean;
  openai_api_key_hint?: string;
  openai_api_key_source?: "database" | "env" | "none" | string;
  openai_base_url?: string;
  gemini_api_key_configured?: boolean;
  gemini_api_key_hint?: string;
  gemini_api_key_source?: "database" | "env" | "none" | string;
};

export type TelegramTicketSettings = {
  enabled: boolean;
  channel_id: number | null;
  direction: string;
  responsible_user_id: number | null;
  participant_user_ids: number[];
  subject: string;
  fallback_client_id: number | null;
};

export type AiPrompt = {
  id: number | null;
  type: AiPromptSlug;
  name: string;
  body: string;
  is_default: boolean;
  is_active: boolean;
  updated_at?: string | null;
  updated_by?: number | null;
};

export type AiPromptType = {
  slug: AiPromptSlug;
  title: string;
  active_id: number | null;
  prompts: AiPrompt[];
};

export type AiPromptVariable = {
  id: number;
  key: string;
  name: string;
  source: string;
  updated_at?: string | null;
  updated_by?: number | null;
};

export type AiToolDescription = {
  name: string;
  title: string;
  agents: AiToolAgentSlug[];
  body: string;
  default_body: string;
  is_custom: boolean;
  updated_at?: string | null;
  updated_by?: number | null;
};

export type TicketAiPromptMessageContent =
  | string
  | Array<{
      type?: string;
      text?: string;
      image_url?: {
        url?: string;
        file_id?: number | string | null;
        name?: string;
        placeholder?: boolean;
      };
    }>;

export type TicketAiPromptMessage = {
  role: string;
  content: TicketAiPromptMessageContent;
};

export type TicketAiPromptTool = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type TicketChatSummary = {
  ticket_id: number;
  client_id?: number | null;
  chat_id?: string | null;
  summary: string;
  model?: string | null;
  provider?: string | null;
  message_count?: number;
  period_start?: number | null;
  period_end?: number | null;
  status: string;
  error?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type TicketAiPrompt = {
  system: string;
  messages: TicketAiPromptMessage[];
  tools: TicketAiPromptTool[];
  gate: { handle: boolean; reason?: string | null };
  settings: {
    enabled: boolean;
    test_mode: boolean;
    provider?: string | null;
    model?: string | null;
    history_limit?: number;
  };
  trigger_message_id?: number | string | null;
  chat_id?: string | null;
  ticket_id?: number | string | null;
  summary?: TicketChatSummary | null;
  prior_summaries?: TicketChatSummary[];
};

export type KnowledgeCategory = {
  id: number;
  name: string;
  tags?: string;
  created_at?: string;
  updated_at?: string;
};

export type KnowledgeArticle = {
  id: number;
  title: string;
  body: string;
  tags?: string;
  category_id?: number | null;
  category?: Pick<KnowledgeCategory, "id" | "name" | "tags"> | null;
  locked?: boolean;
  is_confirmed?: boolean;
  creator?: string | null;
  updated_by?: number | null;
  created_at?: string;
  updated_at?: string;
};

export type AgentChatFile = {
  name: string;
  extension?: string;
  mime_type?: string | null;
  kind?: "image" | "audio" | "video" | "file";
  size?: number | null;
  data_url?: string | null;
};

export type KnowledgeChatMessage = {
  id: number;
  session_id: number;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
  files?: AgentChatFile[];
  run?: AgentTestRun | null;
};

export type CustomerTestTicket = {
  id?: number | null;
  status?: string | null;
  subject?: string | null;
  chat_id?: string | null;
  client_id?: number | null;
  client?: {
    id?: number | null;
    name?: string | null;
    phone?: string | null;
  } | null;
};

export type AgentTraceToolCall = {
  id?: string;
  name: string;
  arguments?: Record<string, unknown> | unknown;
  result?: unknown;
  ok: boolean;
  error?: string | null;
};

export type AgentTraceStep =
  | {
      step: number;
      type: "tool_round";
      assistant_content?: string | null;
      tool_calls: AgentTraceToolCall[];
    }
  | {
      step: number;
      type: "final";
      content?: string;
      stopped?: string;
    };

export type AgentRunUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
};

export type AgentTestPromptMessage = {
  role: "user" | "assistant";
  content: TicketAiPromptMessageContent;
};

export type AgentTestPromptTool = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type AgentPromptPreview = {
  system: string;
  messages: TicketAiPromptMessage[];
  tools: TicketAiPromptTool[];
  settings?: {
    enabled?: boolean;
    test_mode?: boolean;
    provider?: string | null;
    model?: string | null;
    history_limit?: number;
  };
  session_id?: number;
  ticket_id?: number | string | null;
  chat_id?: string | null;
};

export type AgentTestPrompt = {
  system?: string;
  tools?: AgentTestPromptTool[];
  model?: string | null;
  messages?: AgentTestPromptMessage[];
};

export type AgentTestRun = AgentTestPrompt & {
  trace?: AgentTraceStep[];
  steps?: number | null;
  usage?: AgentRunUsage | null;
  stopped?: string | null;
  replied_to_customer?: boolean;
  customer_reply?: string | null;
};

export type CustomerTestSession = {
  session_id: number;
  user_id?: number | null;
  ticket_id?: number | null;
  client_phone?: string | null;
  ticket?: CustomerTestTicket | null;
  messages: KnowledgeChatMessage[];
  prompt?: AgentTestPrompt | null;
  reply?: string;
  steps?: number | null;
  usage?: AgentRunUsage | null;
  stopped?: string | null;
  trace?: AgentTraceStep[];
  replied_to_customer?: boolean;
  customer_reply?: string | null;
};

export type TestAgentSessionSummary = {
  id: number;
  user_id?: number | null;
  ticket_id?: number | null;
  client_phone?: string | null;
  agent_kind: "customer" | "employee";
  title: string;
  user_name?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type TicketAiAssistSession = {
  session_id: number;
  ticket_id: number;
  messages: KnowledgeChatMessage[];
  reply?: string;
  replied_to_customer?: boolean;
  customer_reply?: string | null;
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

export type OrderSummary = {
  count: number;
  pending: number;
  paid: number;
  deleted: number;
  amount: number;
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
  photo_url?: string | null;
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
  ai_stopped?: boolean;
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
  last_update?: number;
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
  author_entity_photo?: string | null;
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
  mime_type?: string;
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

export type PriceKey = "fixed" | "min5" | "min30" | "hour1" | "hour2";

export type PriceValues = Partial<Record<PriceKey, string | null>>;

export type PriceCatalog = {
  title_ru?: string;
  title_uz?: string;
  notice_ru?: string;
  notice_uz?: string;
  updated_at?: string;
  categories?: PriceCategory[];
};

export type PriceCategory = {
  id?: string | number;
  name_ru?: string;
  name_uz?: string;
  items?: PriceItem[];
};

export type PriceItem = {
  id?: string | number;
  name_ru?: string;
  name_uz?: string;
  prices?: PriceValues;
};

export type CatalogImage = {
  id: number;
  url: string;
  original_name?: string;
  mime?: string;
  sort_order?: number;
};

export type CatalogCategory = {
  id: number;
  name: string;
  created_at?: string;
  updated_at?: string;
};

export type CatalogDevice = {
  id: number;
  name: string;
  description?: string;
  category_id?: number | null;
  category?: { id: number; name: string } | null;
  images?: CatalogImage[];
  cost_amount?: number | null;
  cost_currency?: string | null;
  cost_uzs?: number | null;
  cost_usd?: number | null;
  price_uzs?: number | null;
  price_usd?: number | null;
  display_price_uzs?: number | null;
  display_price_usd?: number | null;
  manager_sale_percent?: number | null;
  technician_score?: number | null;
  created_at?: string;
  updated_at?: string;
};

export type CatalogService = {
  id: number;
  name: string;
  description?: string;
  category_id?: number | null;
  category?: { id: number; name: string } | null;
  images?: CatalogImage[];
  cost_amount?: number | null;
  cost_currency?: string | null;
  cost_uzs?: number | null;
  cost_usd?: number | null;
  price_uzs?: number | null;
  price_usd?: number | null;
  display_price_uzs?: number | null;
  display_price_usd?: number | null;
  manager_sale_percent?: number | null;
  technician_score?: number | null;
  created_at?: string;
  updated_at?: string;
};

export type TaskLocation = {
  id: number;
  name: string;
};

export type SettingsLocationUser = {
  id: number;
  name: string;
};

export type SettingsLocation = {
  id: number;
  name: string;
  allowed_user_ids: number[];
  allowed_users: SettingsLocationUser[];
  created_at?: string;
  updated_at?: string;
};

export type PrintStationPrinter = {
  name: string;
  kind: "label" | "receipt" | "invoice" | string;
  enabled: boolean;
};

export type PrintStation = {
  station_id: string;
  station_name: string;
  location_id: string;
  printers?: PrintStationPrinter[];
};

export type PrintEnabledPrinter = {
  name: string;
  kind: "label" | "receipt" | "invoice" | string;
  enabled: boolean;
  station_id: string;
  station_name: string;
  location_id: string;
};

export type PrintTemplate = {
  id: string;
  kind: "label" | "receipt" | "invoice" | string;
  version: number;
  paper: { widthMm: number; heightMm: number };
  html: string;
};

export type PrintSettings = {
  enabled: boolean;
  env_forced_off: boolean;
  token_configured: boolean;
  token_hint: string;
  token_source: "database" | "env" | "none" | string;
  ws_path: string;
  connected: number;
  stations: PrintStation[];
};

export type PaymentAccount = {
  id: number;
  name: string;
  currency: "UZS" | "USD";
  value: number;
  created_at?: string;
  updated_at?: string;
};

export type AccountPaymentDirection = "in" | "out";

export type AccountPayment = {
  id: number;
  account_id: number;
  account?: { id: number; name: string; currency: "UZS" | "USD" } | null;
  direction: AccountPaymentDirection;
  amount: number;
  currency: "UZS" | "USD";
  amount_uzs: number;
  amount_usd: number;
  usd_uzs_rate?: number;
  note?: string;
  category_id?: number | null;
  category?: { id: number; name: string } | null;
  location_id?: number | null;
  location?: { id: number; name: string } | null;
  created_by_user_id?: number | null;
  created_by?: { id: number; name: string } | null;
  created_at?: string;
};

export type PaymentType = {
  id: number;
  name: string;
  currency: "UZS" | "USD";
  account_id?: number | null;
  account?: PaymentAccount | null;
  code?: string | null;
  is_system?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type TaskCategory = {
  id: number;
  name: string;
  created_at?: string;
  updated_at?: string;
};

export type TaskEmployee = {
  id: number;
  name: string;
  display_name?: string | null;
  phone?: string | null;
  job_title?: string | null;
};

export type TaskClient = {
  id: number;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
};

export type TaskMoneyTotals = {
  cost_uzs: number;
  cost_usd: number;
  price_uzs: number;
  price_usd: number;
  price_without_discount_uzs?: number;
  price_without_discount_usd?: number;
};

export type TaskPayment = {
  id: number;
  task_id?: number;
  payment_type_id?: number | null;
  payment_type_name: string;
  amount: number;
  currency: "UZS" | "USD";
  amount_uzs: number;
  amount_usd: number;
  usd_uzs_rate?: number;
  kind?: "payment" | "refund";
  device_line_id?: number | null;
  service_line_id?: number | null;
  refunded_quantity?: number | null;
  refund_id?: number | null;
  note?: string;
  created_by_user_id?: number | null;
  created_by?: { id: number; name: string } | null;
  created_at?: string;
};

export type TaskPaymentTotals = {
  paid_uzs: number;
  paid_usd: number;
  due_uzs: number;
  due_usd: number;
};

export type TaskDeviceSerial = {
  id: number;
  task_id?: number;
  device_line_id?: number;
  code: string;
  printed_at?: string | null;
  returned_at?: string | null;
  return_id?: number | null;
  created_at?: string;
};

export type TaskDeviceLine = {
  id?: number;
  task_id?: number;
  device_id: number;
  device_name?: string;
  description?: string;
  images?: CatalogImage[];
  action: "install" | "repair" | "sale" | string;
  action_label?: string;
  notes?: string;
  quantity?: number;
  returned_quantity?: number;
  remaining_return_quantity?: number;
  sort_order?: number;
  cost_amount?: number | null;
  cost_currency?: string | null;
  cost_uzs?: number | null;
  cost_usd?: number | null;
  price_stored_uzs?: number | null;
  price_stored_usd?: number | null;
  price_without_discount_uzs?: number | null;
  price_without_discount_usd?: number | null;
  price_uzs?: number | null;
  price_usd?: number | null;
  display_price_uzs?: number | null;
  display_price_usd?: number | null;
  discount_type?: "percent" | "amount" | null;
  discount_value?: number;
  discount_currency?: string | null;
  serials?: TaskDeviceSerial[];
};

export type TaskServiceLine = {
  id?: number;
  task_id?: number;
  service_id: number;
  service_name?: string;
  description?: string;
  images?: CatalogImage[];
  notes?: string;
  quantity?: number;
  sort_order?: number;
  cost_amount?: number | null;
  cost_currency?: string | null;
  cost_uzs?: number | null;
  cost_usd?: number | null;
  price_stored_uzs?: number | null;
  price_stored_usd?: number | null;
  price_without_discount_uzs?: number | null;
  price_without_discount_usd?: number | null;
  price_uzs?: number | null;
  price_usd?: number | null;
  display_price_uzs?: number | null;
  display_price_usd?: number | null;
  discount_type?: "percent" | "amount" | null;
  discount_value?: number;
  discount_currency?: string | null;
};

export type TaskRefundLine = {
  id: number;
  refund_id?: number;
  kind: "device" | "service" | string;
  device_line_id?: number | null;
  service_line_id?: number | null;
  name: string;
  quantity: number;
  price_uzs?: number;
  price_usd?: number;
  price_without_discount_uzs?: number;
  price_without_discount_usd?: number;
};

export type TaskRefund = {
  id: number;
  task_id?: number;
  note?: string;
  created_by_user_id?: number | null;
  created_by?: { id: number; name: string } | null;
  created_at?: string;
  lines?: TaskRefundLine[];
  payments?: TaskPayment[];
  totals?: { price_uzs: number; price_usd: number };
};

export type RepairReturnItem = {
  id: number;
  kind: "pending" | "returned" | string;
  device_line_id: number;
  device_id: number;
  device_name?: string;
  quantity: number;
  returned_quantity: number;
  remaining_quantity: number;
  return_id?: number | null;
  return_quantity?: number | null;
  note?: string;
  created_at?: string | null;
  created_by?: { id: number; name: string } | null;
  serials?: TaskDeviceSerial[];
  task: {
    id: number;
    title: string;
    client_name?: string;
    client_phone?: string;
    location?: { id: number; name: string } | null;
    technician?: { id: number; name: string } | null;
    updated_at?: string;
  };
};

export type FieldTask = {
  id: number;
  title: string;
  status: "new" | "in_progress" | "done" | string;
  status_label?: string;
  posted?: boolean;
  action?: "install" | "repair" | "sale" | string;
  action_label?: string;
  notes?: string;
  address?: string;
  category_id?: number | null;
  category?: { id: number; name: string } | null;
  location_id?: number | null;
  location?: { id: number; name: string } | null;
  regos_client_id?: number | null;
  client_name?: string;
  client_phone?: string;
  manager_user_id?: number | null;
  manager?: { id: number; name: string } | null;
  technician_user_id?: number | null;
  technician?: { id: number; name: string } | null;
  currency?: "UZS" | "USD" | null;
  devices: TaskDeviceLine[];
  services?: TaskServiceLine[];
  totals?: TaskMoneyTotals;
  payments?: TaskPayment[];
  payment_totals?: TaskPaymentTotals;
  refunds?: TaskRefund[];
  created_at?: string;
  updated_at?: string;
};

