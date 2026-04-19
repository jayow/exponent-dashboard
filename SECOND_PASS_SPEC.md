# Re-Index Spec — FINAL (One Pass To Rule Them All)

**This is the FINAL re-index. Extract EVERYTHING in one pass. No more re-indexes.**

**Scope:** 568K transactions across 35 SY mints, all 88 markets (12 active + 76 expired)
**Cost:** ~568K Helius credits (1 API key)
**Approach:** Single pass with `getTransaction(jsonParsed)`, parse ALL inner instructions

---

## Parser Fixes (bugs found in current enriched indexer)

### F1. Instruction detection — Exponent program invoke context
Bug: `GetAccountDataSize` from SPL Token masks real Exponent instructions (153K misclassified).
Fix: Only extract instructions within `ExponentnaRg3CQb...` invoke blocks in logs.

### F2. Market identification — full account + token resolution
Bug: 7,853 events (1.9%) have no market. 1,404 claims unresolvable.
Fix: Check all transaction account keys against known market/vault/pool addresses. Use inner instruction token mints for fallback.

### F3. Extended instruction map
Verify against Exponent core source code for complete instruction coverage.

---

## Extract Per Transaction (ALL fields)

```
{
  sig, blockTime, signer, instruction, action, market,

  // Token balance changes (pre/post)
  tokenChanges: { [mint]: { symbol, delta, decimals } },

  // Inner instruction parsing (NEW — the key addition)
  inner: {
    syMinted: number,          // SY created (deposit indicator)
    syBurned: number,          // SY destroyed (withdrawal indicator)
    ptBought: number,          // PT received from AMM
    ptSold: number,            // PT sent to AMM
    ptPrice: number,           // effective PT price in AMM swap
    ytReceived: number,        // YT from strip
    ytSent: number,            // YT burned/sold
    ytSpotPrice: number,       // derived: 1 - ptPrice
    lpMinted: number,          // LP tokens created
    lpBurned: number,          // LP tokens destroyed
    feeAmount: number,         // protocol fee extracted
    feeMint: string,           // fee token mint
    underlyingIn: number,      // underlying deposited
    underlyingOut: number,     // underlying withdrawn
  },

  // Derived
  impliedApy: number,          // ytSpotPrice / yearsToMaturity
  exchangeRate: number,        // from logs
  gasFee: number,              // meta.fee in lamports (for claim efficiency)
}
```

---

## Analytics: 34 Items

### ✅ Already Done (14 items — no re-index needed)
| # | Item |
|---|------|
| 3 | Trading volume protocol/platform/market + cumulative |
| 5 | Holder growth over time |
| 6 | User retention (new vs returning per week) |
| 7 | LP add/remove events (classified) |
| 8 | Trade frequency & size distribution |
| 9 | Whale activity (top 100 >$50K) |
| 12 | Claim activity per user (amounts, frequency) |
| 13 | Claims per market over time + cumulative |
| 14 | Claims per platform + cumulative |
| 15 | Claim frequency (daily/weekly/monthly/rare) |
| 22 | Yield earned per user (claim USD tracked) |
| 26 | Wallet lookup (events + USD, partial) |
| 27 | Market creation velocity |
| 28 | Average market lifespan (170d avg, 114d median) |

### ❌ Needs Re-Index (20 items)

#### Trading & Prices
| # | Item | What re-index provides |
|---|------|----------------------|
| 1 | Historical implied APY | ytSpotPrice from inner PT sale → APY per trade |
| 2 | YT/PT price history | ptPrice/ytSpotPrice at each trade timestamp |

#### Holders & Users
| # | Item | What re-index provides |
|---|------|----------------------|
| 4 | Historical holder rankings | Position open/close tracking per wallet |
| 32 | Historical top holders | Same as #4, aggregated |

#### Fees
| # | Item | What re-index provides |
|---|------|----------------------|
| 10 | Protocol fee revenue per market/platform | feeAmount from inner Transfer instructions |
| 11 | LP fee revenue per pool | Fee transfers within AMM swap inner instructions |

#### Claims & Yield
| # | Item | What re-index provides |
|---|------|----------------------|
| 16 | Unclaimed yields per wallet | Accurate claim totals to compare vs position × rate |

#### Position Analytics
| # | Item | What re-index provides |
|---|------|----------------------|
| 17 | Position duration | Track buyYt/sellYt timestamps per (wallet, market) |
| 18 | Market rollover | Cross-maturity wallet tracking (expired → new) |
| 19 | Strip/merge activity | Inner amounts for PT/YT split ratios |
| 20 | Redemption speed | Redemption timestamps vs maturity date |

#### User-Facing
| # | Item | What re-index provides |
|---|------|----------------------|
| 21 | User P&L per position | Entry ptPrice/ytPrice vs exit/current |
| 23 | Strategy comparison | PT vs YT vs LP returns with accurate pricing |
| 24 | Best entry windows | Historical ytSpotPrice to find cheapest entry |
| 25 | Claim efficiency | gasFee (meta.fee) vs claim USD |
| 31 | Position simulator | Historical ytSpotPrice for "what if" calculations |

#### Protocol-Wide
| # | Item | What re-index provides |
|---|------|----------------------|
| 29 | TVL retention rate | Cross-maturity wallet + TVL tracking |
| 30 | Organic vs incentivized TVL | Emission token classification in claims |

#### Bug Fixes
| # | Item | What re-index provides |
|---|------|----------------------|
| 33 | 1,404 unknown market claims | Exponent program context in logs |
| 34 | Accurate YT/PT spot price | Inner instruction PT sale parsing |

---

## Implementation Strategy

### Inner Instruction Parsing
For each Exponent program instruction, parse ALL inner instructions:
1. `spl-token MintTo` → identify mint (SY vs LP) by checking mint address
2. `spl-token Burn` → SY or LP burning
3. `spl-token Transfer` → categorize by to/from:
   - To protocol fee account → fee
   - To/from AMM pool → PT/underlying swap
   - To signer → underlying/yield withdrawal
4. Derive ptPrice from AMM Transfer amounts (underlying_amount / pt_amount)
5. Derive ytSpotPrice = 1 - ptPrice

### Fee Detection
1. Check Exponent source for fee collection account addresses
2. Or detect: Transfer instructions to accounts that aren't signer, pool, or vault

### Position Lifecycle Tracking
Track per (wallet, market, type):
- Open event: first buyYt/buyPt/addLiq
- Close event: sellYt/sellPt/removeLiq/redeemPt that brings balance to 0
- Duration = close.blockTime - open.blockTime
- P&L = exit_value - entry_value + claims_collected

### Gas Cost Extraction
`meta.fee` field in every transaction (in lamports, divide by 1e9 for SOL)

### Market Rollover Detection
For each wallet:
1. Find redeemPt/sellYt events in expired markets
2. Find buyYt/buyPt events in same-underlying newer markets within 7 days
3. Flag as rollover, track % of TVL that rolls

### Emission Classification
Tokens received in claimYield that are NOT SY/PT/YT/underlying = emission rewards
Already partially done (SWTCH, JTO detection), formalize in re-index

---

## Output Format
- `data/index/final/{sy_mint}.jsonl` — one line per tx with ALL fields
- Replaces `data/index/enriched/` — this is the definitive index
- Build scripts aggregate into analytics JSON files
- Daily refresh appends new transactions incrementally

## Cost & Timeline
- 568K transactions × 1 credit = 568K credits
- Dual-RPC (2+ Helius keys) at 12 workers = ~4-5 hours
- One-time cost, then daily refresh is incremental
