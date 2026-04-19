# Second-Pass Indexer Spec — Full Exponent Protocol Index

**Scope:** 568K transactions across 35 SY mints, all 88 markets (12 active + 76 expired)
**Cost:** ~568K Helius credits (1 API key)
**Approach:** Single pass, extract ALL fields per transaction into enriched JSONL

## Extract per transaction:
- Wallet address (signer)
- Instruction type (buyYt/sellYt/buyPt/sellPt/addLiq/removeLiq/claimYield/strip/merge/redeem)
- Market key
- Token amounts (YT/PT/SY/underlying deltas)
- YT/PT price at trade
- Fee amounts
- Timestamp

## Analytics to build (32 items):

### Trading & Prices (1-3)
1. Historical implied APY per market (from YT/PT trade prices)
2. YT/PT price history per market
3. Trading volume per market/platform/protocol

### Holders & Users (4-9)
4. Historical holder rankings (biggest positions over time)
5. Holder growth over time (unique wallets per day)
6. User retention (new vs returning depositors per week)
7. LP add/remove events (who, when, how much)
8. Trade frequency & average size per market
9. Whale activity (large trades + market impact)

### Fees (10-11)
10. Protocol fee revenue per market/platform
11. LP fee revenue per pool

### Claims & Yield (12-16)
12. Claim activity per user (amounts, frequency)
13. Claims per market over time
14. Claims per platform
15. Claim frequency analysis (daily/weekly/accumulate)
16. Unclaimed yields per wallet/market (positions × rate - claimed)

### Position Analytics (17-20)
17. Position duration (avg hold time per market/strategy)
18. Market rollover (users moving expired → new maturity)
19. Strip/merge activity (yield strategy behavior)
20. Redemption speed post-maturity (% redeemed within 1d/7d/30d)

### User-Facing (21-26)
21. User P&L per position (entry price vs current + yield)
22. Yield earned per user (total across all positions)
23. Strategy comparison (PT vs YT vs LP returns per market)
24. Best entry windows (YT cheapest vs actual yield)
25. Claim efficiency (gas cost vs compound benefit)
26. Wallet lookup enrichment (full P&L + claim history)

### Protocol-Wide (27-32)
27. Market creation velocity (new markets per month)
28. Average market lifespan
29. TVL retention rate (% rolling into next maturity)
30. Organic vs incentivized TVL
31. Position simulator ("if I bought YT on date X...")
32. Historical top holders (who held the most at any point)

## Output format:
- `data/index/enriched_events/{sy_mint}.jsonl` — one line per tx with all fields
- Build scripts aggregate into analytics JSON files for frontend
- Daily refresh appends new transactions incrementally

### Added during analytics-1 development

33. Resolve remaining 1,404 unknown market claims (need Exponent program context from logs)
34. Derive accurate YT/PT spot price from inner instructions (parse internal PT sale within buyYt/sellYt for true AMM price → per-trade implied APY)
