import { HttpDiscoveryRpc } from './discovery-rpc.ts';
import type { DiscoveryRpc } from '../../discovery/poll.ts';

export const HELIUS_MAINNET_ENDPOINT = 'https://mainnet.helius-rpc.com/';
export const SOLANA_MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export type HeliusMainnetStatus = Readonly<{
  genesisHash: string;
  finalizedSlot: number;
}>;

export interface HeliusReadOnlyPort {
  readonly discovery: DiscoveryRpc;
  status(): Promise<HeliusMainnetStatus>;
}

function validateApiKey(apiKey: string): void {
  if (typeof apiKey !== 'string' || apiKey.length < 1 || apiKey.length > 512 ||
      !/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new Error('Invalid Helius API key configuration');
  }
}

async function readResult(response: Response): Promise<unknown> {
  if (!response.ok || !response.body ||
      !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Helius RPC unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Helius RPC response too large');
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error('Helius RPC unavailable');
  } finally {
    reader.releaseLock();
  }
  let document: unknown;
  try {
    document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Helius RPC unavailable');
  }
  if (!document || typeof document !== 'object' || Array.isArray(document) ||
      !('result' in document) || 'error' in document) {
    throw new Error('Helius RPC unavailable');
  }
  return document.result;
}

// The only credentialed URL is created in memory for the outbound request.
// Callers never receive it, and errors deliberately omit response bodies and URLs.
export class HeliusReadOnlyClient implements HeliusReadOnlyPort {
  readonly discovery: HttpDiscoveryRpc;
  private readonly fetcher: typeof fetch;

  constructor(apiKey: string, fetcher: typeof fetch = fetch) {
    validateApiKey(apiKey);
    const keyedFetch: typeof fetch = async (input, init) => {
      let url: URL;
      try {
        url = input instanceof Request ? new URL(input.url) :
          input instanceof URL ? new URL(input.href) : new URL(input);
      } catch {
        throw new Error('Invalid Helius request');
      }
      if (url.origin !== 'https://mainnet.helius-rpc.com' || url.pathname !== '/' ||
          url.username || url.password || url.search || url.hash) {
        throw new Error('Invalid Helius request');
      }
      url.searchParams.set('api-key', apiKey);
      return fetcher(url, init);
    };
    this.fetcher = keyedFetch;
    this.discovery = new HttpDiscoveryRpc(HELIUS_MAINNET_ENDPOINT, keyedFetch);
  }

  private async call(method: 'getGenesisHash' | 'getSlot', params: unknown[]): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(HELIUS_MAINNET_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      });
    } catch {
      throw new Error('Helius RPC unavailable');
    }
    return readResult(response);
  }

  async status(): Promise<HeliusMainnetStatus> {
    const genesisHash = await this.call('getGenesisHash', []);
    if (typeof genesisHash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(genesisHash)) {
      throw new Error('Invalid Helius cluster response');
    }
    const finalizedSlot = await this.call('getSlot', [{ commitment: 'finalized' }]);
    if (!Number.isSafeInteger(finalizedSlot) || (finalizedSlot as number) < 0) {
      throw new Error('Invalid Helius slot response');
    }
    return { genesisHash, finalizedSlot: finalizedSlot as number };
  }
}
