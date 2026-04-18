#!/usr/bin/env python3
"""Build analytics from enriched indexed events.

Reads: data/index/enriched/*.jsonl
Writes: web/public/analytics.json

Analytics computed:
- Trading volume per market/platform/protocol (daily)
- Historical unique holders over time
- Claim activity per user/market/platform
- Top traders leaderboard
- Market activity heatmap
- Position duration estimates
- Redemption speed post-maturity
"""
import json, sys, os, glob
from datetime import datetime, timezone
from collections import defaultdict
sys.path.insert(0, os.path.dirname(__file__))
from config import DATA_DIR

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENRICHED_DIR = os.path.join(DATA_DIR, 'index', 'enriched')
OUT = os.path.join(ROOT, 'web', 'public', 'analytics.json')

# Load market metadata for platform mapping
MARKETS_PATH = os.path.join(DATA_DIR, 'tvl', 'all_markets.json')
MARKET_META = {}
MARKET_PLATFORM = {}
if os.path.exists(MARKETS_PATH):
    for m in json.load(open(MARKETS_PATH)):
        MARKET_META[m['key']] = m
        MARKET_PLATFORM[m['key']] = m.get('platform', 'Unknown')

# Load token identity for expired market mint mapping
TOKEN_IDS = {}
token_ids_path = os.path.join(DATA_DIR, 'tvl', 'sy_token_ids.json')
if os.path.exists(token_ids_path):
    TOKEN_IDS = json.load(open(token_ids_path))

# Build extended mint→market mapping (active + expired)
MINT_TO_MARKET = {}
for m_key, m_data in MARKET_META.items():
    for field in ('ytMint', 'ptMint', 'syMint'):
        mint = m_data.get(field, '')
        if mint:
            MINT_TO_MARKET[mint] = m_key


def normalize_platform(p):
    if not p: return 'Other'
    import re
    if re.match(r'^Hylo', p, re.I): return 'Hylo'
    if re.match(r'^Drift', p, re.I): return 'Drift'
    if re.match(r'^Jupiter', p, re.I): return 'Jupiter'
    if re.match(r'^Jito Restaking', p, re.I): return 'Fragmetric'
    if re.match(r'^Jito', p, re.I): return 'Jito'
    if re.match(r'^BULK', p, re.I): return 'BULK'
    return p


def load_all_events():
    """Load all enriched events, sorted by blockTime."""
    events = []
    for f in glob.glob(os.path.join(ENRICHED_DIR, '*.jsonl')):
        for line in open(f):
            line = line.strip()
            if not line: continue
            try:
                events.append(json.loads(line))
            except:
                continue
    events.sort(key=lambda e: e.get('blockTime', 0))
    return events


