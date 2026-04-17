#!/usr/bin/env python3
"""Fetch active Exponent markets + auto-discover vault (YT mint authority) for each.

Writes data/markets.json with all info needed to scrape each market:
  ytMint, ptMint, syMint, vault, underlying, ticker, platform, maturity, etc.

Run this first (or periodically to pick up new markets).
"""
import json, sys, os
import requests
sys.path.insert(0, os.path.dirname(__file__))
from config import rpc, DATA_DIR, EXPONENT_API

OUT = os.path.join(DATA_DIR, 'markets.json')

def fetch_active_markets():
    r = requests.get(EXPONENT_API, timeout=30)
    r.raise_for_status()
    return r.json()

def get_mint_authority(mint):
    info = rpc('getAccountInfo', [mint, {'encoding': 'jsonParsed'}])
    return info['value']['data']['parsed']['info']['mintAuthority']

def main():
    raw = fetch_active_markets()
    print(f'Active markets from API: {len(raw)}', flush=True)

    markets = []
    for m in raw:
        ticker = m['underlyingAsset']['ticker']
        platform = m.get('platformName', '?')
        # Derive a readable market key
        import datetime
        mat_ts = m['maturityDateUnixTs']
        mat_str = datetime.datetime.utcfromtimestamp(mat_ts).strftime('%d%b%y').upper()
        key = f'{ticker}-{mat_str}'

        # Auto-discover vault = YT mint authority (the market PDA)
        yt_mint = m['ytMint']
        print(f'  [{key}] discovering vault for YT {yt_mint[:16]}...', end='', flush=True)
        try:
            vault = get_mint_authority(yt_mint)
            print(f' vault={vault[:16]}...', flush=True)
        except Exception as e:
            vault = None
            print(f' FAILED: {e}', flush=True)

        markets.append({
            'key': key,
            'ticker': ticker,
            'platform': platform,
            'maturity': datetime.datetime.utcfromtimestamp(mat_ts).strftime('%Y-%m-%d'),
            'maturityTs': mat_ts,
            'underlying': m['underlyingAsset']['mint'],
            'underlyingDecimals': m['underlyingAsset'].get('decimals', 6),
            'ytMint': yt_mint,
            'ptMint': m['ptMint'],
            'syMint': m['syMint'],
            'vault': vault,
            'scrapeAddresses': [x for x in [yt_mint, vault] if x],
            'status': m.get('marketStatus', 'active'),
            'tvl': m.get('totalMarketSize', 0),
            'categories': m.get('categories', []),
        })

    json.dump(markets, open(OUT, 'w'), indent=2)
    print(f'\nSaved {len(markets)} markets to {OUT}')
    for mk in markets:
        print(f'  {mk["key"]:20s} {mk["platform"]:22s} TVL ${mk["tvl"]:>12,.0f}  scrape={len(mk["scrapeAddresses"])} addrs')

if __name__ == '__main__':
    main()
