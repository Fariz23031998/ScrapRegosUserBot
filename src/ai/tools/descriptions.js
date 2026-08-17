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
  create_article: 'Create a new knowledge-base article.',
  update_article:
    'Update an existing knowledge-base article. Omit fields you do not want to change. Locked articles cannot be updated.',
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