def main():
    print('Loading enriched events...')
    events = load_all_events()
    print(f'  {len(events):,} events loaded')

    # ========================================
    # 1. Trading volume per day (protocol / platform / market)
    # ========================================
    print('Computing trading volumes...')
    daily_volume_protocol = defaultdict(float)
    daily_volume_platform = defaultdict(lambda: defaultdict(float))
    daily_volume_market = defaultdict(lambda: defaultdict(float))
    trade_actions = {'buyYt', 'sellYt', 'buyPt', 'sellPt', 'addLiq', 'removeLiq', 'strip', 'redeemPt'}

    for e in events:
        action = e.get('action')
        if action not in trade_actions:
            continue
        bt = e.get('blockTime')
        if not bt: continue
        date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
        market = e.get('market', 'unknown')
        platform = normalize_platform(MARKET_PLATFORM.get(market, ''))

        # Volume = sum of absolute token changes (rough USD proxy from raw amounts)
        vol = sum(abs(v) for v in e.get('tokenChanges', {}).values())
        daily_volume_protocol[date] += vol
        daily_volume_platform[platform][date] += vol
        daily_volume_market[market][date] += vol

    # ========================================
    # 2. Historical unique holders over time
    # ========================================
    print('Computing holder growth...')
    first_seen = {}
    for e in events:
        signer = e.get('signer', '')
        if not signer: continue
        bt = e.get('blockTime', 0)
        if signer not in first_seen or bt < first_seen[signer]:
            first_seen[signer] = bt

    # Build cumulative holder count per day
    holder_dates = defaultdict(int)
    for signer, bt in first_seen.items():
        date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
        holder_dates[date] += 1

    all_dates = sorted(set(
        list(daily_volume_protocol.keys()) +
        list(holder_dates.keys())
    ))
    cumulative_holders = []
    running = 0
    for d in all_dates:
        running += holder_dates.get(d, 0)
        cumulative_holders.append(running)

    # ========================================
    # 3. Claim activity
    # ========================================
    print('Computing claim activity...')
    claims_by_user = defaultdict(lambda: {'count': 0, 'markets': set(), 'first': None, 'last': None})
    claims_by_market = defaultdict(lambda: defaultdict(float))
    claims_by_platform = defaultdict(lambda: defaultdict(float))
    daily_claims_protocol = defaultdict(int)

    for e in events:
        if e.get('action') != 'claimYield':
            continue
        signer = e.get('signer', '')
        bt = e.get('blockTime', 0)
        date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
        market = e.get('market', 'unknown')
        platform = normalize_platform(MARKET_PLATFORM.get(market, ''))

        claims_by_user[signer]['count'] += 1
        claims_by_user[signer]['markets'].add(market)
        if not claims_by_user[signer]['first'] or bt < claims_by_user[signer]['first']:
            claims_by_user[signer]['first'] = bt
        if not claims_by_user[signer]['last'] or bt > claims_by_user[signer]['last']:
            claims_by_user[signer]['last'] = bt

        claims_by_market[market][date] += 1
        claims_by_platform[platform][date] += 1
        daily_claims_protocol[date] += 1

    # ========================================
    # 4. Top traders by transaction count + action breakdown
    # ========================================
    print('Computing top traders...')
    trader_stats = defaultdict(lambda: {
        'txs': 0, 'buyYt': 0, 'sellYt': 0, 'buyPt': 0, 'sellPt': 0,
        'addLiq': 0, 'removeLiq': 0, 'claimYield': 0, 'strip': 0, 'redeemPt': 0,
        'markets': set(), 'first': None, 'last': None,
    })

    for e in events:
        action = e.get('action')
        if not action: continue
        signer = e.get('signer', '')
        bt = e.get('blockTime', 0)
        market = e.get('market', 'unknown')

        ts = trader_stats[signer]
        ts['txs'] += 1
        if action in ts:
            ts[action] += 1
        ts['markets'].add(market)
        if not ts['first'] or bt < ts['first']:
            ts['first'] = bt
        if not ts['last'] or bt > ts['last']:
            ts['last'] = bt

    top_traders = sorted(
        [{'wallet': w, **{k: v for k, v in s.items() if k != 'markets'}, 'markets': len(s['markets']),
          'firstDate': datetime.fromtimestamp(s['first'], tz=timezone.utc).strftime('%Y-%m-%d') if s['first'] else None,
          'lastDate': datetime.fromtimestamp(s['last'], tz=timezone.utc).strftime('%Y-%m-%d') if s['last'] else None,
          } for w, s in trader_stats.items()],
        key=lambda x: -x['txs']
    )[:100]

    # ========================================
    # 5. Action breakdown per day (activity heatmap)
    # ========================================
    print('Computing daily action breakdown...')
    daily_actions = defaultdict(lambda: defaultdict(int))
    for e in events:
        action = e.get('action')
        if not action: continue
        bt = e.get('blockTime', 0)
        date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
        daily_actions[date][action] += 1

    action_types = ['buyYt', 'sellYt', 'buyPt', 'sellPt', 'addLiq', 'removeLiq', 'claimYield', 'redeemPt', 'strip']
    daily_action_series = {a: [daily_actions.get(d, {}).get(a, 0) for d in all_dates] for a in action_types}

    # ========================================
    # 6. New vs returning users per week
    # ========================================
    print('Computing user retention...')
    weekly_new = defaultdict(int)
    weekly_returning = defaultdict(int)
    seen_wallets = set()

    for e in events:
        action = e.get('action')
        if not action: continue
        signer = e.get('signer', '')
        bt = e.get('blockTime', 0)
        date = datetime.fromtimestamp(bt, tz=timezone.utc)
        week = date.strftime('%Y-W%W')

        if signer not in seen_wallets:
            weekly_new[week] += 1
            seen_wallets.add(signer)
        else:
            weekly_returning[week] += 1

    weeks = sorted(set(list(weekly_new.keys()) + list(weekly_returning.keys())))
    retention = {
        'weeks': weeks,
        'new': [weekly_new.get(w, 0) for w in weeks],
        'returning': [weekly_returning.get(w, 0) for w in weeks],
    }

    # ========================================
    # 7. Market activity summary
    # ========================================
    print('Computing market activity summary...')
    market_activity = {}
    for e in events:
        market = e.get('market')
        if not market: continue
        action = e.get('action', 'other')
        if market not in market_activity:
            market_activity[market] = {'txs': 0, 'uniqueUsers': set(), 'actions': defaultdict(int), 'first': None, 'last': None}
        ma = market_activity[market]
        ma['txs'] += 1
        ma['uniqueUsers'].add(e.get('signer', ''))
        ma['actions'][action] += 1
        bt = e.get('blockTime', 0)
        if not ma['first'] or bt < ma['first']: ma['first'] = bt
        if not ma['last'] or bt > ma['last']: ma['last'] = bt

    market_summary = []
    for mk, ma in market_activity.items():
        market_summary.append({
            'market': mk,
            'platform': normalize_platform(MARKET_PLATFORM.get(mk, '')),
            'txs': ma['txs'],
            'uniqueUsers': len(ma['uniqueUsers']),
            'actions': dict(ma['actions']),
            'firstDate': datetime.fromtimestamp(ma['first'], tz=timezone.utc).strftime('%Y-%m-%d') if ma['first'] else None,
            'lastDate': datetime.fromtimestamp(ma['last'], tz=timezone.utc).strftime('%Y-%m-%d') if ma['last'] else None,
        })
    market_summary.sort(key=lambda x: -x['txs'])

    # ========================================
    # 8. Claim frequency analysis
    # ========================================
    print('Computing claim frequency...')
    claim_frequency = {'daily': 0, 'weekly': 0, 'monthly': 0, 'rare': 0}
    for signer, data in claims_by_user.items():
        if data['count'] < 2:
            claim_frequency['rare'] += 1
            continue
        span_days = (data['last'] - data['first']) / 86400 if data['last'] and data['first'] else 0
        if span_days <= 0:
            claim_frequency['rare'] += 1
        elif data['count'] / span_days >= 0.5:
            claim_frequency['daily'] += 1
        elif data['count'] / span_days >= 0.1:
            claim_frequency['weekly'] += 1
        elif data['count'] / span_days >= 0.03:
            claim_frequency['monthly'] += 1
        else:
            claim_frequency['rare'] += 1

    # ========================================
    # Build output
    # ========================================
    print('Building output...')

    # Top claimers
    top_claimers = sorted(
        [{'wallet': w, 'claims': d['count'], 'markets': len(d['markets']),
          'firstClaim': datetime.fromtimestamp(d['first'], tz=timezone.utc).strftime('%Y-%m-%d') if d['first'] else None,
          'lastClaim': datetime.fromtimestamp(d['last'], tz=timezone.utc).strftime('%Y-%m-%d') if d['last'] else None,
          } for w, d in claims_by_user.items()],
        key=lambda x: -x['claims']
    )[:50]

    output = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'dates': all_dates,

        # Holder growth
        'holderGrowth': cumulative_holders,
        'totalUniqueWallets': len(first_seen),

        # Daily action breakdown
        'dailyActions': daily_action_series,

        # Daily claims
        'dailyClaims': [daily_claims_protocol.get(d, 0) for d in all_dates],

        # User retention
        'retention': retention,

        # Claim frequency distribution
        'claimFrequency': claim_frequency,

        # Top traders (top 100 by tx count)
        'topTraders': top_traders,

        # Top claimers (top 50)
        'topClaimers': top_claimers,

        # Market activity summary
        'marketActivity': market_summary,

        # Protocol stats
        'stats': {
            'totalEvents': len(events),
            'totalWallets': len(first_seen),
            'totalClaims': sum(d['count'] for d in claims_by_user.values()),
            'totalClaimers': len(claims_by_user),
            'avgClaimsPerUser': round(sum(d['count'] for d in claims_by_user.values()) / max(1, len(claims_by_user)), 1),
        },
    }

    json.dump(output, open(OUT, 'w'))
    size_mb = os.path.getsize(OUT) / 1e6
    print(f'\nWrote {OUT} ({size_mb:.1f} MB)')
    print(f'  {len(all_dates)} days, {len(first_seen):,} unique wallets')
    print(f'  {sum(d["count"] for d in claims_by_user.values()):,} claims by {len(claims_by_user):,} users')
    print(f'  Top trader: {top_traders[0]["wallet"][:16]}... ({top_traders[0]["txs"]} txs)')
    print(f'  Claim frequency: {claim_frequency}')


if __name__ == '__main__':
    main()
