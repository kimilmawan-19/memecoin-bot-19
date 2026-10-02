import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpDiscoveryRpc } from '../src/providers/solana/discovery-rpc.ts';
import { PUMP_PROGRAM } from '../src/discovery/parse-transaction.ts';
import { ChatCompletionsProvider } from '../src/llm/chat-completions.ts';

test('RPC and LLM cancel rejected and oversized response streams', async () => {
  for (const service of ['rpc', 'llm']) {
    for (const scenario of ['429', '500', 'content-type', 'oversize']) {
      let cancelled = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(scenario === 'oversize' ? 600 * 1024 : 1)); },
        cancel() { cancelled++; }
      });
      const response = new Response(body, {
        status: scenario === '429' ? 429 : scenario === '500' ? 500 : 200,
        headers: { 'content-type': scenario === 'content-type' ? 'text/plain' : 'application/json' }
      });
      const fetchFn: typeof fetch = async () => response;
      const request = service === 'rpc'
        ? new HttpDiscoveryRpc('https://rpc.example.test', fetchFn).signatures(PUMP_PROGRAM, 1)
        : new ChatCompletionsProvider({ service: 'openai', model: 'test', apiKey: 'not-a-real-key',
          fetchFn }).completeJson([{ role: 'system', content: 'test' }, { role: 'user', content: 'test' }], {});
      await assert.rejects(request);
      assert.equal(cancelled, 1, service + ':' + scenario);
      assert.equal(body.locked, false);
    }
  }
});
