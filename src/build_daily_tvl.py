#!/usr/bin/env python3
"""Phase 4: Build daily TVL time series from indexed SY events + prices.

Reads:
  data/tvl/sy_events/{mint}.jsonl  (supply deltas + exchange rates)
  data/tvl/prices.json             (daily USD prices)
  data/tvl/all_markets.json        (market metadata)

Writes:
  web/public/tvl-history.json
"""
import json, sys, os, glob
from datetime import datetime, timedelta, timezone
from collections import defaultdict
sys.path.insert(0, os.path.dirname(__file__))
from config import DATA_DIR

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVENTS_DIR = os.path.join(DATA_DIR, 'tvl', 'sy_events')
PRICES_PATH = os.path.join(DATA_DIR, 'tvl', 'prices.json')
MARKETS_PATH = os.path.join(DATA_DIR, 'tvl', 'all_markets.json')
CORRECTIONS_PATH = os.path.join(DATA_DIR, 'tvl', 'sy_corrections.json')
OUT = os.path.join(ROOT, 'web', 'public', 'tvl-history.json')
TOKEN_IDS_PATH = os.path.join(DATA_DIR, 'tvl', 'sy_token_ids.json')


def load_events(mint_short):
    """Load JSONL events for a SY mint, sorted by blockTime."""
    path = os.path.join(EVENTS_DIR, f'{mint_short}.jsonl')
    if not os.path.exists(path):
        return []
    events = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except:
                continue
    events.sort(key=lambda e: e.get('blockTime', 0))
    return events


def build_daily_supply(events, decimals):
    """From a list of events, build daily supply + exchange rate snapshots."""
    daily_supply = {}
    daily_rate = {}
    running_supply_raw = 0
    last_rate = None
    last_date = None

    for ev in events:
        bt = ev.get('blockTime')
        if not bt:
            continue
        date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
        running_supply_raw += ev.get('netDelta', 0)
        daily_supply[date] = running_supply_raw / (10 ** decimals)

        rate = ev.get('exchangeRate')
        if rate is not None and rate > 0:
            # Exponent emits exchange rate as u64 with 12 decimal precision
            last_rate = rate / 1e12
            daily_rate[date] = last_rate

    return daily_supply, daily_rate


def fill_forward(series, all_dates, default=None):
    """Fill forward a sparse date→value dict across all dates."""
    filled = {}
    last = default
    for d in all_dates:
        if d in series:
            last = series[d]
        filled[d] = last
    return filled


