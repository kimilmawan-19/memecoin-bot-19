import type { LlmMessage, LlmProvider } from './provider.ts';

const ENDPOINTS = Object.freeze({
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions'
});
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;

export type ChatProviderConfig = Readonly<{
  service: keyof typeof ENDPOINTS;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  maxCompletionTokens?: number;
  // Tests inject a transport. The application never supplies this from an LLM.
  fetchFn?: typeof fetch;
}>;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid LLM response');
  }
  return value as Record<string, unknown>;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') ||
      !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error('LLM provider unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('LLM response too large');
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error('LLM response unavailable');
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

// Optional provider: no caller in the fixture CLI constructs this class.
// Fixed HTTPS endpoints, no redirects, no response logging, no retries.
export class ChatCompletionsProvider implements LlmProvider {
  private readonly service: keyof typeof ENDPOINTS;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxCompletionTokens: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: ChatProviderConfig) {
    if (!Object.hasOwn(ENDPOINTS, config.service) ||
        typeof config.model !== 'string' || !/^[a-zA-Z0-9._:/+-]{1,128}$/.test(config.model) ||
        typeof config.apiKey !== 'string' || config.apiKey.length < 1 ||
        config.apiKey.length > 512 || /[\r\n\x00-\x1f]/.test(config.apiKey)) {
      throw new Error('Invalid LLM configuration');
    }
    const timeout = config.timeoutMs ?? 8_000;
    const tokens = config.maxCompletionTokens ?? 512;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000 ||
        !Number.isSafeInteger(tokens) || tokens < 64 || tokens > 1_024) {
      throw new Error('Invalid LLM limits');
    }
    this.service = config.service;
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.timeoutMs = timeout;
    this.maxCompletionTokens = tokens;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  async completeJson(messages: readonly LlmMessage[], schema: Readonly<Record<string, unknown>>,
    signal?: AbortSignal): Promise<unknown> {
    if (messages.length !== 2 || messages[0]?.role !== 'system' ||
        messages[1]?.role !== 'user' || messages.some((item) =>
          typeof item.content !== 'string' || item.content.length === 0)) {
      throw new Error('Invalid LLM request');
    }
    const body = JSON.stringify({
      model: this.model, messages, stream: false, n: 1,
      max_completion_tokens: this.maxCompletionTokens, tool_choice: 'none',
      response_format: { type: 'json_schema', json_schema: {
        name: 'agent_decision', strict: true, schema
      } },
      ...(this.service === 'openrouter' ? { provider: { require_parameters: true } } : {})
    });
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) throw new Error('LLM request too large');
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await this.fetchFn(ENDPOINTS[this.service], {
        method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body, signal: combined
      });
      const payload = record(await boundedJson(response));
      if (!Array.isArray(payload.choices) || payload.choices.length !== 1) {
        throw new Error('Invalid LLM response');
      }
      const choice = record(payload.choices[0]);
      const message = record(choice.message);
      if (choice.finish_reason !== 'stop' || message.role !== 'assistant' ||
          typeof message.content !== 'string' || message.content.length > 16_384 ||
          message.refusal || Object.hasOwn(message, 'tool_calls') ||
          Object.hasOwn(message, 'function_call')) throw new Error('Invalid LLM response');
      return JSON.parse(message.content) as unknown;
    } catch {
      // Never propagate provider error bodies, URLs, headers, or raw model output.
      throw new Error('LLM provider failed');
    }
  }
}
