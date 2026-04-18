#!/usr/bin/env python3
"""Phase 3b: Fetch historical daily USD prices for all assets.

Uses DeFiLlama chart API (free, unlimited history) for SOL and BTC.
Derives other prices: xSOL from SOL ratio, stablecoins = $1.
For unknown expired tokens: 6-decimal = USD, 9-decimal = SOL-priced.

Writes data/tvl/prices.json
"""
import json, sys, os, time
import requests
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(__file__))
from config import DATA_DIR

OUT = os.path.join(DATA_DIR, 'tvl', 'prices.json')
LLAMA_BASE = 'https://coins.llama.fi'


def defillama_chart(token_key, start_ts, total_days=570):
    """Fetch daily prices from DeFiLlama chart API in chunks."""
    prices = {}
    chunk = 180
    ts = start_ts
    while total_days > 0:
        span = min(chunk, total_days)
        url = f'{LLAMA_BASE}/chart/{token_key}?start={ts}&span={span}&period=1d'
        date_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y-%m-%d')
        try:
            resp = requests.get(url, headers={'User-Agent': 'curl/8.7.1'}, timeout=30)
            if resp.ok:
                data = resp.json()
                coin_data = data.get('coins', {}).get(token_key, {}).get('prices', [])
                for entry in coin_data:
                    d = datetime.fromtimestamp(entry['timestamp'], tz=timezone.utc).strftime('%Y-%m-%d')
                    prices[d] = round(entry['price'], 4)
        except Exception as e:
            print(f'    Chunk from {date_str} failed: {e}')
        ts += span * 86400
        total_days -= span
        time.sleep(1)
    print(f'  {token_key.split(":")[-1][:12]}...: {len(prices)} daily prices')
    return prices


def coingecko_token_price(mint_addr):
    """Get current price for a Solana token via CoinGecko."""
    try:
        url = f'https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses={mint_addr}&vs_currencies=usd'
        resp = requests.get(url, headers={'User-Agent': 'curl/8.7.1'}, timeout=15)
        if resp.ok:
            d = resp.json()
            if d.get(mint_addr, {}).get('usd'):
                return d[mint_addr]['usd']
    except:
        pass
    return None


def main():
    print('Fetching historical prices via DeFiLlama...\n')

    # Start from the earliest event data (dynamic)
    events_dir = os.path.join(DATA_DIR, 'tvl', 'sy_events')
    earliest_ts = int(datetime.now(timezone.utc).timestamp())
    if os.path.exists(events_dir):
        for f in os.listdir(events_dir):
            if f.endswith('.jsonl'):
                with open(os.path.join(events_dir, f)) as fh:
                    first = fh.readline().strip()
                    if first:
                        bt = json.loads(first).get('blockTime', earliest_ts)
                        earliest_ts = min(earliest_ts, bt)
    start_ts = earliest_ts - 86400
    days = (int(datetime.now(timezone.utc).timestamp()) - start_ts) // 86400 + 1
    print(f'Price range: {datetime.fromtimestamp(start_ts, tz=timezone.utc).strftime("%Y-%m-%d")} to now ({days} days)')

    prices = {}

    # SOL/USD via DeFiLlama
    prices['SOL'] = defillama_chart('solana:So11111111111111111111111111111111111111112', start_ts, days)
    time.sleep(1)

    # BTC/USD via DeFiLlama (cbBTC)
    prices['BTC'] = defillama_chart('solana:cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', start_ts, days)
    time.sleep(1)

    # xSOL — derive from current SOL ratio
    xsol_mint = '4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs'
    xsol_price = coingecko_token_price(xsol_mint)
    if not prices.get('SOL'):
        print('  ERROR: No SOL prices fetched, cannot derive xSOL')
        return
    sol_current = list(prices['SOL'].values())[-1]
    if xsol_price:
        ratio = xsol_price / sol_current
        print(f'  xSOL: ${xsol_price:.6f} (ratio to SOL: {ratio:.6f})')
    else:
        print(f'  xSOL: CoinGecko unavailable, skipping xSOL prices')
        ratio = None
    if ratio:
        prices['xSOL'] = {d: round(p * ratio, 6) for d, p in prices['SOL'].items()}
        print(f'    Derived {len(prices["xSOL"])} daily xSOL prices')
    else:
        prices['xSOL'] = {}
    time.sleep(2)

    # USD stablecoins = $1 (covers USX, hyUSD, ONyc, eUSX, and all 6-decimal unknowns)
    all_dates = sorted(prices['SOL'].keys())
    prices['USD'] = {d: 1.0 for d in all_dates}

    # Save
    json.dump(prices, open(OUT, 'w'), indent=2)
    print(f'\nWrote {OUT}')
    for key in prices:
        dates = sorted(prices[key].keys())
        print(f'  {key}: {len(prices[key])} days ({dates[0]} to {dates[-1]})')


if __name__ == '__main__':
    main()
