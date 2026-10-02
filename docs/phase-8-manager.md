# Phase 8 — Position Manager (fixture/dry-run)

Phase 8 adds a review path for an open position, a deterministic exit monitor,
an advisory LLM Manager, a separate SELL simulation guard, and a pure fixture
reconciliation function. It does not schedule cycles, connect a wallet, sign,
submit, or confirm a transaction. The default CLI still produces `SKIP`.

## Decision order

1. `positions/monitor.ts` validates a versioned position and fresh fixture
   observation. It triggers `EXIT` for verified dev sell, liquidity below the
   configured floor, stop loss, trailing stop, maximum hold, or take profit.
   Missing critical facts produce `UNKNOWN` and a deterministic `HOLD`.
2. `application/manage.ts` skips the LLM on a hard exit. Otherwise it asks the
   bounded Manager for `HOLD`, `REDUCE`, or `EXIT`, then rechecks the monitor
   after model latency. Timeout, invalid schema, stale evidence, or a changed
   position version results in `HOLD`; a newly triggered hard exit wins.
3. `agents/manager/` sends only normalized position and market facts. Wallet
   identifiers, entry signatures, provider payloads, and execution objects are
   excluded. The model receives no tools or policy authority.
4. `risk/sell-guard.ts` checks proposal binding, position version, exact
   reduction amount, quote freshness, slippage, fee, price impact, token
   balance, allowed fixture program IDs, and one-use intent reservations.
   BUY exposure and daily-loss caps are not applied to exits.
5. `application/simulate-sell.ts` obtains one quote and balance snapshot and
   passes the same immutable facts to the synchronous FnZero dry-run preview.
   It projects only allowlisted preview fields back to the caller.

`PREVIEWED` means an inert adapter preview. `BLOCKED` means no preview. A
missing quote/balance or ambiguous adapter result is `UNRESOLVED`. These are
review results, not persisted position or order states. A preview is never
interpreted as a fill, and this phase does not mutate an open position.

## Confirmed-fill fixture contract

`positions/reconcile.ts` accepts only a normalized `FIXTURE` proof tied to a
pending position's exact exit intent and version. It verifies a confirmed
signature, filled quantity, remaining token balance, proceeds, and fee in quote
base units. A partial fill retains an open position at a new version, scaled
cost and peak, and cumulative realized PnL. A full fill emits a reconciled
closed trade. Unknown or submitted receipts cannot enter this function.

This pure transition does not persist data. A future authoritative ledger must
atomically save the versioned result and reject replayed proofs. A future live
reconciler must verify the signature, token balance, proceeds, fees, and mint
from on-chain state before constructing this normalized proof.

## Verification and limits

Run `node --test tests/manager.test.ts`, `pnpm test`, and `pnpm typecheck`.
The tests cover hard-exit precedence, LLM timeout and malformed output,
version/evidence binding, quote and balance failures, duplicate intents,
REDUCE sizing, partial/full confirmed fixture fills, and preview field
projection. No real API key, wallet, SDK signer, or transaction sender is used.

The stop/take-profit/trailing/max-hold thresholds in tests are synthetic.
The observation's valuation and dev-sell flag are fixtures, not verified chain
facts. The position's peak and the intent/order state must eventually come
from durable versioned storage; this phase has no scheduler, durable
reservation, automatic retry, or paper-trading orchestration. A missing route
cannot be solved by an LLM decision, and the application must retain the
position until a trusted reconciliation proves a fill. Live exits additionally
need final serialized-instruction validation and operator controls.
