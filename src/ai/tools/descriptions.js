/** English factory descriptions sent to the model (no live KB category suffix). */

const TOOLS_WITH_CATEGORY_SUFFIX = new Set(['search_knowledge', 'create_article', 'update_article']);

const DEFAULT_TOOL_DESCRIPTIONS = {
  search_knowledge:
    'Search the internal knowledge base by keywords (2–6 short terms). Prefer Russian KB wording and synonyms (e.g. «офис адрес контакты»). Do not paste the full customer sentence. Optional category_id limits results.',
  get_article: 'Load a full knowledge-base article by id.',
  list_knowledge_categories:
    'List knowledge-base categories (id, name, tags). Call this before assigning or filtering by category_id.',
  web_search:
    'Search the public web. Returns titles, URLs, and snippets. Then use browse_url to read a page. Do not invent sources.',
  browse_url:
    'Open a public or internal portal URL (GET only, read-only) and return page text. Use for docs, tariff pages, and portal screens. Do not create, edit, or delete anything.',
  create_article:
    'Create a new knowledge-base article. Body is Markdown. New articles stay unconfirmed until an admin confirms them.',
  update_article:
    'Update an existing knowledge-base article. Body is Markdown. Omit fields you do not want to change. Locked articles cannot be updated.',
  delete_article: 'Delete a knowledge-base article by id. Locked articles cannot be deleted.',
  create_category: 'Create a knowledge-base category.',
  update_category: 'Update a knowledge-base category. Omit fields you do not want to change.',
  delete_category: 'Delete a knowledge-base category by id. Articles in it become uncategorized.',
  search_chat_history:
    'Read recent messages from the current ticket period. Set include_other_tickets=true to also return saved summaries of earlier tickets for this client.',
  search_orders: 'Search local payment orders by client phone or free text.',
  search_client: 'Look up a client/firm in billing portals by phone, login, INN, or name.',
  get_client_firm:
    'Load billing-portal firm data for the current ticket client. Uses only that client’s phone from the ticket. Do not pass a phone or query.',
  get_prices:
    'Load the service price catalog and technical-support subscription prices. Optionally include the client TP subscription.',
  get_employee:
    'Find an employee by name, phone, or job title (for example «менеджер по продажам»). Returns description and whether they can be notified in Telegram.',
  notify_employee:
    'Send a Telegram message to an employee, for example to forward a customer request to a sales manager. Use get_employee first. Client name/phone and the ticket link are appended automatically.',
  list_group_topics:
    'List internal Telegram group topics the agent may post to. Use this to pick a topic_key before send_group_topic_message.',
  send_group_topic_message:
    'Post a message to an internal staff Telegram group topic (urgent help, KKM, new clients, field visits). Do not use this instead of answering the client. Call list_group_topics first if you are unsure which topic_key to use. Client name/phone and the ticket link are appended automatically.',
  assign_responsible: 'Assign a REGOS user as the ticket responsible. The employee must have regos_user_id.',
  close_ticket:
    'Close the current support ticket. Use when the client request is fully resolved and no follow-up is needed. Do not close if you are waiting for data, escalated to staff, or still troubleshooting.',
  update_ticket:
    'Update the current ticket. Omit fields you do not want to change. Fields: subject (max 300), description, status (Open, WaitingClient, WaitingStaff, Closed; Russian labels also accepted), employee_id or responsible_user_id, participant_employee_ids or participant_user_ids (replaces the list). Use get_employee first. Prefer close_ticket when the request is fully resolved.',
  read_chat_image:
    'Load a chat image by file_id so you can see it. Use for older screenshots listed as [изображение: … #id]. Does not work for audio or video.',
  transcribe_chat_audio:
    'Transcribe a chat voice or audio file by file_id. Use for older voice notes listed as [аудио: … #id]. Does not work for images or video.',
  reply_to_customer:
    'Post a message to the customer in the ticket chat. Use when the employee asked you to answer the client or gave enough guidance to send a customer-facing reply. Do not call this for private notes to the employee.',
  search_devices:
    'Search the field-work device catalog by name or description. Optional category_id. This is not the public price list.',
  get_device: 'Load a field-work catalog device by id, including prices. Images are omitted.',
  create_device:
    'Create a catalog device. Required: name. Provide at least one of price_uzs or price_usd. Optional: description, category_id, cost_amount, cost_currency (UZS|USD), manager_sale_percent, technician_score.',
  update_device: 'Update a catalog device. Omit fields you do not want to change. Cannot update if missing.',
  delete_device: 'Delete a catalog device by id. Fails with DEVICE_IN_USE if any task line references it.',
  list_device_categories: 'List device catalog categories (id, name). Call before assigning category_id.',
  create_device_category: 'Create a device catalog category. Required: name.',
  search_services:
    'Search the field-work service catalog by name or description. Optional category_id. Do not use get_prices / public price list.',
  get_service: 'Load a field-work catalog service by id, including prices. Images are omitted.',
  create_service:
    'Create a catalog service. Required: name. Provide at least one of price_uzs or price_usd. Optional: description, category_id, cost fields, manager_sale_percent, technician_score.',
  update_service: 'Update a catalog service. Omit fields you do not want to change.',
  delete_service: 'Delete a catalog service by id. Fails with SERVICE_IN_USE if any task line references it.',
  list_service_categories: 'List service catalog categories (id, name). Call before assigning category_id.',
  create_service_category: 'Create a service catalog category. Required: name.',
  search_tasks:
    'Search field tasks. Filters: query, status (new|in_progress|done), category_id, location_id. Results are compact; use get_task for cart, payments, and totals.',
  get_task:
    'Load a full task by id: cart lines, money totals, payments, refunds. Location access is enforced.',
  create_task:
    'Create a field task. Required: title, location_id. Action: install|repair|sale (default install). Status starts as new unless tasks_status is allowed. Posted cart is empty.',
  update_task:
    'Update task fields. Omit unchanged fields. Posted tasks reject cart-related edits (TASK_CART_LOCKED). Status changes need tasks_status.',
  delete_task: 'Delete a task by id. Location access is enforced.',
  add_task_device:
    'Add a catalog device to a task cart. If that device is already on the task, quantity increments by 1 and the quantity argument is ignored. Repair device lines have zero sale price. Posted tasks are locked.',
  update_task_device: 'Set quantity on a task device line (line_id from get_task). Posted tasks are locked.',
  delete_task_device: 'Remove a device line from a task by line_id. Posted tasks are locked.',
  add_task_service:
    'Add a catalog service to a task cart. If that service is already on the task, quantity increments by 1 and the quantity argument is ignored. Posted tasks are locked.',
  update_task_service: 'Set quantity on a task service line (line_id from get_task). Posted tasks are locked.',
  delete_task_service: 'Remove a service line from a task by line_id. Posted tasks are locked.',
  list_task_categories: 'List task categories (id, name).',
  list_task_locations: 'List branches the current viewer may use. Pass location_id from here when creating a task.',
  list_task_employees: 'List employees for manager_user_id / technician_user_id.',
  search_task_clients:
    'Search REGOS CRM clients to attach to a task (query at least 2 characters). Returns id, name, phone.',
  create_task_client:
    'Create a REGOS CRM client to attach to a task. Pass name and/or phone (at least one required). Optional email, description, external_id. Search first with search_task_clients; create only if none match. Returns id, name, phone. Then pass regos_client_id to create_task or update_task.',
  list_payment_types: 'List payment types (id, name, currency) before create_task_payment.',
  advance_task_status:
    'Move task status forward only: new → in_progress → done. For install/repair, the actor may become technician.',
  post_task: 'Post a task (posted=1). This locks the cart. Confirm with the user before posting.',
  unpost_task:
    'Unpost a task. If refunds or device returns exist, pass delete_refunds and/or delete_returns. Confirm first.',
  create_task_payment:
    'Record a payment on a task. Required: task_id, payment_type_id, amount. Optional currency (UZS|USD) and note. Call get_task and list_payment_types first. Confirm amount with the user.',
  delete_task_payment: 'Delete a payment by task_id and payment_id. Confirm first.',
  search_repair_returns:
    'Search repair device returns. status: pending (default, still to return), returned, or all. Optional query and location_id. Pending items use device_line_id; returned items use return_id. require_serials is true when serials must be passed on create.',
  create_repair_return:
    'Record a device return on a posted, done repair task. Required: device_line_id from search_repair_returns (pending) or get_task. Optional quantity (defaults to remaining). If require_serials, pass serial_ids or serial_codes from the pending item. Confirm first.',
  delete_repair_return:
    'Undo a device return by return_id (search_repair_returns status=returned). Confirm first. Serials go back to the line.',
};

function getDefaultToolDescription(name) {
  return DEFAULT_TOOL_DESCRIPTIONS[String(name || '')] || '';
}

function appendCategoryLine(name, description, categoryLine) {
  const text = String(description || '').trim();
  const suffix = String(categoryLine || '').trim();
  if (!suffix || !TOOLS_WITH_CATEGORY_SUFFIX.has(String(name || ''))) return text;
  if (text.endsWith(suffix)) return text;
  return text ? `${text} ${suffix}` : suffix;
}

function factoryToolDescription(name, categoryLine = '') {
  return appendCategoryLine(name, getDefaultToolDescription(name), categoryLine);
}

module.exports = {
  TOOLS_WITH_CATEGORY_SUFFIX,
  DEFAULT_TOOL_DESCRIPTIONS,
  getDefaultToolDescription,
  appendCategoryLine,
  factoryToolDescription,
};
