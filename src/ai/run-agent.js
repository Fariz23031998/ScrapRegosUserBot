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

function parseToolResultContent(content) {
  const text = String(content || '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function summarizeToolResult(content) {
  const parsed = parseToolResultContent(content);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const ok = parsed.ok !== false && !parsed.error;
    return {
      result: parsed,
      ok,
      error: ok ? null : String(parsed.error || 'tool_failed'),
    };
  }
  return { result: parsed, ok: true, error: null };
}

function findTool(tools, name) {
  return (tools || []).find((tool) => tool.name === name) || null;
}

function prependUserContext(messages, content) {
  const list = Array.isArray(messages) ? [...messages] : [];
  const text = String(content || '').trim();
  if (!text) return list;
  return [{ role: 'user', content: text }, ...list];
}

function buildPromptCacheKey(kind, id) {
  const slug = String(kind || '').trim();
  if (!slug) return '';
  if (id == null || String(id).trim() === '') return slug;
  return `${slug}:${String(id).trim()}`;
}

function logPromptCache({ model, promptCacheKey, step, usage } = {}) {
  if (!usage) return;
  const write = usage.cache_write_tokens != null ? ` write=${usage.cache_write_tokens}` : '';
  console.info(
    `[ai] prompt-cache model=${model || '-'} key=${promptCacheKey || '-'} step=${step} prompt=${usage.prompt_tokens} cached=${usage.cached_tokens}${write}`
  );
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
  promptCacheKey,
  onDelta,
} = {}) {
  const impl = provider || getProvider(providerName || 'openai');
  if (!impl || typeof impl.chat !== 'function') {
    throw new Error('AI provider is not available');
  }

  const limitMs = resolveAgentTimeoutMs(model, { timeoutMs, hasVision, hasAudio });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(limitMs) || DEFAULT_TIMEOUT_MS));
  const history = [];
  const trace = [];
  if (system) {
    history.push({ role: 'system', content: String(system) });
  }
  for (const message of messages || []) {
    history.push(message);
  }
  let lastUsage = null;

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
        promptCacheKey,
        onDelta,
      });
      lastUsage = response.usage || lastUsage;
      logPromptCache({
        model,
        promptCacheKey,
        step: step + 1,
        usage: response.usage,
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
        const tracedCalls = [];
        for (const call of toolCalls) {
          const tool = findTool(tools, call.name);
          const args = parseToolArguments(call.arguments);
          const executed = tool
            ? await executeTool(tool, args)
            : { content: JSON.stringify({ ok: false, error: `unknown_tool:${call.name}` }), visionParts: null };
          const truncated = truncateText(executed.content, 8000);
          history.push({
            role: 'tool',
            tool_call_id: call.id,
            content: truncated,
          });
          const summary = summarizeToolResult(truncated);
          tracedCalls.push({
            id: call.id,
            name: call.name,
            arguments: args,
            result: summary.result,
            ok: summary.ok,
            error: summary.error,
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
        trace.push({
          step: step + 1,
          type: 'tool_round',
          assistant_content: response.content || null,
          tool_calls: tracedCalls,
        });
        continue;
      }

      const content = truncateText(response.content);
      trace.push({
        step: step + 1,
        type: 'final',
        content,
      });
      return {
        content,
        steps: step + 1,
        messages: history,
        usage: lastUsage,
        trace,
      };
    }
    trace.push({
      step: maxSteps,
      type: 'final',
      content: '',
      stopped: 'max_steps',
    });
    return {
      content: '',
      steps: maxSteps,
      messages: history,
      stopped: 'max_steps',
      usage: lastUsage,
      trace,
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
  prependUserContext,
  buildPromptCacheKey,
  runAgent,
};
