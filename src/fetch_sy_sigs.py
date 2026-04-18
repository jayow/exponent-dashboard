#!/usr/bin/env python3
"""Phase 1: Fetch all transaction signatures for each unique SY mint.

Resumable via cursor files. Writes one sig list per SY mint.
Output: data/tvl/sy_sigs/{mint_short}.json  (list of {sig, blockTime})
Cursor: data/tvl/sy_sigs/{mint_short}.cursor.json
"""
import json, sys, os, time
sys.path.insert(0, os.path.dirname(__file__))
from config import rpc, DATA_DIR

SIGS_DIR = os.path.join(DATA_DIR, 'tvl', 'sy_sigs')
os.makedirs(SIGS_DIR, exist_ok=True)
LIMIT = 1000


def mint_short(mint):
    return mint[:16]


def fetch_sigs_for_mint(mint):
    short = mint_short(mint)
    out_path = os.path.join(SIGS_DIR, f'{short}.json')
    cursor_path = os.path.join(SIGS_DIR, f'{short}.cursor.json')

    # Load existing sigs and cursor
    existing = []
    if os.path.exists(out_path):
        existing = json.load(open(out_path))
    cursor = None
    if os.path.exists(cursor_path):
        cursor = json.load(open(cursor_path)).get('before')

    # If already completed (has data, no cursor), fetch only new sigs from the top
    if existing and not cursor:
        seen = set(s['sig'] for s in existing)
        new_sigs = []
        scan_cursor = None
        print(f'  {short}... checking for new sigs (have {len(existing)})...', end='', flush=True)
        while True:
            params = [mint, {'limit': LIMIT}]
            if scan_cursor:
                params[1]['before'] = scan_cursor
            result = rpc('getSignaturesForAddress', params)
            if not result:
                break
            found_overlap = False
            for entry in result:
                if entry['signature'] in seen:
                    found_overlap = True
                    break
                new_sigs.append({'sig': entry['signature'], 'blockTime': entry.get('blockTime')})
            scan_cursor = result[-1]['signature']
            if found_overlap or len(result) < LIMIT:
                break
        if new_sigs:
            all_sigs = list(existing) + new_sigs
            all_sigs.sort(key=lambda s: s.get('blockTime') or 0)
            json.dump(all_sigs, open(out_path, 'w'))
            print(f' +{len(new_sigs)} new ({len(all_sigs)} total)')
        else:
            print(f' up to date')
        return len(all_sigs) if new_sigs else len(existing)

    print(f'  {short}... ({len(existing)} existing sigs, cursor={cursor[:16] + "..." if cursor else "none"})')

    all_sigs = list(existing)
    seen = set(s['sig'] for s in all_sigs)
    pages = 0

    while True:
        params = [mint, {'limit': LIMIT}]
        if cursor:
            params[1]['before'] = cursor

        result = rpc('getSignaturesForAddress', params)
        if not result:
            break

        new_count = 0
        for entry in result:
            sig = entry['signature']
            if sig not in seen:
                all_sigs.append({
                    'sig': sig,
                    'blockTime': entry.get('blockTime'),
                })
                seen.add(sig)
                new_count += 1

        pages += 1
        if result:
            cursor = result[-1]['signature']
            json.dump({'before': cursor}, open(cursor_path, 'w'))

        if pages % 10 == 0 or len(result) < LIMIT:
            json.dump(all_sigs, open(out_path, 'w'))

        if new_count > 0 and pages % 5 == 0:
            print(f'    page {pages}: +{new_count} sigs (total {len(all_sigs)})')

        if len(result) < LIMIT:
            break

    # Final save sorted by blockTime ascending
    all_sigs.sort(key=lambda s: s.get('blockTime') or 0)
    json.dump(all_sigs, open(out_path, 'w'))
    # Clear cursor on completion
    if os.path.exists(cursor_path):
        os.remove(cursor_path)

    print(f'    Done: {len(all_sigs)} total sigs ({pages} pages)')
    return len(all_sigs)


def main():
    markets_path = os.path.join(DATA_DIR, 'tvl', 'all_markets.json')
    if not os.path.exists(markets_path):
        print('Run discover_expired_markets.py first')
        sys.exit(1)

    markets = json.load(open(markets_path))

    # Collect unique SY mints
    sy_mints = {}
    for m in markets:
        sy = m['syMint']
        if sy not in sy_mints:
            sy_mints[sy] = []
        sy_mints[sy].append(m['key'])

    print(f'Fetching signatures for {len(sy_mints)} unique SY mints\n')

    total_sigs = 0
    for i, (sy, keys) in enumerate(sy_mints.items()):
        print(f'[{i+1}/{len(sy_mints)}] SY mint {sy[:16]}... (markets: {", ".join(keys)})')
        count = fetch_sigs_for_mint(sy)
        total_sigs += count

    print(f'\nTotal: {total_sigs} signatures across {len(sy_mints)} SY mints')


if __name__ == '__main__':
    main()
