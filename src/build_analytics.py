#!/usr/bin/env python3
"""Build analytics from enriched indexed events.

Reads: data/index/enriched/*.jsonl, web/public/holders.json, data/tvl/prices.json
Writes: web/public/analytics.json

Output structured for frontend integration:
- Daily activity + claims → HistoricalChart (protocol/platform/market)
- Holder growth + retention → Holders tab
- Enriched top holders (merged trader + holder + claimer data)
- Market activity columns → MarketCards
"""
import json, sys, os, glob
from datetime import datetime, timezone
from collections import defaultdict
sys.path.insert(0, os.path.dirname(__file__))
from config import DATA_DIR

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENRICHED_DIR = os.path.join(DATA_DIR, 'index', 'enriched')
OUT = os.path.join(ROOT, 'web', 'public', 'analytics.json')

MARKETS_PATH = os.path.join(DATA_DIR, 'tvl', 'all_markets.json')
MARKET_META = {}
MARKET_PLATFORM = {}
MARKET_DECIMALS = {}
MARKET_PRICE_KEY = {}
if os.path.exists(MARKETS_PATH):
    for m in json.load(open(MARKETS_PATH)):
        MARKET_META[m['key']] = m
        MARKET_PLATFORM[m['key']] = m.get('platform', 'Unknown')
        MARKET_DECIMALS[m['key']] = m.get('underlyingDecimals', 6)
        qt = (m.get('quoteTicker') or '').upper()
        if qt in ('USD', 'USDC', 'USDT', 'USX', 'EUSX'):
            MARKET_PRICE_KEY[m['key']] = 'USD'
        elif qt == 'XSOL':
            MARKET_PRICE_KEY[m['key']] = 'xSOL'
        elif 'BTC' in qt:
            MARKET_PRICE_KEY[m['key']] = 'BTC'
        else:
            MARKET_PRICE_KEY[m['key']] = 'SOL'

# Load prices for USD conversion
PRICES = {}
prices_path = os.path.join(DATA_DIR, 'tvl', 'prices.json')
if os.path.exists(prices_path):
    PRICES = json.load(open(prices_path))

# Load known protocol addresses
PROTOCOL_ADDRS = set()
api_path = os.path.join(DATA_DIR, 'exponent_markets_api.json')
if os.path.exists(api_path):
    for am in json.load(open(api_path)):
        for f in ('vaultAddress', 'syMint', 'ptMint', 'ytMint'):
            if am.get(f): PROTOCOL_ADDRS.add(am[f])
        for a in am.get('legacyMarketAddresses', []): PROTOCOL_ADDRS.add(a)
        for a in am.get('orderbookAddresses', []): PROTOCOL_ADDRS.add(a)


# Build set of priceable mints (SY/PT/YT/underlying/quote — NOT emission tokens)
PRICEABLE_MINTS = set()
_api_path = os.path.join(DATA_DIR, 'exponent_markets_api.json')
if os.path.exists(_api_path):
    for _am in json.load(open(_api_path)):
        for _f in ('syMint', 'ptMint', 'ytMint'):
            PRICEABLE_MINTS.add(_am.get(_f, ''))
        PRICEABLE_MINTS.add(_am['underlyingAsset']['mint'])
        PRICEABLE_MINTS.add(_am.get('quoteAsset', {}).get('mint', ''))
        PRICEABLE_MINTS.add(_am.get('baseTokenMint', ''))
PRICEABLE_MINTS.discard('')

# Load mint symbols for token detection
MINT_SYMBOLS_MAP = {}
_mint_sym_path = os.path.join(DATA_DIR, 'mint_symbols.json')
if os.path.exists(_mint_sym_path):
    MINT_SYMBOLS_MAP = json.load(open(_mint_sym_path))

TOKEN_PRICES = {}
_token_prices_path = os.path.join(DATA_DIR, 'token_prices.json')
if os.path.exists(_token_prices_path):
    TOKEN_PRICES = json.load(open(_token_prices_path))

# Extended mint→market mapping for all 88 markets
ALL_MINT_TO_MARKET = {}
_all_markets_path = os.path.join(DATA_DIR, 'tvl', 'all_markets.json')
if os.path.exists(_all_markets_path):
    for _m in json.load(open(_all_markets_path)):
        for _f in ('ytMint', 'ptMint', 'syMint'):
            _mint = _m.get(_f, '')
            if _mint:
                ALL_MINT_TO_MARKET[_mint] = _m['key']