def main():
    markets = json.load(open(MARKETS_PATH))
    prices = json.load(open(PRICES_PATH))

    # Group markets by SY mint
    sy_to_markets = defaultdict(list)
    for m in markets:
        sy_to_markets[m['syMint']].append(m)

    # Determine the price feed key for each market
    # Load token identity map for unknown SY mints
    token_ids = {}
    if os.path.exists(TOKEN_IDS_PATH):
        token_ids = json.load(open(TOKEN_IDS_PATH))

    def price_key(m):
        qt = m.get('quoteTicker', '').upper()
        if qt in ('USD', 'USDC', 'USDT'):
            return 'USD'
        if qt in ('USX', 'EUSX'):
            return 'USD'
        if qt in ('XSOL',):
            return 'xSOL'
        if 'BTC' in qt:
            return 'BTC'
        if qt == 'SOL':
            return 'SOL'
        # Look up in token identity map
        tid = token_ids.get(m.get('syMint', ''), {})
        if tid.get('price'):
            return tid['price']
        # All tokens should be identified — log if we hit this
        print(f'  WARNING: no price feed for {m.get("key")} (sy={m.get("syMint","")[:16]})')
        return 'USD'

    # Load correction factors (anchor cumulated supply to on-chain truth)
    corrections = {}
    if os.path.exists(CORRECTIONS_PATH):
        corrections = json.load(open(CORRECTIONS_PATH))
        print(f'Loaded {len(corrections)} supply correction factors')

    # Build daily supply + rate for each unique SY mint
    print('Building daily supply curves...')
    sy_daily_supply = {}
    sy_daily_rate = {}
    all_dates_set = set()

    for sy, mkts in sy_to_markets.items():
        short = sy[:16]
        decimals = mkts[0].get('underlyingDecimals', 6)
        events = load_events(short)
        if not events:
            print(f'  {short}: no events')
            continue
        supply, rate = build_daily_supply(events, decimals)
        # Apply correction factor to anchor to on-chain supply
        correction = corrections.get(sy, 1.0)
        if correction != 1.0:
            supply = {d: v * correction for d, v in supply.items()}
        sy_daily_supply[sy] = supply
        sy_daily_rate[sy] = rate
        all_dates_set.update(supply.keys())
        cf = f' (corrected {correction:.4f})' if abs(correction - 1.0) > 0.001 else ''
        print(f'  {short}: {len(events)} events → {len(supply)} days{cf}')

    if not all_dates_set:
        print('No event data found. Run index_sy_transactions.py first.')
        return

    # Add price dates
    for pk in prices:
        all_dates_set.update(prices[pk].keys())

    all_dates = sorted(all_dates_set)
    print(f'\nDate range: {all_dates[0]} to {all_dates[-1]} ({len(all_dates)} days)')

    # Fill forward supply and rates
    print('Filling forward...')
    for sy in sy_daily_supply:
        sy_daily_supply[sy] = fill_forward(sy_daily_supply[sy], all_dates, default=0)
        default_rate = 1.0
        mkts = sy_to_markets[sy]
        if mkts and mkts[0].get('interfaceType') == 'one':
            default_rate = 1.0
        sy_daily_rate[sy] = fill_forward(sy_daily_rate.get(sy, {}), all_dates, default=default_rate)

    # Fill forward prices
    for pk in prices:
        prices[pk] = fill_forward(prices[pk], all_dates, default=None)

    # Compute daily TVL per market
    print('Computing daily TVL...')
    by_market = {}
    by_platform = defaultdict(lambda: [0.0] * len(all_dates))
    protocol_tvl = [0.0] * len(all_dates)

    for m in markets:
        sy = m['syMint']
        key = m['key']
        pk = price_key(m)
        platform = m.get('platform', 'Unknown')

        supply_series = sy_daily_supply.get(sy)
        rate_series = sy_daily_rate.get(sy)
        if not supply_series:
            continue

        tvl_series = []
        shared_markets = sy_to_markets[sy]
        for i, date in enumerate(all_dates):
            supply = supply_series.get(date, 0) or 0
            rate = rate_series.get(date, 1) or 1
            price = prices.get(pk, {}).get(date)
            if price is None or supply <= 0:
                tvl_series.append(0)
                continue

            mat_date = m.get('maturityDate', '9999-12-31')
            if date >= mat_date:
                tvl_series.append(0)
                continue

            # Dynamic split: count markets sharing this SY that are still active on this date
            active_on_date = sum(1 for sm in shared_markets if date < sm.get('maturityDate', '9999-12-31'))
            share = max(1, active_on_date)

            tvl = supply * rate * price / share
            tvl_series.append(round(tvl))

        by_market[key] = tvl_series
        for i, v in enumerate(tvl_series):
            protocol_tvl[i] += v
            by_platform[platform][i] += v

    # Round protocol totals
    protocol_tvl = [round(v) for v in protocol_tvl]
    for p in by_platform:
        by_platform[p] = [round(v) for v in by_platform[p]]

    # Filter out markets with no TVL ever
    by_market = {k: v for k, v in by_market.items() if max(v) > 0}

    # Build market metadata for the frontend
    market_meta = {}
    for m in markets:
        key = m['key']
        if key not in by_market:
            continue
        tvl_arr = by_market[key]
        peak_tvl = max(tvl_arr)
        peak_date = all_dates[tvl_arr.index(peak_tvl)] if peak_tvl > 0 else None
        market_meta[key] = {
            'platform': m.get('platform', ''),
            'ticker': m.get('underlyingTicker', key.split('-')[0]),
            'maturityDate': m.get('maturityDate', ''),
            'status': m.get('status', 'expired'),
            'peakTvl': round(peak_tvl),
            'peakDate': peak_date,
        }

    output = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'dates': all_dates,
        'protocol': protocol_tvl,
        'byMarket': by_market,
        'byPlatform': dict(by_platform),
        'marketMeta': market_meta,
    }

    json.dump(output, open(OUT, 'w'))
    print(f'\nWrote {OUT}')
    print(f'  {len(all_dates)} days, {len(by_market)} markets, {len(by_platform)} platforms')
    peak = max(protocol_tvl)
    peak_date = all_dates[protocol_tvl.index(peak)]
    current = protocol_tvl[-1]
    print(f'  Peak TVL: ${peak/1e6:.1f}M on {peak_date}')
    print(f'  Current TVL: ${current/1e6:.1f}M')


if __name__ == '__main__':
    main()
