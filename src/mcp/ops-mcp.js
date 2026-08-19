const { createOpsTools, WRITE_TOOL_NAMES } = require('../ai/tools/ops');
const { logAdminAudit, buildAuditDetails } = require('../db/admin-audit-logs');
const {
  PROTOCOL_LATEST,
  MCP_ACTOR,
  isEnvFlag,
  textResult,
  errorResult,
  createMcpRouter,
} = require('./protocol');

const SERVER_INFO = { name: 'scrapregos-ops', version: '1.0.0' };
const MCP_VIEWER = { seeAll: true, userId: null };

const AGENT_TO_MCP = {
  search_devices: 'devices_search',
  get_device: 'devices_get',
  create_device: 'devices_create',
  update_device: 'devices_update',
  delete_device: 'devices_delete',
  list_device_categories: 'devices_list_categories',
  create_device_category: 'devices_create_category',
  search_services: 'services_search',
  get_service: 'services_get',
  create_service: 'services_create',
  update_service: 'services_update',
  delete_service: 'services_delete',
  list_service_categories: 'services_list_categories',
  create_service_category: 'services_create_category',
  search_tasks: 'tasks_search',
  get_task: 'tasks_get',
  create_task: 'tasks_create',
  update_task: 'tasks_update',
  delete_task: 'tasks_delete',
  add_task_device: 'tasks_add_device',
  update_task_device: 'tasks_update_device',
  delete_task_device: 'tasks_delete_device',
  add_task_service: 'tasks_add_service',
  update_task_service: 'tasks_update_service',
  delete_task_service: 'tasks_delete_service',
  list_task_categories: 'tasks_list_categories',
  list_task_locations: 'tasks_list_locations',
  list_task_employees: 'tasks_list_employees',
  search_task_clients: 'tasks_search_clients',
  create_task_client: 'tasks_create_client',
  list_payment_types: 'tasks_list_payment_types',
  advance_task_status: 'tasks_advance_status',
  post_task: 'tasks_post',
  unpost_task: 'tasks_unpost',
  create_task_payment: 'tasks_create_payment',
  delete_task_payment: 'tasks_delete_payment',
  search_repair_returns: 'repair_returns_search',
  create_repair_return: 'repair_returns_create',
  delete_repair_return: 'repair_returns_delete',
};

const MCP_TO_AGENT = Object.fromEntries(
  Object.entries(AGENT_TO_MCP).map(([agentName, mcpName]) => [mcpName, agentName])
);

function isOpsReadonly() {
  return isEnvFlag('MCP_OPS_READONLY');
}

function toMcpTool(tool) {
  const name = AGENT_TO_MCP[tool.name];
  if (!name) return null;
  return {
    name,
    description: tool.description || '',
    inputSchema: tool.parameters || { type: 'object', properties: {} },
  };
}

function opsToolContext(db, { write } = {}) {
  return createOpsTools({
    db,
    write,
    viewer: MCP_VIEWER,
    permissions: null,
  });
}

function listMcpTools(db) {
  return opsToolContext(db, { write: !isOpsReadonly() }).map(toMcpTool).filter(Boolean);
}

function auditOpsWrite(db, entry) {
  try {
    logAdminAudit(db, { ...entry, actor: MCP_ACTOR });
  } catch (error) {
    console.error('[mcp] Audit log write failed:', error);
  }
}

function entityIdFromResult(result, args) {
  if (result && typeof result === 'object') {
    if (result.id != null) return result.id;
    if (result.task?.id != null) return result.task.id;
    if (result.device?.id != null) return result.device.id;
    if (result.service?.id != null) return result.service.id;
    if (result.payment?.id != null) return result.payment.id;
    if (result.item?.return_id != null) return result.item.return_id;
    if (result.item?.id != null) return result.item.id;
    if (result.category?.id != null) return result.category.id;
  }
  return args.id ?? args.task_id ?? null;
}

