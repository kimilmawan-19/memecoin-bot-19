export type LlmMessage = Readonly<{ role: 'system' | 'user'; content: string }>;

// The Screener gets JSON text only. There is deliberately no tool or execution
// capability in this port.
export interface LlmProvider {
  completeJson(messages: readonly LlmMessage[], schema: Readonly<Record<string, unknown>>,
    signal?: AbortSignal): Promise<unknown>;
}