# Symbol→market mapping for underlying tokens
SYMBOL_TO_MARKET = {}
if os.path.exists(_all_markets_path):
    for _m in json.load(open(_all_markets_path)):
        _ticker = _m.get('underlyingTicker', '')
        if _ticker and _ticker not in SYMBOL_TO_MARKET:
            SYMBOL_TO_MARKET[_ticker] = _m['key']


def resolve_market(event):
    """Resolve market from event data using multiple fallbacks."""
    if event.get('market'):
        return event['market']
    for mint in event.get('tokenChanges', {}):
        if mint in ALL_MINT_TO_MARKET:
            return ALL_MINT_TO_MARKET[mint]
    for mint in event.get('tokenChanges', {}):
        sym = MINT_SYMBOLS_MAP.get(mint, '')
        if sym in SYMBOL_TO_MARKET:
            return SYMBOL_TO_MARKET[sym]
        for prefix in ('legacy', 'w', 'e'):
            if sym.startswith(prefix) and sym[len(prefix):] in SYMBOL_TO_MARKET:
                return SYMBOL_TO_MARKET[sym[len(prefix):]]
    return 'unknown'

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


def get_price(date, price_key):
    return PRICES.get(price_key, {}).get(date, PRICES.get('USD', {}).get(date, 1.0))


