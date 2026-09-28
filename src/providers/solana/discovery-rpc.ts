import type { DiscoveryRpc, SignatureInfo } from '../../discovery/poll.ts';
import { validSolanaAddress } from '../../input.ts';
import { PUMP_PROGRAM, RAYDIUM_CPMM_PROGRAM } from '../../discovery/parse-transaction.ts';

const MAX_RESPONSE_BYTES = 512 * 1024;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

function isSignature(value: unknown): value is string {
  return typeof value === 'string' && BASE58.test(value);
}

// Only two finalized, read-only JSON-RPC methods are exposed. Errors never
// include remote response bodies or URL credentials.
export class HttpDiscoveryRpc implements DiscoveryRpc {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;

  constructor(endpoint: string, fetcher: typeof fetch = fetch) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error('Discovery RPC requires a plain HTTPS endpoint');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
      throw new Error('Discovery RPC requires a plain HTTPS endpoint');
    }
    this.endpoint = url.toString();
    this.fetcher = fetcher;
  }

  private async call(method: 'getSignaturesForAddress' | 'getTransaction', params: unknown[]): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      });
    } catch {
      throw new Error('Discovery RPC unavailable');
    }
    if (!response.ok || !response.body) throw new Error('Discovery RPC unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error('Discovery RPC response too large');
        chunks.push(value);
      }
    } catch {
      throw new Error('Discovery RPC response unavailable or too large');
    } finally {
      reader.releaseLock();
    }
    let document: unknown;
    try {
      document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error('Invalid discovery RPC response');
    }
    if (!document || typeof document !== 'object' || Array.isArray(document) ||
        !('result' in document) || 'error' in document) {
      throw new Error('Invalid discovery RPC response');
    }
    return document.result;
  }

  async signatures(program: string, limit: number): Promise<readonly SignatureInfo[]> {
    if ((program !== PUMP_PROGRAM && program !== RAYDIUM_CPMM_PROGRAM) ||
        !validSolanaAddress(program) || !Number.isInteger(limit) || limit < 1 || limit > 101) {
      throw new Error('Invalid discovery query');
    }
    const result = await this.call('getSignaturesForAddress',
      [program, { commitment: 'finalized', limit }]);
    if (!Array.isArray(result) || result.length > limit) throw new Error('Invalid signature page');
    return result.map((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid signature row');
      const row = raw as Record<string, unknown>;
      if (!isSignature(row.signature) || !Number.isSafeInteger(row.slot) ||
          (row.slot as number) < 0 || (row.err !== null &&
          (!row.err || typeof row.err !== 'object' || Array.isArray(row.err)))) {
        throw new Error('Invalid signature row');
      }
      return { signature: row.signature, slot: row.slot as number, err: row.err };
    });
  }

  async transaction(signature: string): Promise<unknown | null> {
    if (!isSignature(signature)) throw new Error('Invalid discovery signature');
    return this.call('getTransaction', [signature, {
      commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1
    }]);
  }
}
