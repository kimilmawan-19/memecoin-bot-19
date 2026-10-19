const SAFE_FAILURES = new Set([
  'Invalid cycle time',
  'Invalid Helius API key configuration',
  'Invalid Helius request',
  'Helius RPC unavailable',
  'Invalid Helius cluster response',
  'Invalid Helius slot response',
  'Helius endpoint is not Solana mainnet',
  'Discovery RPC requires a plain HTTPS endpoint',
  'Discovery RPC unavailable',
  'Discovery RPC response too large',
  'Discovery RPC response unavailable or too large',
  'Invalid discovery RPC response',
  'Invalid discovery query',
  'Invalid discovery signature',
  'Invalid signature page',
  'Invalid signature row',
  'Invalid discovery signature page',
  'Invalid discovery instruction data',
  'Invalid PumpSwap program account',
  'Invalid discovery pool account',
  'Invalid discovery pool accounts',
  'Invalid discovery mint account',
  'Invalid discovery transaction',
  'Invalid discovery inner instructions',
  'Discovery signature slot mismatch',
  'Discovery index capacity reached',
  'Discovery cursor gap; backfill required',
  'Discovery transaction unavailable; retry later',
  'Discovery transaction mismatch',
  'Discovery poll already running',
  'Invalid discovery batch limit',
  'Invalid local discovery checkpoint',
  'Unable to read local discovery checkpoint',
  'Unable to save local discovery checkpoint',
  'Invalid discovery cursor state',
  'Invalid discovery checkpoint time',
  'Unable to create local discovery lock',
  'Discovery poll is already running or a stale local lock needs review'
]);

// Internal errors have fixed messages. Unknown errors are included only after
// redacting keys, URLs, paths, and token-like strings; stack traces are omitted.
export function safePollFailureDetail(error: unknown, apiKey?: string): string {
  if (!(error instanceof Error)) return 'unexpected non-Error failure';
  if (SAFE_FAILURES.has(error.message)) return error.message;

  const name = /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : 'Error';
  let message = error.message;
  if (apiKey) message = message.split(apiKey).join('[redacted key]');
  message = message
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/\b(api[-_]?key|token|secret|authorization)\b\s*[:=]\s*[^&\s,;]+/gi, '$1=[redacted]')
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, '[redacted path]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted token]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 160);
  return message ? `unexpected ${name}: ${message}` : `unexpected ${name}`;
}
