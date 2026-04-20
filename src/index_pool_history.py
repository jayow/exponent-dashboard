#!/usr/bin/env python3
"""Index pool PT escrow balance history for every active market.

For each market, fetches signatures for its pool's PT escrow token account,
then for each tx extracts the post-tx PT balance. Writes a timestamped
balance series per market.

This is authoritative pool PT balance history — exactly what's needed for
accurate AMM rate reconstruction.

Output: data/pool_pt_history.json  { market_key: [(ts, sig, pt_balance), ...] }
"""
import os, sys, json, base64, struct, time, base58
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, os.path.dirname(__file__))
from config import rpc, DATA_DIR
from index_final import rpc_multi

WORKERS = 24
OUT = os.path.join(DATA_DIR, 'pool_pt_history.json')
SIGS_LIMIT_PER_PAGE = 1000


def read_pool_escrows(pool_addr):
    """Read all pool escrow and vault addresses from MarketTwo."""
    result = rpc('getAccountInfo', [pool_addr, {'encoding': 'base64'}])
    if not result or not result.get('value'):
        return None
    data = base64.b64decode(result['value']['data'][0])
    def pk(off): return base58.b58encode(data[off:off+32]).decode()
    return {
        'vault': pk(104),
        'lp_escrow': pk(168),
        'pt_escrow': pk(200),
        'sy_escrow': pk(232),
    }


def read_pt_escrow(pool_addr):
    escrows = read_pool_escrows(pool_addr)
    return escrows['pt_escrow'] if escrows else None


def fetch_all_sigs(account):
    """Fetch ALL signatures for an account by paginating."""
    all_sigs = []
    before = None
    while True:
        params = [account, {'limit': SIGS_LIMIT_PER_PAGE}]
        if before:
            params[1]['before'] = before
        result = rpc('getSignaturesForAddress', params)
        if not result:
            break
        batch = [s for s in result if not s.get('err')]
        all_sigs.extend(batch)
        if len(result) < SIGS_LIMIT_PER_PAGE:
            break
        before = result[-1]['signature']
    return all_sigs


def fetch_balances(sig, watched):
    """Fetch tx and return post-tx balances for all watched accounts.
    watched: dict of account_addr → label ('pt'|'sy'|'lp'|'vault')
    Returns: dict of label → balance (int raw) for accounts found in postTokenBalances.
    """
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
    loaded = meta.get('loadedAddresses', {}) or {}
    account_keys.extend(loaded.get('writable', []) or [])
    account_keys.extend(loaded.get('readonly', []) or [])

    out = {}
    for b in post:
        idx = b.get('accountIndex')
        if idx >= len(account_keys): continue
        addr = account_keys[idx]
        if addr not in watched: continue
        label = watched[addr]
        try:
            out[label] = int(b.get('uiTokenAmount', {}).get('amount', '0'))
        except:
            out[label] = 0
    return out


def fetch_pt_balance(sig, escrow):
    result = fetch_balances(sig, {escrow: 'pt'})
    return (result or {}).get('pt')


def main():
    api = json.load(open(os.path.join(DATA_DIR, 'exponent_markets_api.json')))
    from datetime import datetime, timezone

    history = {}
    if os.path.exists(OUT):
        history = json.load(open(OUT))

    for m in api:
        t = m['underlyingAsset']['ticker']
        mat = datetime.fromtimestamp(m['maturityDateUnixTs'], tz=timezone.utc).strftime('%d%b%y').upper()
        key = f'{t}-{mat}'
        if not m.get('legacyMarketAddresses'): continue
        pool = m['legacyMarketAddresses'][0]

        print(f'\n=== {key} ===')
        escrows = read_pool_escrows(pool)
        if not escrows:
            print('  failed to read escrows')
            continue
        watched = {
            escrows['pt_escrow']: 'pt',
            escrows['sy_escrow']: 'sy',
            escrows['lp_escrow']: 'lp',
            escrows['vault']: 'vault',
        }
        pt_escrow = escrows['pt_escrow']
        print(f'  escrows: pt={pt_escrow[:16]} vault={escrows["vault"][:16]}')

        # Existing entries may be old-format [ts, sig, pt] or new format [ts, sig, {pt,sy,lp,vault}]
        existing = history.get(key, [])
        existing_sigs = set()
        for entry in existing:
            existing_sigs.add(entry[1])
        print(f'  already have: {len(existing_sigs)} entries')

        all_sigs = fetch_all_sigs(pt_escrow)  # sigs for PT escrow (main source of events)
        print(f'  total sigs for PT escrow: {len(all_sigs)}')

        new_sigs = [s for s in all_sigs if s['signature'] not in existing_sigs]
        print(f'  new sigs to fetch: {len(new_sigs)}')

        if not new_sigs:
            continue

        new_entries = []
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futures = {ex.submit(fetch_balances, s['signature'], watched): s for s in new_sigs}
            done = 0
            for f in as_completed(futures):
                s = futures[f]
                done += 1
                try:
                    bals = f.result()
                except:
                    continue
                if bals:
                    new_entries.append([s['blockTime'], s['signature'], bals])
                if done % 500 == 0:
                    print(f'  {done}/{len(new_sigs)}...', flush=True)

        merged = existing + new_entries
        merged.sort(key=lambda x: x[0])
        history[key] = merged

        json.dump(history, open(OUT, 'w'))
        print(f'  saved {len(new_entries)} new entries ({len(merged)} total)')


if __name__ == '__main__':
    main()