def load_all_events():
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
    # 1. Daily activity by protocol/platform/market
    # ========================================
    print('Computing daily activity...')
    action_types = ['buyYt', 'sellYt', 'buyPt', 'sellPt', 'addLiq', 'removeLiq', 'claimYield', 'redeemPt', 'strip']
    daily_activity_protocol = defaultdict(lambda: defaultdict(int))
    daily_activity_platform = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    daily_activity_market = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))

    for e in events:
        action = e.get('action')
        if not action: continue
        bt = e.get('blockTime')
        if not bt: continue
        date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
        market = resolve_market(e)
        platform = normalize_platform(MARKET_PLATFORM.get(market, ''))

        daily_activity_protocol[date][action] += 1
        daily_activity_platform[platform][date][action] += 1
        daily_activity_market[market][date][action] += 1

    # ========================================
    # 2. Daily claims with USD amounts
    # ========================================
    print('Computing claims with USD...')
    daily_claims_protocol = defaultdict(lambda: {'count': 0, 'usd': 0.0})
    daily_claims_platform = defaultdict(lambda: defaultdict(lambda: {'count': 0, 'usd': 0.0}))
    daily_claims_market = defaultdict(lambda: defaultdict(lambda: {'count': 0, 'usd': 0.0}))

    claims_by_user = defaultdict(lambda: {'count': 0, 'totalUsd': 0.0, 'markets': set(), 'first': None, 'last': None})

    for e in events:
        if e.get('action') != 'claimYield': continue
        bt = e.get('blockTime', 0)
        date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
        market = resolve_market(e)
        platform = normalize_platform(MARKET_PLATFORM.get(market, ''))
        signer = e.get('signer', '')

        # Estimate claim USD — only price market-related tokens, not emission rewards
        claim_usd = 0
        pk = MARKET_PRICE_KEY.get(market, 'USD')
        price = get_price(date, pk)
        # Symbol-based price lookup
        _sol = PRICES.get('SOL', {}).get(date, 88)
        _sym_prices = {
            'SOL': _sol, 'USDC': 1, 'USDT': 1, 'USD': 1, 'USX': 1, 'eUSX': 1,
            'ONyc': 1, 'USDC+': 1, 'sHYUSD': 1, 'syrupUSDC': 1, 'legacyUSD*': 1,
            'kUSDC': 1, 'mUSDC': 1, 'mUSDT': 1, 'ALP': 1, 'jlUSDG': 1, 'USDe': 1,
            'JLP': 2, 'JTO': 1.80, 'JUP': 0.18, 'SWTCH': 0.003,
            'kySOL': _sol*1.28, 'BulkSOL': _sol*1.08, 'hyloSOL': _sol*1.05,
            'dSOL': _sol*1.03, 'dzSOL': _sol*1.05, 'fragSOL': _sol*1.11,
            'MLP': _sol, 'INF': _sol*1.15, 'CRT': _sol*0.5,
        }
        for mint, delta in e.get('tokenChanges', {}).items():
            if delta <= 0:
                continue
            if mint in TOKEN_PRICES:
                claim_usd += delta * TOKEN_PRICES[mint]
            else:
                sym = MINT_SYMBOLS_MAP.get(mint, '')
                if sym in _sym_prices:
                    claim_usd += delta * _sym_prices[sym]
                elif mint in PRICEABLE_MINTS or sym.startswith(('SY-', 'PT-', 'YT-')) or sym.endswith('…'):
                    claim_usd += delta * price

        daily_claims_protocol[date]['count'] += 1
        daily_claims_protocol[date]['usd'] += claim_usd
        daily_claims_platform[platform][date]['count'] += 1
        daily_claims_platform[platform][date]['usd'] += claim_usd
        daily_claims_market[market][date]['count'] += 1
        daily_claims_market[market][date]['usd'] += claim_usd

        cu = claims_by_user[signer]
        cu['count'] += 1
        cu['totalUsd'] += claim_usd
        cu['markets'].add(market)
        if not cu['first'] or bt < cu['first']: cu['first'] = bt
        if not cu['last'] or bt > cu['last']: cu['last'] = bt

    # ========================================
    # 3. Holder growth + retention
    # ========================================
    print('Computing holder growth + retention...')
    first_seen = {}
    for e in events:
        signer = e.get('signer', '')
        if not signer: continue
        bt = e.get('blockTime', 0)
        if signer not in first_seen or bt < first_seen[signer]:
            first_seen[signer] = bt

    all_dates_set = set()
    all_dates_set.update(daily_activity_protocol.keys())
    holder_dates = defaultdict(int)
    for signer, bt in first_seen.items():
        d = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
        holder_dates[d] += 1
        all_dates_set.add(d)

    all_dates = sorted(all_dates_set)
    cumulative_holders = []
    running = 0
    for d in all_dates:
        running += holder_dates.get(d, 0)
        cumulative_holders.append(running)

    # Retention: new vs returning per week
    weekly_new = defaultdict(int)
    weekly_returning = defaultdict(int)
    seen = set()
    for e in events:
        action = e.get('action')
        if not action: continue
        signer = e.get('signer', '')
        bt = e.get('blockTime', 0)
        week = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-W%W')
        if signer not in seen:
            weekly_new[week] += 1
            seen.add(signer)
        else:
            weekly_returning[week] += 1

    weeks = sorted(set(list(weekly_new.keys()) + list(weekly_returning.keys())))

    # ========================================
    # 4. Enriched user profiles (merge trader + holder + claimer)
    # ========================================
    print('Building enriched user profiles...')
    user_profiles = defaultdict(lambda: {
        'txs': 0, 'buyYt': 0, 'sellYt': 0, 'buyPt': 0, 'sellPt': 0,
        'addLiq': 0, 'removeLiq': 0, 'claimYield': 0, 'redeemPt': 0, 'strip': 0,
        'markets': set(), 'first': None, 'last': None, 'claimUsd': 0.0,
    })

    for e in events:
        action = e.get('action')
        if not action: continue
        signer = e.get('signer', '')
        bt = e.get('blockTime', 0)
        market = resolve_market(e)
        up = user_profiles[signer]
        up['txs'] += 1
        if action in up: up[action] += 1
        up['markets'].add(market)
        if not up['first'] or bt < up['first']: up['first'] = bt
        if not up['last'] or bt > up['last']: up['last'] = bt

    for signer, cu in claims_by_user.items():
        user_profiles[signer]['claimUsd'] = cu['totalUsd']

    # Merge with current holder USD values
    holders_path = os.path.join(ROOT, 'web', 'public', 'holders.json')
    wallet_holdings = defaultdict(float)
    if os.path.exists(holders_path):
        for snap in json.load(open(holders_path)).values():
            for h in snap.get('top', []):
                wallet_holdings[h.get('owner', '')] += h.get('usd', 0)

    enriched_users = []
    for w, up in user_profiles.items():
        enriched_users.append({
            'wallet': w,
            'holdingUsd': round(wallet_holdings.get(w, 0), 2),
            'claimUsd': round(up['claimUsd'], 2),
            'txs': up['txs'],
            'buyYt': up['buyYt'], 'sellYt': up['sellYt'],
            'buyPt': up['buyPt'], 'sellPt': up['sellPt'],
            'addLiq': up['addLiq'], 'removeLiq': up['removeLiq'],
            'claimYield': up['claimYield'], 'redeemPt': up['redeemPt'],
            'markets': len(up['markets']),
            'type': 'protocol' if w in PROTOCOL_ADDRS else 'user',
            'firstDate': datetime.fromtimestamp(up['first'], tz=timezone.utc).strftime('%Y-%m-%d') if up['first'] else None,
            'lastDate': datetime.fromtimestamp(up['last'], tz=timezone.utc).strftime('%Y-%m-%d') if up['last'] else None,
        })
    enriched_users.sort(key=lambda x: -(x['holdingUsd'] + x['claimUsd'] + x['txs']))

    # ========================================
    # 5. Market activity columns
    # ========================================
    print('Computing market activity columns...')
    market_activity = {}
    for e in events:
        market = resolve_market(e)
        if not market: continue
        action = e.get('action', 'other')
        if market not in market_activity:
            market_activity[market] = {'txs': 0, 'users': set(), 'actions': defaultdict(int)}
        ma = market_activity[market]
        ma['txs'] += 1
        ma['users'].add(e.get('signer', ''))
        ma['actions'][action] += 1

    market_cols = {}
    for mk, ma in market_activity.items():
        market_cols[mk] = {
            'txs': ma['txs'],
            'users': len(ma['users']),
            'trades': sum(ma['actions'].get(a, 0) for a in ['buyYt', 'sellYt', 'buyPt', 'sellPt']),
            'claims': ma['actions'].get('claimYield', 0),
            'lpEvents': ma['actions'].get('addLiq', 0) + ma['actions'].get('removeLiq', 0),
        }

    # ========================================
    # 6. Whale activity — largest single-day events
    # ========================================
    print('Computing whale activity...')
    whale_events = []
    for e in events:
        action = e.get('action')
        if not action: continue
        tc = e.get('tokenChanges', {})
        if not tc: continue
        bt = e.get('blockTime', 0)
        date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
        market = resolve_market(e)
        pk = MARKET_PRICE_KEY.get(market, 'USD')
        price = get_price(date, pk)

        # Estimate USD value
        usd = 0
        for mint, delta in tc.items():
            sym = MINT_SYMBOLS_MAP.get(mint, '')
            if mint in TOKEN_PRICES:
                usd += abs(delta) * TOKEN_PRICES[mint]
            elif sym in {'SOL', 'USDC', 'USDT', 'USX', 'eUSX', 'ONyc', 'BulkSOL', 'hyloSOL', 'fragSOL', 'kySOL', 'dSOL'}:
                usd += abs(delta) * price
            elif sym.startswith(('SY-', 'PT-', 'YT-')):
                usd += abs(delta) * price

        if usd > 50000:
            whale_events.append({
                'date': date,
                'wallet': e.get('signer', '')[:20] + '...',
                'market': market,
                'action': action,
                'usd': round(usd),
            })

    whale_events.sort(key=lambda x: -x['usd'])
    whale_events = whale_events[:100]

    # ========================================
    # 7. Trade size distribution
    # ========================================
    print('Computing trade size distribution...')
    trade_sizes = {'<$100': 0, '$100-$1K': 0, '$1K-$10K': 0, '$10K-$100K': 0, '$100K-$1M': 0, '>$1M': 0}
    trade_actions = {'buyYt', 'sellYt', 'buyPt', 'sellPt'}
    for e in events:
        if e.get('action') not in trade_actions: continue
        tc = e.get('tokenChanges', {})
        bt = e.get('blockTime', 0)
        date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
        market = resolve_market(e)
        pk = MARKET_PRICE_KEY.get(market, 'USD')
        price = get_price(date, pk)
        usd = sum(abs(d) * price for d in tc.values())
        if usd < 100: trade_sizes['<$100'] += 1
        elif usd < 1000: trade_sizes['$100-$1K'] += 1
        elif usd < 10000: trade_sizes['$1K-$10K'] += 1
        elif usd < 100000: trade_sizes['$10K-$100K'] += 1
        elif usd < 1000000: trade_sizes['$100K-$1M'] += 1
        else: trade_sizes['>$1M'] += 1

    # ========================================
    # 8. Market lifecycle stats
    # ========================================
    print('Computing market lifecycle stats...')
    market_lifecycles = {}
    for mk, ma in market_activity.items():
        if mk == 'unknown': continue
        meta = MARKET_META.get(mk, {})
        mat_date = meta.get('maturityDate', '')
        first_date = None
        last_date = None
        for e in events:
            if resolve_market(e) != mk: continue
            bt = e.get('blockTime', 0)
            d = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
            if not first_date or d < first_date: first_date = d
            if not last_date or d > last_date: last_date = d

        if first_date and mat_date:
            lifespan = (datetime.strptime(mat_date, '%Y-%m-%d') - datetime.strptime(first_date, '%Y-%m-%d')).days
        else:
            lifespan = 0

        market_lifecycles[mk] = {
            'platform': normalize_platform(MARKET_PLATFORM.get(mk, '')),
            'status': meta.get('status', 'expired'),
            'maturityDate': mat_date,
            'firstActivity': first_date,
            'lastActivity': last_date,
            'lifespanDays': lifespan,
            'txs': ma['txs'],
            'users': len(ma['users']),
        }

    # Aggregate lifecycle stats
    lifespans = [v['lifespanDays'] for v in market_lifecycles.values() if v['lifespanDays'] > 0]
    lifecycle_summary = {
        'totalMarkets': len(market_lifecycles),
        'avgLifespanDays': round(sum(lifespans) / max(1, len(lifespans))),
        'medianLifespanDays': sorted(lifespans)[len(lifespans)//2] if lifespans else 0,
        'shortestDays': min(lifespans) if lifespans else 0,
        'longestDays': max(lifespans) if lifespans else 0,
    }

    # Markets per month (creation velocity)
    markets_by_month = defaultdict(int)
    for mk, lc in market_lifecycles.items():
        if lc.get('firstActivity'):
            month = lc['firstActivity'][:7]
            markets_by_month[month] += 1

    # ========================================
    # 9. Unclaimed yields
    # ========================================
    print('Computing unclaimed yields...')
    holders_path = os.path.join(ROOT, 'web', 'public', 'holders.json')
    unclaimed = {'byMarket': {}, 'byWallet': [], 'summary': {}}

    if os.path.exists(holders_path):
        holders_data = json.load(open(holders_path))
        live_path = os.path.join(ROOT, 'web', 'public', 'markets-live.json')
        live_markets = json.load(open(live_path)).get('markets', []) if os.path.exists(live_path) else []

        # Per-market: total claims vs estimated yield
        claims_per_market_total = defaultdict(float)
        for e in events:
            if e.get('action') != 'claimYield': continue
            market = resolve_market(e)
            bt = e.get('blockTime', 0)
            date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
            pk = MARKET_PRICE_KEY.get(market, 'USD')
            price = get_price(date, pk)
            for mint, delta in e.get('tokenChanges', {}).items():
                if delta > 0 and (mint in PRICEABLE_MINTS or MINT_SYMBOLS_MAP.get(mint, '').startswith(('SY-', 'PT-', 'YT-'))):
                    claims_per_market_total[market] += delta * price

        # Per-wallet claim totals
        wallet_claims = defaultdict(float)
        for e in events:
            if e.get('action') != 'claimYield': continue
            signer = e.get('signer', '')
            bt = e.get('blockTime', 0)
            date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
            market = resolve_market(e)
            pk = MARKET_PRICE_KEY.get(market, 'USD')
            price = get_price(date, pk)
            for mint, delta in e.get('tokenChanges', {}).items():
                if delta > 0 and (mint in PRICEABLE_MINTS or MINT_SYMBOLS_MAP.get(mint, '').startswith(('SY-', 'PT-', 'YT-'))):
                    wallet_claims[signer] += delta * price

        # YT holders who haven't claimed
        never_claimed = []
        for snap_key, snap in holders_data.items():
            if ':yt' not in snap_key: continue
            market = snap_key.replace(':yt', '')
            for h in snap.get('top', []):
                wallet = h.get('owner', '')
                balance_usd = h.get('usd', 0)
                claimed = wallet_claims.get(wallet, 0)
                never_claimed.append({
                    'wallet': wallet,
                    'market': market,
                    'ytBalanceUsd': round(balance_usd, 2),
                    'totalClaimed': round(claimed, 2),
                    'hasClaimed': claimed > 0,
                })

        never_claimed.sort(key=lambda x: -x['ytBalanceUsd'])

        # Summary
        total_yt_holders = len(set(x['wallet'] for x in never_claimed))
        total_never_claimed = len(set(x['wallet'] for x in never_claimed if not x['hasClaimed']))
        total_yt_usd = sum(x['ytBalanceUsd'] for x in never_claimed)

        unclaimed = {
            'byWallet': never_claimed[:200],
            'summary': {
                'totalYtHolders': total_yt_holders,
                'neverClaimed': total_never_claimed,
                'neverClaimedPct': round(total_never_claimed / max(1, total_yt_holders) * 100, 1),
                'totalYtPositionUsd': round(total_yt_usd),
                'totalClaimedUsd': round(sum(wallet_claims.values())),
            },
        }

    # ========================================
    # Build output
    # ========================================
    print('Building output...')

    # Activity series by protocol
    activity_protocol = {a: [daily_activity_protocol.get(d, {}).get(a, 0) for d in all_dates] for a in action_types}

    # Activity by platform (consolidated)
    activity_by_platform = {}
    for platform in daily_activity_platform:
        norm = normalize_platform(platform)
        if norm not in activity_by_platform:
            activity_by_platform[norm] = {a: [0] * len(all_dates) for a in action_types}
        for i, d in enumerate(all_dates):
            for a in action_types:
                activity_by_platform[norm][a][i] += daily_activity_platform[platform].get(d, {}).get(a, 0)

    # Claims series
    claims_protocol = {
        'count': [daily_claims_protocol.get(d, {}).get('count', 0) for d in all_dates],
        'usd': [round(daily_claims_protocol.get(d, {}).get('usd', 0)) for d in all_dates],
    }

    claims_by_platform_out = {}
    for platform in daily_claims_platform:
        norm = normalize_platform(platform)
        if norm not in claims_by_platform_out:
            claims_by_platform_out[norm] = {'count': [0]*len(all_dates), 'usd': [0.0]*len(all_dates)}
        for i, d in enumerate(all_dates):
            claims_by_platform_out[norm]['count'][i] += daily_claims_platform[platform].get(d, {}).get('count', 0)
            claims_by_platform_out[norm]['usd'][i] += daily_claims_platform[platform].get(d, {}).get('usd', 0)
    for norm in claims_by_platform_out:
        claims_by_platform_out[norm]['usd'] = [round(v) for v in claims_by_platform_out[norm]['usd']]

    claims_by_market_out = {}
    for market in daily_claims_market:
        claims_by_market_out[market] = {
            'count': [daily_claims_market[market].get(d, {}).get('count', 0) for d in all_dates],
            'usd': [round(daily_claims_market[market].get(d, {}).get('usd', 0)) for d in all_dates],
        }

    output = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'dates': all_dates,

        # For HistoricalChart: Activity metric
        'activityProtocol': activity_protocol,
        'activityByPlatform': activity_by_platform,

        # For HistoricalChart: Claims metric
        'claimsProtocol': claims_protocol,
        'claimsByPlatform': claims_by_platform_out,
        'claimsByMarket': claims_by_market_out,

        # For Holders tab: growth + retention
        'holderGrowth': cumulative_holders,
        'retention': {
            'weeks': weeks,
            'new': [weekly_new.get(w, 0) for w in weeks],
            'returning': [weekly_returning.get(w, 0) for w in weeks],
        },

        # For Holders tab: enriched user leaderboard (top 100)
        'enrichedUsers': enriched_users[:100],

        # For MarketCards: activity columns per market
        'marketActivity': market_cols,

        # Unclaimed yields
        'unclaimed': unclaimed,

        # Whale events (top 100 by USD)
        'whaleEvents': whale_events,

        # Trade size distribution
        'tradeSizes': trade_sizes,

        # Market lifecycle
        'lifecycleSummary': lifecycle_summary,
        'marketsPerMonth': dict(markets_by_month),

        # Stats
        'stats': {
            'totalEvents': len(events),
            'totalWallets': len(first_seen),
            'totalClaims': sum(d['count'] for d in claims_by_user.values()),
            'totalClaimUsd': round(sum(d['totalUsd'] for d in claims_by_user.values())),
            'totalClaimers': len(claims_by_user),
        },
    }

    json.dump(output, open(OUT, 'w'))
    size_mb = os.path.getsize(OUT) / 1e6
    print(f'\nWrote {OUT} ({size_mb:.1f} MB)')
    print(f'  {len(all_dates)} days, {len(first_seen):,} wallets')
    print(f'  Claims: {output["stats"]["totalClaims"]:,} totaling ${output["stats"]["totalClaimUsd"]:,}')
    print(f'  Enriched users: {len(enriched_users):,} (top 100 saved)')


if __name__ == '__main__':
    main()
