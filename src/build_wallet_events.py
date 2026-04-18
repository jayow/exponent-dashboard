#!/usr/bin/env python3
"""Build per-wallet event files from enriched indexed data.

Reads: data/index/enriched/*.jsonl
Writes: web/public/events/{wallet}.json (one file per wallet with activity)
        web/public/data.json (aggregated wallet stats)

Replaces the old build_web_data.py pipeline with enriched data.
"""
import json, sys, os, glob
from datetime import datetime, timezone
from collections import defaultdict
sys.path.insert(0, os.path.dirname(__file__))
from config import DATA_DIR

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENRICHED_DIR = os.path.join(DATA_DIR, 'index', 'enriched')
EVENTS_DIR = os.path.join(ROOT, 'web', 'public', 'events')
DATA_OUT = os.path.join(ROOT, 'web', 'public', 'data.json')
os.makedirs(EVENTS_DIR, exist_ok=True)

# Load market metadata
MARKET_PLATFORM = {}
markets_path = os.path.join(DATA_DIR, 'tvl', 'all_markets.json')
if os.path.exists(markets_path):
    for m in json.load(open(markets_path)):
        MARKET_PLATFORM[m['key']] = m.get('platform', '')


def main():
    print('Loading enriched events...')
    # Group events by signer
    wallet_events = defaultdict(list)
    total = 0

    for f in sorted(glob.glob(os.path.join(ENRICHED_DIR, '*.jsonl'))):
        for line in open(f):
            line = line.strip()
            if not line: continue
            try:
                e = json.loads(line)
            except:
                continue
            total += 1
            signer = e.get('signer', '')
            if not signer: continue

            # Build a clean event for the wallet page
            evt = {
                'sig': e.get('sig', ''),
                'blockTime': e.get('blockTime', 0),
                'market': e.get('market', ''),
                'action': e.get('action', ''),
                'instr': e.get('instr', ''),
            }
            # Add token change summary
            tc = e.get('tokenChanges', {})
            if tc:
                evt['tokenChanges'] = tc

            wallet_events[signer].append(evt)

    print(f'  {total:,} events across {len(wallet_events):,} wallets')

    # Sort each wallet's events by blockTime
    for w in wallet_events:
        wallet_events[w].sort(key=lambda e: e.get('blockTime', 0))

    # Write per-wallet event files (only for wallets with classified actions)
    print('Writing per-wallet event files...')
    written = 0
    for w, events in wallet_events.items():
        # Only write files for wallets with at least one classified action
        has_action = any(e.get('action') for e in events)
        if not has_action:
            continue
        path = os.path.join(EVENTS_DIR, f'{w}.json')
        json.dump(events, open(path, 'w'))
        written += 1

    print(f'  Wrote {written:,} wallet event files')

    # Build aggregated data.json
    print('Building aggregated wallet stats...')
    wallets_summary = []
    for w, events in wallet_events.items():
        actions = [e.get('action') for e in events if e.get('action')]
        if not actions:
            continue

        markets = set(e.get('market') for e in events if e.get('market'))
        by_market = defaultdict(int)
        for e in events:
            mk = e.get('market', '')
            if mk:
                by_market[mk] += 1

        farm = {'buyYt': 0, 'sellYt': 0, 'claimYield': 0}
        lp = {'addLiq': 0, 'removeLiq': 0}
        income = {'buyPt': 0, 'sellPt': 0, 'strip': 0, 'redeemPt': 0}

        for a in actions:
            if a in farm: farm[a] += 1
            elif a in lp: lp[a] += 1
            elif a in income: income[a] += 1

        wallets_summary.append({
            'addr': w,
            'farm': farm,
            'lp': lp,
            'income': income,
            'byMarket': dict(by_market),
            'totalVolume': 0,
            'txs': len(actions),
            'farmNet': farm['buyYt'] - farm['sellYt'],
            'lpNet': lp['addLiq'] - lp['removeLiq'],
        })

    wallets_summary.sort(key=lambda x: -x['txs'])

    # Market totals
    market_totals = defaultdict(lambda: {'txs': 0, 'wallets': set()})
    for ws in wallets_summary:
        for mk, count in ws['byMarket'].items():
            market_totals[mk]['txs'] += count
            market_totals[mk]['wallets'].add(ws['addr'])

    output = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'markets': {k: {'txs': v['txs'], 'wallets': len(v['wallets'])} for k, v in market_totals.items()},
        'totals': {
            'wallets': len(wallets_summary),
            'txs': sum(w['txs'] for w in wallets_summary),
        },
        'wallets': wallets_summary[:5000],
    }

    json.dump(output, open(DATA_OUT, 'w'))
    print(f'  Wrote {DATA_OUT} ({len(wallets_summary):,} wallets, top 5000 saved)')
    print(f'\nDone: {written:,} event files, {len(wallets_summary):,} wallet summaries')


if __name__ == '__main__':
    main()
