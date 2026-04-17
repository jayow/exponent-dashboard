export type MarketMeta = {
  key: string;
  ticker: string;
  platform: string;
  maturity: string;
  tvl: number;
};

export type WalletRow = {
  addr: string;
  farm:   { buyYt: number; sellYt: number; claimYield: number };
  lp:     { addLiq: number; removeLiq: number };
  income: { buyPt: number; sellPt: number; strip: number; redeemPt: number };
  byMarket: Record<string, number>;
  totalVolume: number;
  farmNet: number;
  lpNet: number;
  txs: number;
};

export type Dataset = {
  generatedAt: string;
  markets: MarketMeta[];
  totals: {
    wallets: number;
    markets: number;
    farmBuys: number;
    farmSells: number;
    farmClaims: number;
    lpAdds: number;
    lpRemoves: number;
  };
  wallets: WalletRow[];
};

export type TradeEvent = {
  sig: string;
  blockTime: number;
  market: string;
  signer: string;
  action: string;
  instr?: string;
  ytDelta: number;
  underlyingDelta: number;
  usdNet: number;
};