function auditWrite(db, agentName, args, result) {
  if (!WRITE_TOOL_NAMES.has(agentName)) return;
  if (!result || result.ok === false || result.error) return;

  const summaries = {
    create_device: `Создано устройство «${result.name || ''}»`,
    update_device: `Изменено устройство #${result.id}`,
    delete_device: `Удалено устройство #${result.id}`,
    create_device_category: `Создана категория устройств «${result.name || ''}»`,
    create_service: `Создана услуга «${result.name || ''}»`,
    update_service: `Изменена услуга #${result.id}`,
    delete_service: `Удалена услуга #${result.id}`,
    create_service_category: `Создана категория услуг «${result.name || ''}»`,
    create_task: `Создана задача «${result.title || ''}»`,
    create_task_client: `Создан клиент REGOS «${result.name || result.phone || ''}»`,
    update_task: `Изменена задача #${result.id}`,
    delete_task: `Удалена задача #${result.id}`,
    add_task_device: `Добавлено устройство в задачу #${result.id}`,
    update_task_device: `Изменена позиция устройства в задаче #${result.id}`,
    delete_task_device: `Удалена позиция устройства из задачи #${result.id}`,
    add_task_service: `Добавлена услуга в задачу #${result.id}`,
    update_task_service: `Изменена позиция услуги в задаче #${result.id}`,
    delete_task_service: `Удалена позиция услуги из задачи #${result.id}`,
    advance_task_status: `Изменён статус задачи #${result.id}`,
    post_task: `Проведена задача #${result.id}`,
    unpost_task: `Отменено проведение задачи #${result.id}`,
    create_task_payment: `Принята оплата по задаче #${result.task?.id || args.task_id}`,
    delete_task_payment: `Удалена оплата #${result.id} по задаче #${args.task_id}`,
    create_repair_return: `Возврат устройства «${result.item?.device_name || result.item?.device_line_id}» по задаче #${result.task?.id || args.task_id}`,
    delete_repair_return: `Отменён возврат устройства #${args.id} по задаче #${result.task?.id}`,
  };

  const entityType = agentName.includes('device_category')
    ? 'device_category'
    : agentName.includes('service_category')
      ? 'service_category'
      : agentName.includes('client')
        ? 'client'
        : agentName.includes('device')
        ? 'device'
        : agentName.includes('service')
          ? 'service'
          : 'task';

  const action = agentName.startsWith('create') || agentName.startsWith('add') || agentName === 'post_task'
    ? agentName === 'post_task'
      ? 'update'
      : 'create'
    : agentName.startsWith('delete')
      ? 'delete'
      : 'update';

  auditOpsWrite(db, {
    entityType,
    entityId: entityIdFromResult(result, args),
    action,
    summary: summaries[agentName] || `MCP ${agentName}`,
    details: buildAuditDetails({ after: result }),
  });
}

async function callTool(db, name, args = {}) {
  const agentName = MCP_TO_AGENT[name];
  if (!agentName) return errorResult(`Unknown tool: ${name}`);
  if (WRITE_TOOL_NAMES.has(agentName) && isOpsReadonly()) {
    return errorResult('Ops tools are read-only.');
  }

  const tools = opsToolContext(db, { write: !isOpsReadonly() });
  const tool = tools.find((item) => item.name === agentName);
  if (!tool?.execute) return errorResult(`Unknown tool: ${name}`);

  const result = await tool.execute(args || {});
  if (result && typeof result === 'object' && (result.ok === false || result.error)) {
    return errorResult(result.message || result.error || 'tool_failed', result);
  }
  auditWrite(db, agentName, args, result);
  return textResult(result);
}

function createOpsMcpRouter(db) {
  return createMcpRouter({
    path: '/mcp/ops',
    serverInfo: SERVER_INFO,
    listTools: () => listMcpTools(db),
    callTool: (name, args) => callTool(db, name, args),
  });
}

module.exports = {
  PROTOCOL_LATEST,
  AGENT_TO_MCP,
  createOpsMcpRouter,
  isOpsReadonly,
};
