#!/usr/bin/env python3
"""Index fee revenue history from on-chain treasury addresses.

Each MarketTwo account stores a `token_fee_treasury_sy` address (at byte 264).
All protocol fees land there. For each market:
  1. Read treasury address from MarketTwo
  2. Fetch all sigs for treasury via getSignaturesForAddress
  3. For each tx, extract the treasury's pre/post balance delta (positive = fee in)

Writes: data/fee_history.json
  { market_key: [(ts, sig, balance_delta_raw), ...] }
"""
import os, sys, json, base58, base64, struct
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, os.path.dirname(__file__))
from config import rpc, DATA_DIR
from index_final import rpc_multi

WORKERS = 24
OUT = os.path.join(DATA_DIR, 'fee_history.json')
SIGS_LIMIT = 1000


def read_treasury(pool_addr):
    result = rpc('getAccountInfo', [pool_addr, {'encoding': 'base64'}])
    if not result or not result.get('value'):
        return None
    data = base64.b64decode(result['value']['data'][0])
    return base58.b58encode(data[264:296]).decode()


def fetch_all_sigs(account):
    all_sigs = []
    before = None
    while True:
        params = [account, {'limit': SIGS_LIMIT}]
        if before: params[1]['before'] = before
        result = rpc('getSignaturesForAddress', params)
        if not result: break
        batch = [s for s in result if not s.get('err')]
        all_sigs.extend(batch)
        if len(result) < SIGS_LIMIT: break
        before = result[-1]['signature']
    return all_sigs


def fetch_delta_and_pool(sig, treasury, pool_set):
    """Return (delta, pool_addr_in_tx) for treasury account, or None.
    pool_set: set of MarketTwo pool addresses that share this treasury.
    Identifies which specific pool was in the tx (for per-market attribution).
    """
    result = rpc_multi('getTransaction', [sig, {'encoding': 'json', 'maxSupportedTransactionVersion': 0}])
    if not result or not result.get('meta'):
        return None
    meta = result['meta']
    msg = result.get('transaction', {}).get('message', {})
    keys = []
    for ak in msg.get('accountKeys', []):
        if isinstance(ak, str): keys.append(ak)
        elif isinstance(ak, dict): keys.append(ak.get('pubkey', ''))
    loaded = meta.get('loadedAddresses', {}) or {}
    keys.extend(loaded.get('writable', []) or [])
    keys.extend(loaded.get('readonly', []) or [])

    pre = {b['accountIndex']: b for b in (meta.get('preTokenBalances') or [])}
    post = {b['accountIndex']: b for b in (meta.get('postTokenBalances') or [])}

    delta = None
    for idx in set(pre.keys()) | set(post.keys()):
        if idx >= len(keys): continue
        if keys[idx] != treasury: continue
        try: pre_amt = int(pre.get(idx, {}).get('uiTokenAmount', {}).get('amount', '0'))
        except: pre_amt = 0
        try: post_amt = int(post.get(idx, {}).get('uiTokenAmount', {}).get('amount', '0'))
        except: post_amt = 0
        delta = post_amt - pre_amt
        break

    # Identify which pool (MarketTwo) was in the tx
    pool_in_tx = ''
    for k in keys:
        if k in pool_set:
            pool_in_tx = k
            break
    return (delta, pool_in_tx)


def main():
    # Load all market treasuries (active + expired)
    mkts = json.load(open(os.path.join(DATA_DIR, 'all_market_treasuries.json')))

    # Group pools by treasury (treasuries can be shared across maturities)
    from collections import defaultdict
    treasury_to_pools = defaultdict(set)  # treasury → set of pool addresses
    treasury_to_ticker = {}  # treasury → ticker (most common)
    for m in mkts:
        treasury_to_pools[m['treasury']].add(m['pool'])
        treasury_to_ticker[m['treasury']] = m.get('ticker', '')

    print(f'Unique treasuries: {len(treasury_to_pools)}')

    # fee_history stored by TREASURY address (not market key — we attribute to markets later)
    # Structure: { treasury_addr: [(ts, sig, delta_raw, pool_in_tx), ...] }
    history = {}
    if os.path.exists(OUT):
        existing = json.load(open(OUT))
        # Migrate from old schema (market-keyed) if needed
        for k, v in existing.items():
            # If key looks like a treasury address (no dash), keep it
            if '-' not in k:
                history[k] = v

    for treasury, pools in treasury_to_pools.items():
        ticker = treasury_to_ticker.get(treasury, '?')
        print(f'\n=== {ticker} treasury {treasury[:20]} ({len(pools)} pools) ===')

        existing_sigs = set(s[1] for s in history.get(treasury, []))
        all_sigs = fetch_all_sigs(treasury)
        print(f'  total sigs: {len(all_sigs)}, existing: {len(existing_sigs)}')

        new_sigs = [s for s in all_sigs if s['signature'] not in existing_sigs]
        print(f'  new to fetch: {len(new_sigs)}')
        if not new_sigs: continue

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
        print(f'  saved {len(new_entries)} new ({len(merged)} total)')


if __name__ == '__main__':
    main()
