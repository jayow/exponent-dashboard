#!/usr/bin/env python3
"""Backfill every indexed event with pool escrow token balances.

For each transaction, captures post-tx balances for:
  - token_pt_escrow (per market)
  - token_sy_escrow (per market, usually 0 since SY is virtual)
  - token_lp_escrow (per market)
  - vault (underlying token vault)

Enables exact pool state reconstruction at every transaction.

Reads pool addresses from MarketTwo accounts on-chain.
Stores in each event as: poolBal: {ptEscrow: X, syEscrow: Y, lpEscrow: Z}
Only captures if one of these accounts appears in postTokenBalances.
"""
import os, sys, json, glob, struct, base64
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, os.path.dirname(__file__))
from config import DATA_DIR, rpc
from index_final import rpc_multi

WORKERS = 24
IN_DIR = os.path.join(DATA_DIR, 'index', 'enriched')
EXPONENT_PROGRAM = 'ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7'


def read_market_two_pools(addr):
    """Extract pool escrow addresses from MarketTwo."""
    result = rpc('getAccountInfo', [addr, {'encoding': 'base64'}])
    if not result or not result.get('value'):
        return None
    data = base64.b64decode(result['value']['data'][0])
    import base58
    def pk(off): return base58.b58encode(data[off:off+32]).decode()
    return {
        'mint_pt': pk(40),
        'mint_sy': pk(72),
        'vault': pk(104),
        'mint_lp': pk(136),
        'lp_escrow': pk(168),
        'pt_escrow': pk(200),
        'sy_escrow': pk(232),
    }


def load_pool_info():
    """Build a map of account_address → (market_key, field_name)."""
    import datetime as dt
    from datetime import timezone
    api = json.load(open(os.path.join(DATA_DIR, 'exponent_markets_api.json')))
    # Also include expired markets
    all_mkt_path = os.path.join(DATA_DIR, 'tvl', 'all_markets.json')
    all_mkt = json.load(open(all_mkt_path)) if os.path.exists(all_mkt_path) else []

    account_to_info = {}
    markets = []
    for m in api:
        t = m['underlyingAsset']['ticker']
        mat = dt.datetime.fromtimestamp(m['maturityDateUnixTs'], tz=timezone.utc).strftime('%d%b%y').upper()
        key = f'{t}-{mat}'
        if not m.get('legacyMarketAddresses'): continue
        markets.append((key, m['legacyMarketAddresses'][0]))

    # Also add expired markets — their MarketTwo accounts are still readable
    for m in all_mkt:
        key = m.get('key', '')
        # Expired markets don't have legacy addr; skip for now
        pass

    print(f'Reading pool escrows for {len(markets)} active markets...')
    for key, pool_addr in markets:
        pools = read_market_two_pools(pool_addr)
        if not pools: continue
        for field in ('pt_escrow', 'sy_escrow', 'lp_escrow', 'vault'):
            addr = pools.get(field)
            if addr:
                account_to_info[addr] = (key, field)
        print(f'  {key}: pt={pools["pt_escrow"][:16]}... sy={pools["sy_escrow"][:16]}...')
    return account_to_info


def fetch_pool_balances(sig, account_to_info):
    """Fetch tx and extract balances for pool accounts."""
    result = rpc_multi('getTransaction', [sig, {'encoding': 'json', 'maxSupportedTransactionVersion': 0}])
    if not result or not result.get('meta'):
        return None
    meta = result['meta']
    post = meta.get('postTokenBalances') or []
    msg = result.get('transaction', {}).get('message', {})
    account_keys = []
    for ak in msg.get('accountKeys', []):
        if isinstance(ak, str): account_keys.append(ak)
        elif isinstance(ak, dict): account_keys.append(ak.get('pubkey', ''))
    # Include loaded addresses from ALTs
    loaded = meta.get('loadedAddresses', {}) or {}
    account_keys.extend(loaded.get('readonly', []) or [])
    account_keys.extend(loaded.get('writable', []) or [])

    pool_bal = {}
    for b in post:
        idx = b.get('accountIndex')
        if idx >= len(account_keys): continue
        addr = account_keys[idx]
        if addr not in account_to_info: continue
        mkt, field = account_to_info[addr]
        amt_str = b.get('uiTokenAmount', {}).get('amount', '0')
        try:
            amt = int(amt_str)
        except: amt = 0
        pool_bal.setdefault(mkt, {})[field] = amt
    return pool_bal


def process_file(path, account_to_info):
    events = []
    need = []
    with open(path) as fh:
        for i, line in enumerate(fh):
            try:
                e = json.loads(line)
            except:
                events.append(line)  # keep bad lines as-is
                continue
            events.append(e)
            if 'poolBal' in e: continue
            if not e.get('sig'): continue
            need.append(i)

    if not need:
        return 0, 0

    updated = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = {}
        for i in need:
            if not isinstance(events[i], dict): continue
            sig = events[i].get('sig')
            if sig:
                futures[ex.submit(fetch_pool_balances, sig, account_to_info)] = i

        for f in as_completed(futures):
            i = futures[f]
            try:
                pool_bal = f.result()
            except:
                continue
            if pool_bal:
                events[i]['poolBal'] = pool_bal
                updated += 1

    # Atomic write
    tmp = path + '.tmp'
    with open(tmp, 'w') as fh:
        for e in events:
            if isinstance(e, dict):
                fh.write(json.dumps(e) + '\n')
            else:
                fh.write(e if e.endswith('\n') else e + '\n')
    os.replace(tmp, path)
    return updated, len(need)


def main():
    account_to_info = load_pool_info()
    print(f'Tracking {len(account_to_info)} pool accounts')

    files = sorted(glob.glob(os.path.join(IN_DIR, '*.jsonl')))
    print(f'Processing {len(files)} files...')

    total_updated = 0
    total_needed = 0
    for f in files:
        u, n = process_file(f, account_to_info)
        total_updated += u
        total_needed += n
        if n > 0:
            print(f'  {os.path.basename(f)}: {u}/{n} events updated')
    print(f'\nBackfilled {total_updated}/{total_needed} events with pool balances')


if __name__ == '__main__':
    main()
