#!/usr/bin/env python3
"""Scrape all signatures for every active Exponent market.
For each market, scrapes the YT mint + vault (market PDA) addresses.
Resumable via data/sigs.cursor.json. Writes data/sigs.json.
"""
import json, sys, os, datetime
sys.path.insert(0, os.path.dirname(__file__))
from config import rpc, DATA_DIR

MARKETS = os.path.join(DATA_DIR, 'markets.json')
OUT     = os.path.join(DATA_DIR, 'sigs.json')
CURSOR  = os.path.join(DATA_DIR, 'sigs.cursor.json')

def load_existing():
    if not os.path.exists(OUT): return {}
    try: return {s['signature']: s for s in json.load(open(OUT))}
    except: return {}

def load_cursor():
    if not os.path.exists(CURSOR): return {}
    try: return json.load(open(CURSOR))
    except: return {}

def save(by_key, cursors):
    arr = sorted(by_key.values(), key=lambda s: -(s.get('blockTime') or 0))
    json.dump(arr, open(OUT, 'w'))
    json.dump(cursors, open(CURSOR, 'w'), indent=2)

def sigs_for(address, by_key, cursors):
    before = cursors.get(address, {}).get('before')
    done = cursors.get(address, {}).get('done', False)
    if done:
        print(f'    (already complete)', flush=True)
        return
    pages = 0
    while True:
        params = [address, {'limit': 1000}]
        if before: params[1]['before'] = before
        try:
            page = rpc('getSignaturesForAddress', params)
        except Exception as e:
            print(f'\n    PAGING STOPPED ({e}). Will resume next run.', flush=True)
            cursors[address] = {'before': before, 'done': False}
            save(by_key, cursors); return
        if not page: break
        for s in page:
            if s.get('err'): continue
            if s['signature'] not in by_key:
                by_key[s['signature']] = {'signature': s['signature'], 'blockTime': s.get('blockTime')}
        before = page[-1]['signature']
        pages += 1
        oldest = datetime.datetime.fromtimestamp(page[-1]['blockTime'], datetime.timezone.utc).isoformat() if page[-1].get('blockTime') else '?'
        print(f'\r    page {pages}: total {len(by_key)} sigs (oldest={oldest})       ', end='', flush=True)
        cursors[address] = {'before': before, 'done': False}
        save(by_key, cursors)
        if len(page) < 1000: break
    print(flush=True)
    cursors[address] = {'before': before, 'done': True}
    save(by_key, cursors)

def main():
    markets = json.load(open(MARKETS))
    by_key = load_existing()
    cursors = load_cursor()
    print(f'Start: {len(by_key)} sigs on disk, {len(markets)} markets', flush=True)

    for mk in markets:
        for addr in mk['scrapeAddresses']:
            print(f'[{mk["key"]}] scraping {addr[:16]}...', flush=True)
            sigs_for(addr, by_key, cursors)

    save(by_key, cursors)
    arr = sorted(by_key.values(), key=lambda s: s.get('blockTime') or 0)
    print(f'\nTotal unique sigs: {len(by_key)}')
    if arr:
        print(f'Range: {datetime.datetime.fromtimestamp(arr[0]["blockTime"], datetime.timezone.utc).isoformat()} → {datetime.datetime.fromtimestamp(arr[-1]["blockTime"], datetime.timezone.utc).isoformat()}')

if __name__ == '__main__':
    main()
