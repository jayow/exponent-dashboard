#!/usr/bin/env python3
"""Build static JSON for the Exponent Dashboard web UI.
Outputs:
  web/public/data.json        — wallet-level aggregates + market metadata
  web/public/events/{addr}.json — per-wallet event list
"""
import os, json, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARKETS_IN = os.path.join(ROOT, 'data/markets.json')
EVENTS_IN  = os.path.join(ROOT, 'data/events.jsonl')
OUT_MAIN   = os.path.join(ROOT, 'web/public/data.json')
OUT_EV_DIR = os.path.join(ROOT, 'web/public/events')
os.makedirs(OUT_EV_DIR, exist_ok=True)

# Segment grouping
FARM_ACTIONS = {'buyYt', 'sellYt', 'claimYield'}
LP_ACTIONS   = {'addLiq', 'removeLiq'}
INCOME_ACTIONS = {'strip', 'redeemPt', 'buyPt', 'sellPt'}

def main():
    markets = json.load(open(MARKETS_IN))
    market_keys = [m['key'] for m in markets]

    # Aggregate per wallet
    wallets = {}   # addr -> row
    events_by_addr = {}

    for l in open(EVENTS_IN):
        l = l.strip()
        if not l: continue
        try: r = json.loads(l)
        except: continue
        if not r.get('market'): continue
        addr = r['signer']
        if addr not in wallets:
            wallets[addr] = {
                'addr': addr,
                'farm':   {'buyYt': 0, 'sellYt': 0, 'claimYield': 0},
                'lp':     {'addLiq': 0, 'removeLiq': 0},
                'income': {'buyPt': 0, 'sellPt': 0, 'strip': 0, 'redeemPt': 0},
                'byMarket': {mk: 0 for mk in market_keys},
                'totalVolume': 0,
                'txs': 0,
            }
            events_by_addr[addr] = []
        events_by_addr[addr].append(r)
        w = wallets[addr]
        w['txs'] += 1
        usd = abs(r.get('usdNet', 0))
        w['totalVolume'] += usd
        act = r.get('action', 'other')
        mk = r.get('market')
        if mk in w['byMarket']:
            w['byMarket'][mk] += usd
        if act in w['farm']:     w['farm'][act] += usd
        elif act in w['lp']:     w['lp'][act] += usd
        elif act in w['income']: w['income'][act] += usd

    # Round
    for w in wallets.values():
        for seg in (w['farm'], w['lp'], w['income']):
            for k in seg: seg[k] = round(seg[k], 2)
        for mk in w['byMarket']: w['byMarket'][mk] = round(w['byMarket'][mk], 2)
        w['totalVolume'] = round(w['totalVolume'], 2)
        # Derived
        w['farmNet'] = round(w['farm']['buyYt'] - w['farm']['sellYt'], 2)
        w['lpNet']   = round(w['lp']['addLiq'] - w['lp']['removeLiq'], 2)

    wallet_list = sorted(wallets.values(), key=lambda r: -r['totalVolume'])

    # Totals
    totals = {
        'wallets': len(wallet_list),
        'markets': len(markets),
        'farmBuys': round(sum(w['farm']['buyYt'] for w in wallet_list), 2),
        'farmSells': round(sum(w['farm']['sellYt'] for w in wallet_list), 2),
        'farmClaims': round(sum(w['farm']['claimYield'] for w in wallet_list), 2),
        'lpAdds': round(sum(w['lp']['addLiq'] for w in wallet_list), 2),
        'lpRemoves': round(sum(w['lp']['removeLiq'] for w in wallet_list), 2),
    }

    dataset = {
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(),
        'markets': [{
            'key': m['key'], 'ticker': m['ticker'], 'platform': m['platform'],
            'maturity': m['maturity'], 'tvl': m.get('tvl', 0),
        } for m in markets],
        'totals': totals,
        'wallets': wallet_list,
    }
    with open(OUT_MAIN, 'w') as f:
        json.dump(dataset, f, separators=(',', ':'))
    print(f'wrote {OUT_MAIN}: {len(wallet_list)} wallets')

    # Per-wallet events
    written = 0
    for addr, evs in events_by_addr.items():
        if not evs: continue
        small = [{
            'sig': e['sig'], 'blockTime': e.get('blockTime'),
            'market': e['market'], 'signer': e['signer'],
            'action': e.get('action', 'other'), 'instr': e.get('instr'),
            'ytDelta': e.get('ytDelta', 0), 'underlyingDelta': e.get('underlyingDelta', 0),
            'usdNet': e.get('usdNet', 0),
        } for e in sorted(evs, key=lambda x: x.get('blockTime', 0))]
        with open(os.path.join(OUT_EV_DIR, f'{addr}.json'), 'w') as f:
            json.dump(small, f, separators=(',', ':'))
        written += 1
    print(f'wrote per-wallet event files: {written}')

if __name__ == '__main__':
    main()
