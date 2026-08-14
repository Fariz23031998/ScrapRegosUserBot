const { getProvider } = require('./providers/registry');
const { isReasoningModel } = require('./settings');
const {
  AUDIO_AGENT_TIMEOUT_MS,
  IMAGE_AGENT_TIMEOUT_MS,
  REASONING_AGENT_TIMEOUT_MS,
} = require('./chat-media');

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_REPLY = 4000;

function resolveAgentTimeoutMs(model, { timeoutMs, hasVision = false, hasAudio = false } = {}) {
  if (timeoutMs != null) return timeoutMs;
  if (hasVision) return IMAGE_AGENT_TIMEOUT_MS;
  if (hasAudio) return AUDIO_AGENT_TIMEOUT_MS;
  if (isReasoningModel(model)) return REASONING_AGENT_TIMEOUT_MS;
  return DEFAULT_TIMEOUT_MS;
}

function truncateText(text, max = DEFAULT_MAX_REPLY) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function parseToolArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function findTool(tools, name) {
  return (tools || []).find((tool) => tool.name === name) || null;
}

async function executeTool(tool, args) {
  try {
    const result = await tool.execute(args || {});
    if (typeof result === 'string') {
      return { content: result, visionParts: null };
    }
    const visionParts = Array.isArray(result?._visionParts) ? result._visionParts.filter(Boolean) : null;
    const rest = result && typeof result === 'object' ? { ...result } : { ok: true };
    delete rest._visionParts;
    return { content: JSON.stringify(rest), visionParts };
  } catch (error) {
    return { content: JSON.stringify({ ok: false, error: error.message || 'tool_failed' }), visionParts: null };
  }
}

async function runAgent({
  provider,
  providerName,
  model,
  system,
  messages,
  tools = [],
  maxSteps = DEFAULT_MAX_STEPS,
  timeoutMs,
  reasoningEffort,
  hasVision = false,
  hasAudio = false,
} = {}) {
  const impl = provider || getProvider(providerName || 'openai');
  if (!impl || typeof impl.chat !== 'function') {
    throw new Error('AI provider is not available');
  }

  const limitMs = resolveAgentTimeoutMs(model, { timeoutMs, hasVision, hasAudio });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(limitMs) || DEFAULT_TIMEOUT_MS));
  const history = [];
  if (system) {
    history.push({ role: 'system', content: String(system) });
  }
  for (const message of messages || []) {
    history.push(message);
  }

  try {
    for (let step = 0; step < Math.max(1, Number(maxSteps) || DEFAULT_MAX_STEPS); step += 1) {
      if (controller.signal.aborted) {
        throw new Error('AI_TIMEOUT');
      }
      const response = await impl.chat({
        model,
        messages: history,
        tools,
        signal: controller.signal,
        reasoningEffort,
      });
      const toolCalls = response.toolCalls || [];
      if (toolCalls.length > 0) {
        history.push(response.raw || {
          role: 'assistant',
          content: response.content || null,
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        });
        for (const call of toolCalls) {
          const tool = findTool(tools, call.name);
          const executed = tool
            ? await executeTool(tool, parseToolArguments(call.arguments))
            : { content: JSON.stringify({ ok: false, error: `unknown_tool:${call.name}` }), visionParts: null };
          history.push({
            role: 'tool',
            tool_call_id: call.id,
            content: truncateText(executed.content, 8000),
          });
          if (executed.visionParts?.length) {
            history.push({
              role: 'user',
              content: [
                { type: 'text', text: 'Изображение из read_chat_image.' },
                ...executed.visionParts,
              ],
            });
          }
        }
        continue;
      }

      const content = truncateText(response.content);
      return {
        content,
        steps: step + 1,
        messages: history,
      };
    }
    return {
      content: '',
      steps: maxSteps,
      messages: history,
      stopped: 'max_steps',
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_MAX_STEPS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_REPLY,
  truncateText,
  parseToolArguments,
  resolveAgentTimeoutMs,
  runAgent,
};
