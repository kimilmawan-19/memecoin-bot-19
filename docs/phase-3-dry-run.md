# Phase 3: FnZero dry-run boundary

Phase 3 adds an **offline preview**, not a trading client. `DryRunTradingAdapter`
defines `quote`, `getBalance`, `buy`, and `sell` in application-owned types.
`FnzeroDryRunAdapter` reads only constructor-supplied quote and balance fixtures.
`buy` and `sell` validate a proposed intent against those fixtures and return
`SIMULATED` with no signature. Nothing in the CLI constructs this adapter.
`ExecutionResult` remains reserved for a real submission lifecycle.

## Verified SDK reference

- Inspected [FnZero Node SDK source at commit
  `80c10dac4887ddbc6a729281dd93ea5bbf69ced4`](https://github.com/0xfnzero/sol-trade-sdk-nodejs/tree/80c10dac4887ddbc6a729281dd93ea5bbf69ced4);
  its package version is `sol-trade-sdk@0.1.5`. This commit and version are the
  **design reference**, not an installed runtime dependency.
- [`TradingClient`](https://github.com/0xfnzero/sol-trade-sdk-nodejs/blob/80c10dac4887ddbc6a729281dd93ea5bbf69ced4/src/index.ts)
  needs a `Keypair`, and `buy`/`sell` need protocol `extensionParams` plus a
  recent blockhash or durable nonce. `TradeResult.success` does not prove a
  confirmed fill. The SDK `simulate` option still enters its client/RPC path;
  Phase 3 never invokes it.
- The inspected public `TradingClient` has no general `quote()` method.
  Quote ownership remains a separate provider decision.
- Middleware can change instructions. A final post-middleware instruction and
  account validation hook has not been proven; this blocks a live FnZero adapter.
- The [published dependency manifest](https://github.com/0xfnzero/sol-trade-sdk-nodejs/blob/80c10dac4887ddbc6a729281dd93ea5bbf69ced4/package.json)
  includes Solana web3, gRPC, QUIC, cryptography, and serialization packages
  with ranged transitive versions. Before any installation, pin an exact
  package artifact, inspect its lockfile/SBOM and license notices, and review
  outbound destinations. No SDK package was installed in Phase 3.

## Preview mapping

| Domain field | Inert FnZero preview |
|---|---|
| `venue` | SDK `DexType` name for PumpFun, PumpSwap, Bonk, Raydium CPMM/AMM V4, or Meteora DAMM V2 |
| `intent.side` | `buy` or `sell` method name |
| `intent.mint` | Mint string; no `PublicKey` is constructed |
| `intent.amountRaw` | Exact integer converted to `number` only if within JavaScript safe-integer range |
| `intent.maxSlippageBps` | `slippageBasisPoints` |

The preview intentionally omits quote token type, `extensionParams`, blockhash, signer, and
final instruction validation. It is not a usable `TradeBuyParams` or
`TradeSellParams` object. Quote and balance fixtures must match the same
request, be fresh, and cover the proposed amount. Fixture fee values and
`maxFeeRaw` are both **lamports**; a future provider must prove that unit
before comparing them. Price impact and slippage are separate measures;
Phase 3 does not treat one as a substitute for the other.

A separate pure mapper accepts the SDK-like `TradeResult` shape as untrusted
data. It returns `SUBMITTED` only when a non-simulation success includes a
well-formed signature. Every other outcome stays `UNKNOWN` until external
reconciliation. It never emits `CONFIRMED`, fills, fees paid, or raw SDK errors.
This mapper is not called by the dry-run adapter.

## Security boundary and next gate

The dry-run port cannot authorize a transaction. There is no private key,
wallet connection, RPC call, SDK import, instruction builder, or transaction
submission. A future live port needs a runtime authorization issued only by
the deterministic token/portfolio/execution guard, plus final transaction
validation, confirmation, and reconciliation. The LLM must never receive that
capability. Phase 3 does not create this live port.

Run `pnpm test` and `pnpm typecheck`. Contract tests cover both preview
sides, stale/mismatched quotes, insufficient mock balance, fee and minimum
output limits, unsafe number conversion, and the absence of SDK/network
execution imports.
