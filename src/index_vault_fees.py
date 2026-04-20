#!/usr/bin/env python3
"""Index vault-specific fee treasuries (where different from MarketTwo treasury).

For each vault account, extract treasury at offset 473. If it differs from
the MarketTwo treasury (offset 264), index it separately.

Appends to data/fee_history.json keyed by treasury address.
"""
import os, sys, json, base58, base64
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, os.path.dirname(__file__))
from config import rpc, DATA_DIR
from index_final import rpc_multi
from index_fee_history import fetch_all_sigs, fetch_delta_and_pool

WORKERS = 24
OUT = os.path.join(DATA_DIR, 'fee_history.json')


def main():
    mkts = json.load(open(os.path.join(DATA_DIR, 'all_market_treasuries.json')))
    market_treasuries = set(m['treasury'] for m in mkts)

    # Get unique vaults
    vault_to_markets = {}
    for m in mkts:
        v = m['vault']
        if v not in vault_to_markets:
            vault_to_markets[v] = []
        vault_to_markets[v].append(m)

    # Find vault-specific treasuries (at offset 473) that differ from market treasuries
    print('Reading vault accounts...')
    vault_specific = {}  # vault_treasury → [market_keys]
    for v, markets in vault_to_markets.items():
        r = rpc('getAccountInfo', [v, {'encoding': 'base64'}])
        if not r or not r.get('value'): continue
        data = base64.b64decode(r['value']['data'][0])
        if len(data) < 505: continue
        vault_treasury = base58.b58encode(data[473:505]).decode()
        if vault_treasury in market_treasuries:
            continue  # Already indexed via market treasury
        if vault_treasury not in vault_specific:
            vault_specific[vault_treasury] = []
        for m in markets:
            vault_specific[vault_treasury].append(m)

    print(f'Vault-specific treasuries to index: {len(vault_specific)}')
    for t, markets in vault_specific.items():
        keys = [m['key'] for m in markets]
        print(f'  {t}  → {keys}')

    if not vault_specific:
        return

    # Load existing fee_history
    history = json.load(open(OUT)) if os.path.exists(OUT) else {}

    for treasury, markets in vault_specific.items():
        pools = set(m['pool'] for m in markets)
        print(f'\n=== vault treasury {treasury[:20]} ({len(pools)} markets) ===')

        existing_sigs = set(s[1] for s in history.get(treasury, []))
        all_sigs = fetch_all_sigs(treasury)
        print(f'  total sigs: {len(all_sigs)}, existing: {len(existing_sigs)}')

        new_sigs = [s for s in all_sigs if s['signature'] not in existing_sigs]
        if not new_sigs: continue
        print(f'  new to fetch: {len(new_sigs)}')

        new_entries = []
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futures = {ex.submit(fetch_delta_and_pool, s['signature'], treasury, pools): s for s in new_sigs}
            done = 0
            for f in as_completed(futures):
                s = futures[f]
                done += 1
                try: r = f.result()
                except: r = None
                if r is not None and r[0] is not None and r[0] != 0:
                    delta, pool_in_tx = r
                    new_entries.append([s['blockTime'], s['signature'], delta, pool_in_tx])
                if done % 500 == 0:
                    print(f'  {done}/{len(new_sigs)}...', flush=True)

        merged = history.get(treasury, []) + new_entries
        merged.sort(key=lambda x: x[0])
        history[treasury] = merged
        json.dump(history, open(OUT, 'w'))
        print(f'  saved {len(new_entries)} new')

    print('\nAlso adding vault treasuries to all_market_treasuries for analytics...')
    # Add entries for the vault treasuries so analytics can map them to tickers/platforms
    new_mkts = list(mkts)
    for vault_treasury, markets in vault_specific.items():
        first = markets[0]
        new_mkts.append({
            'pool': '',
            'treasury': vault_treasury,
            'ticker': first.get('ticker', ''),
            'decimals': first.get('decimals', 6),
            'bps': 10000,  # Vault fees are 100% revenue (no LP split)
            'platform': first.get('platform', ''),
            'status': first.get('status', 'active'),
            'expiry_ts': first.get('expiry_ts', 0),
            'source': 'vault',
        })
    json.dump(new_mkts, open(os.path.join(DATA_DIR, 'all_market_treasuries.json'), 'w'), indent=2)


if __name__ == '__main__':
    main()
