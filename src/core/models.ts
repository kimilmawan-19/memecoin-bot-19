// Core contracts contain no provider payload, SDK class, wallet, or signer.
// Raw token amounts are decimal strings. Percentages use basis points (0..10_000);
// changes may be negative and ratios may exceed 10_000.
// Times are UTC ISO-8601 strings. Null means unavailable, never zero.
export type IsoTime = string;
export type BaseUnits = string;
export type SignedBaseUnits = string;
export type BasisPoints = number;
export type ChangeBps = number;
export type RatioBps = number;

export type Evidence = Readonly<{
  sourceIds: readonly string[];
  observedAt: IsoTime;
  coverageBps: BasisPoints;
  confidenceBps: BasisPoints;
}>;

export type TokenCandidate = Readonly<{
  id: string;
  chain: 'solana';
  mint: string;
  discoveredAt: IsoTime;
  sourceId: string;
  evidenceIds: readonly string[];
}>;

export type OrganicMetrics = Evidence & Readonly<{
  organicScore: BasisPoints | null;
  organicBuyerCount: number | null;
  organicBuyerGrowthBps: ChangeBps | null;
  organicBuyVolumeRaw: BaseUnits | null;
  organicSellVolumeRaw: BaseUnits | null;
  organicNetFlowRaw: SignedBaseUnits | null;
  organicVolumeAccelerationBps: ChangeBps | null;
}>;

export type WalletQualityMetrics = Evidence & Readonly<{
  freshWalletBps: BasisPoints | null;
  fundedWalletClusters: number | null;
  repeatedBuyPatternBps: BasisPoints | null;
  smartMoneyPresence: number | null;
}>;

export type ManipulationMetrics = Evidence & Readonly<{
  bundleConcentrationBps: BasisPoints | null;
  botHolderBps: BasisPoints | null;
  washTradingProbabilityBps: BasisPoints | null;
  commonFunderClusters: number | null;
  repetitiveTradeSizesBps: BasisPoints | null;
  suspiciousRoundTrips: number | null;
}>;

export type HolderMetrics = Evidence & Readonly<{
  holderGrowthBps: ChangeBps | null;
  top10Bps: BasisPoints | null;
  devHoldingBps: BasisPoints | null;
  whaleConcentrationBps: BasisPoints | null;
}>;

export type LiquidityMetrics = Evidence & Readonly<{
  liquidityQuoteRaw: BaseUnits | null;
  liquidityGrowthBps: ChangeBps | null;
  volumeToLiquidityBps: RatioBps | null;
  priceImpactBps: BasisPoints | null;
}>;

export type TokenIntelligence = Readonly<{
  candidateId: string;
  snapshotId: string;
  asOf: IsoTime;
  organic: OrganicMetrics;
  wallets: WalletQualityMetrics;
  manipulation: ManipulationMetrics;
  holders: HolderMetrics;
  liquidity: LiquidityMetrics;
  evidenceIds: readonly string[];
  conflictFields?: readonly string[];
}>;

export type TokenRiskAssessment = Readonly<{
  candidateId: string;
  policyVersion: string;
  status: 'PASS' | 'REJECT' | 'UNKNOWN';
  reasons: readonly string[];
  checkedAt: IsoTime;
  evidenceIds: readonly string[];
}>;

export type OpportunityScore = Readonly<{
  candidateId: string;
  scoreVersion: string;
  value: number | null;
  components: Readonly<Record<string, number | null>>;
  eligible: boolean;
  evidenceIds: readonly string[];
}>;

// LLM output is an untrusted proposal. BUY here grants no transaction authority.
export type ScreenerProposal = Readonly<{
  candidateId: string;
  snapshotId: string;
  action: 'BUY' | 'SKIP';
  rationale: string;
  risks: readonly string[];
  evidenceIds: readonly string[];
  modelVersion: string;
  promptVersion: string;
  createdAt: IsoTime;
  expiresAt: IsoTime;
}>;

export type OpenPosition = Readonly<{
  id: string;
  mint: string;
  walletId: string;
  status: 'OPEN' | 'EXIT_PENDING' | 'UNRESOLVED';
  quantityRaw: BaseUnits;
  costQuoteRaw: BaseUnits;
  openedAt: IsoTime;
  entrySignature: string;
  version: number;
}>;

export type PositionProposal = Readonly<{
  positionId: string;
  positionVersion: number;
  action: 'HOLD' | 'REDUCE' | 'EXIT';
  reduceBps: BasisPoints | null;
  rationale: string;
  evidenceIds: readonly string[];
  createdAt: IsoTime;
  expiresAt: IsoTime;
}>;

// Shape only. A future deterministic guard must create the authorization.
export type ExecutionIntent = Readonly<{
  id: string;
  side: 'BUY' | 'SELL';
  mint: string;
  amountRaw: BaseUnits;
  minOutputRaw: BaseUnits;
  maxFeeRaw: BaseUnits;
  maxSlippageBps: BasisPoints;
  policyVersion: string;
  expiresAt: IsoTime;
}>;

export type QuoteRequest = Readonly<{
  id: string;
  inputMint: string;
  outputMint: string;
  amountInRaw: BaseUnits;
  maxSlippageBps: BasisPoints;
  requestedAt: IsoTime;
}>;

export type QuoteResult = Readonly<{
  requestId: string;
  expectedOutputRaw: BaseUnits;
  minOutputRaw: BaseUnits;
  estimatedFeeRaw: BaseUnits;
  priceImpactBps: BasisPoints | null;
  observedAt: IsoTime;
  expiresAt: IsoTime;
  evidenceIds: readonly string[];
}>;

export type BalanceSnapshot = Readonly<{
  walletId: string;
  mint: string;
  amountRaw: BaseUnits;
  observedAt: IsoTime;
  sourceId: string;
}>;

export type ExecutionResult = Readonly<{
  intentId: string;
  status: 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN';
  signatures: readonly string[];
  inputFilledRaw: BaseUnits | null;
  outputFilledRaw: BaseUnits | null;
  feePaidRaw: BaseUnits | null;
  confirmedAt: IsoTime | null;
}>;

export type ClosedTrade = Readonly<{
  id: string;
  positionId: string;
  openedAt: IsoTime;
  closedAt: IsoTime;
  realizedPnlQuoteRaw: SignedBaseUnits;
  reconciled: boolean;
  evidenceIds: readonly string[];
}>;

export type Lesson = Readonly<{
  id: string;
  version: number;
  status: 'PROPOSED' | 'APPROVED' | 'REJECTED';
  rule: string;
  supportingTradeIds: readonly string[];
  counterexampleTradeIds: readonly string[];
  proposedAt: IsoTime;
}>;
