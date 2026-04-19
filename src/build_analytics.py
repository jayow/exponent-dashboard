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
from datetime import datetime, timezone, timedelta
from collections import defaultdict
sys.path.insert(0, os.path.dirname(__file__))
from config import DATA_DIR

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Use final index if available, fall back to enriched
ENRICHED_DIR = os.path.join(DATA_DIR, 'index', 'final') if os.path.exists(os.path.join(DATA_DIR, 'index', 'final')) else os.path.join(DATA_DIR, 'index', 'enriched')
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
    daily_activity_usd_protocol = defaultdict(lambda: defaultdict(float))
    daily_activity_platform = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    daily_activity_market = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))

    _sol_prices = PRICES.get('SOL', {})
    _sym_price_map = {
        'SOL': lambda d: _sol_prices.get(d, 88), 'USDC': lambda d: 1, 'USDT': lambda d: 1,
        'USD': lambda d: 1, 'USX': lambda d: 1, 'eUSX': lambda d: 1, 'ONyc': lambda d: 1,
        'USDC+': lambda d: 1, 'sHYUSD': lambda d: 1, 'legacyUSD*': lambda d: 1,
        'kySOL': lambda d: _sol_prices.get(d, 88) * 1.28,
        'BulkSOL': lambda d: _sol_prices.get(d, 88) * 1.08,
        'hyloSOL': lambda d: _sol_prices.get(d, 88) * 1.05,
        'fragSOL': lambda d: _sol_prices.get(d, 88) * 1.11,
        'dSOL': lambda d: _sol_prices.get(d, 88) * 1.03,
        'MLP': lambda d: _sol_prices.get(d, 88),
    }

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

        # Estimate USD volume for this event
        tc = e.get('tokenChanges', {})
        pk = MARKET_PRICE_KEY.get(market, 'USD')
        price = get_price(date, pk)
        usd = 0
        for mint, delta in tc.items():
            if delta < 0:
                sym = MINT_SYMBOLS_MAP.get(mint, '')
                if sym in _sym_price_map:
                    usd += abs(delta) * _sym_price_map[sym](date)
                elif mint in TOKEN_PRICES:
                    usd += abs(delta) * TOKEN_PRICES[mint]
                elif sym.startswith(('SY-', 'PT-', 'YT-')) or mint in PRICEABLE_MINTS:
                    usd += abs(delta) * price
        daily_activity_usd_protocol[date][action] += usd

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
        # Use Monday of the week as the key (YYYY-MM-DD)
        dt = datetime.fromtimestamp(bt, tz=timezone.utc)
        monday = dt - timedelta(days=dt.weekday())
        week = monday.strftime('%Y-%m-%d')
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

    # Per-wallet: current YT positions (for unclaimed)
    wallet_yt_usd = defaultdict(float)
    wallet_yt_markets = defaultdict(list)
    if os.path.exists(holders_path):
        for snap_key, snap in json.load(open(holders_path)).items():
            if ':yt' not in snap_key: continue
            market = snap_key.replace(':yt', '')
            for h in snap.get('top', []):
                wallet_yt_usd[h['owner']] += h.get('usd', 0)
                if h.get('usd', 0) > 0:
                    wallet_yt_markets[h['owner']].append(market)

    enriched_users = []
    for w, up in user_profiles.items():
        has_claimed = up['claimYield'] > 0
        yt_usd = wallet_yt_usd.get(w, 0)
        unclaimed_usd = yt_usd if not has_claimed and yt_usd > 0 else 0

        enriched_users.append({
            'wallet': w,
            'holdingUsd': round(wallet_holdings.get(w, 0), 2),
            'claimUsd': round(up['claimUsd'], 2),
            'unclaimedUsd': round(unclaimed_usd, 2),
            'unclaimedMarkets': wallet_yt_markets.get(w, []) if not has_claimed else [],
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
    # 9. Unclaimed yields (active + expired markets)
    # ========================================
    print('Computing unclaimed yields...')
    holders_path = os.path.join(ROOT, 'web', 'public', 'holders.json')
    unclaimed = {'byWallet': [], 'summary': {}}

    # Per-wallet: total claimed USD from all events
    wallet_claims_usd = defaultdict(float)
    wallet_claim_markets = defaultdict(set)
    for e in events:
        if e.get('action') != 'claimYield': continue
        signer = e.get('signer', '')
        market = resolve_market(e)
        bt = e.get('blockTime', 0)
        date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
        pk = MARKET_PRICE_KEY.get(market, 'USD')
        price = get_price(date, pk)
        _sol = PRICES.get('SOL', {}).get(date, 88)
        _sym_prices_local = {
            'SOL': _sol, 'USDC': 1, 'USDT': 1, 'USD': 1, 'USX': 1, 'eUSX': 1,
            'ONyc': 1, 'USDC+': 1, 'sHYUSD': 1, 'legacyUSD*': 1,
            'kySOL': _sol*1.28, 'BulkSOL': _sol*1.08, 'hyloSOL': _sol*1.05,
            'fragSOL': _sol*1.11, 'dSOL': _sol*1.03, 'MLP': _sol,
            'JTO': 1.80, 'SWTCH': 0.003, 'JUP': 0.18,
        }
        for mint, delta in e.get('tokenChanges', {}).items():
            if delta <= 0: continue
            sym = MINT_SYMBOLS_MAP.get(mint, '')
            if mint in TOKEN_PRICES:
                wallet_claims_usd[signer] += delta * TOKEN_PRICES[mint]
            elif sym in _sym_prices_local:
                wallet_claims_usd[signer] += delta * _sym_prices_local[sym]
            elif mint in PRICEABLE_MINTS or sym.startswith(('SY-', 'PT-', 'YT-')):
                wallet_claims_usd[signer] += delta * price
        wallet_claim_markets[signer].add(market)

    # Per-wallet: all YT buy events (active + expired) to track who ever held YT
    wallet_yt_bought = defaultdict(lambda: {'totalUsd': 0, 'markets': set()})
    for e in events:
        if e.get('action') != 'buyYt': continue
        signer = e.get('signer', '')
        market = resolve_market(e)
        bt = e.get('blockTime', 0)
        date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
        pk = MARKET_PRICE_KEY.get(market, 'USD')
        price = get_price(date, pk)
        tc = e.get('tokenChanges', {})
        cost = sum(abs(d) * price for d in tc.values() if d < 0)
        wallet_yt_bought[signer]['totalUsd'] += cost
        wallet_yt_bought[signer]['markets'].add(market)

    # Current YT holders from holders.json (active markets)
    current_yt = defaultdict(lambda: {'positions': [], 'totalUsd': 0})
    if os.path.exists(holders_path):
        holders_data = json.load(open(holders_path))
        for snap_key, snap in holders_data.items():
            if ':yt' not in snap_key: continue
            market = snap_key.replace(':yt', '')
            for h in snap.get('top', []):
                wallet = h.get('owner', '')
                usd = h.get('usd', 0)
                current_yt[wallet]['positions'].append({'market': market, 'usd': round(usd, 2)})
                current_yt[wallet]['totalUsd'] += usd

    # Build per-wallet unclaimed summary
    all_yt_wallets = set(wallet_yt_bought.keys()) | set(current_yt.keys())
    wallet_unclaimed = []
    for wallet in all_yt_wallets:
        bought = wallet_yt_bought.get(wallet, {'totalUsd': 0, 'markets': set()})
        current = current_yt.get(wallet, {'totalUsd': 0, 'positions': []})
        claimed = wallet_claims_usd.get(wallet, 0)
        claim_mkts = wallet_claim_markets.get(wallet, set())
        all_markets = bought['markets'] | set(p['market'] for p in current['positions']) | claim_mkts

        wallet_unclaimed.append({
            'wallet': wallet,
            'currentYtUsd': round(current['totalUsd'], 2),
            'totalBoughtUsd': round(bought['totalUsd'], 2),
            'totalClaimedUsd': round(claimed, 2),
            'markets': len(all_markets),
            'activePositions': len(current['positions']),
            'hasClaimed': claimed > 0,
        })

    # Only keep wallets with unclaimed yield:
    # - Has active positions and never claimed
    # - Or bought YT in expired markets and never claimed (missed yield)
    wallet_unclaimed = [w for w in wallet_unclaimed if not w['hasClaimed']]
    wallet_unclaimed.sort(key=lambda x: -(x['currentYtUsd'] + x['totalBoughtUsd']))

    total_wallets = len(wallet_unclaimed)
    never_claimed = sum(1 for w in wallet_unclaimed if not w['hasClaimed'])
    with_active = sum(1 for w in wallet_unclaimed if w['activePositions'] > 0)
    active_never = sum(1 for w in wallet_unclaimed if w['activePositions'] > 0 and not w['hasClaimed'])

    unclaimed = {
        'byWallet': wallet_unclaimed[:200],
        'summary': {
            'totalYtWallets': total_wallets,
            'neverClaimed': never_claimed,
            'neverClaimedPct': round(never_claimed / max(1, total_wallets) * 100, 1),
            'withActivePositions': with_active,
            'activeNeverClaimed': active_never,
            'totalCurrentYtUsd': round(sum(w['currentYtUsd'] for w in wallet_unclaimed)),
            'totalClaimedUsd': round(sum(wallet_claims_usd.values())),
            'totalBoughtUsd': round(sum(w['totalBoughtUsd'] for w in wallet_unclaimed)),
        },
    }

    # ========================================
    # 10-11. Protocol fee revenue
    # ========================================
    print('Computing fee revenue...')
    daily_fees_protocol = defaultdict(float)
    fees_by_market = defaultdict(float)
    fees_by_platform = defaultdict(float)
    total_gas_usd = 0

    for e in events:
        bt = e.get('blockTime', 0)
        date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
        market = resolve_market(e)
        platform = normalize_platform(MARKET_PLATFORM.get(market, ''))
        pk = MARKET_PRICE_KEY.get(market, 'USD')
        price = get_price(date, pk)

        # Fee transfers (from inner instructions)
        for fee in (e.get('fees') or []):
            decimals = MARKET_DECIMALS.get(market, 6)
            fee_usd = fee['amount'] / (10 ** decimals) * price
            daily_fees_protocol[date] += fee_usd
            fees_by_market[market] += fee_usd
            fees_by_platform[platform] += fee_usd

        # Gas costs
        gas_lamports = e.get('gasFee', 0)
        if gas_lamports:
            sol_price = PRICES.get('SOL', {}).get(date, 88)
            total_gas_usd += gas_lamports / 1e9 * sol_price

    fee_series = [round(daily_fees_protocol.get(d, 0), 2) for d in all_dates]

    # ========================================
    # 17. Position duration
    # ========================================
    print('Computing position duration...')
    # Track first buy and last sell/redeem per (wallet, market, type)
    position_events = defaultdict(lambda: {'open': None, 'close': None, 'type': None})
    for e in events:
        action = e.get('action', '')
        signer = e.get('signer', '')
        market = resolve_market(e)
        bt = e.get('blockTime', 0)
        if not signer or not market: continue

        if action in ('buyYt', 'buyPt', 'addLiq'):
            pos_type = 'yt' if action == 'buyYt' else 'pt' if action == 'buyPt' else 'lp'
            key = f'{signer}:{market}:{pos_type}'
            if not position_events[key]['open'] or bt < position_events[key]['open']:
                position_events[key]['open'] = bt
                position_events[key]['type'] = pos_type

        elif action in ('sellYt', 'sellPt', 'removeLiq', 'redeemPt'):
            pos_type = 'yt' if action == 'sellYt' else 'pt' if action in ('sellPt', 'redeemPt') else 'lp'
            key = f'{signer}:{market}:{pos_type}'
            if not position_events[key]['close'] or bt > position_events[key]['close']:
                position_events[key]['close'] = bt

    durations = {'yt': [], 'pt': [], 'lp': []}
    for key, pos in position_events.items():
        if pos['open'] and pos['close'] and pos['close'] > pos['open']:
            days = (pos['close'] - pos['open']) / 86400
            if days > 0 and days < 1000:
                durations[pos['type'] or 'yt'].append(round(days, 1))

    duration_stats = {}
    for pos_type, d_list in durations.items():
        if d_list:
            d_list.sort()
            duration_stats[pos_type] = {
                'count': len(d_list),
                'avgDays': round(sum(d_list) / len(d_list), 1),
                'medianDays': d_list[len(d_list) // 2],
                'minDays': d_list[0],
                'maxDays': d_list[-1],
            }

    # ========================================
    # 19. Strip/merge activity
    # ========================================
    print('Computing strip/merge activity...')
    daily_strips = defaultdict(int)
    daily_merges = defaultdict(int)
    for e in events:
        action = e.get('action', '')
        bt = e.get('blockTime', 0)
        date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
        if action == 'strip': daily_strips[date] += 1
        elif action == 'redeemPt': daily_merges[date] += 1

    # ========================================
    # 20. Redemption speed post-maturity
    # ========================================
    print('Computing redemption speed...')
    redemption_speed = {}
    for mk, meta in MARKET_META.items():
        if meta.get('status') != 'expired': continue
        mat_ts = meta.get('maturityTs', 0)
        if not mat_ts: continue
        redeems_1d = 0
        redeems_7d = 0
        redeems_30d = 0
        redeems_total = 0
        for e in events:
            if e.get('action') != 'redeemPt': continue
            if resolve_market(e) != mk: continue
            bt = e.get('blockTime', 0)
            if bt < mat_ts: continue
            days_after = (bt - mat_ts) / 86400
            redeems_total += 1
            if days_after <= 1: redeems_1d += 1
            if days_after <= 7: redeems_7d += 1
            if days_after <= 30: redeems_30d += 1
        if redeems_total > 0:
            redemption_speed[mk] = {
                'total': redeems_total,
                'within1d': redeems_1d,
                'within7d': redeems_7d,
                'within30d': redeems_30d,
                'pct1d': round(redeems_1d / redeems_total * 100, 1),
                'pct7d': round(redeems_7d / redeems_total * 100, 1),
                'pct30d': round(redeems_30d / redeems_total * 100, 1),
            }

    # ========================================
    # 25. Claim efficiency (gas cost vs claim value)
    # ========================================
    print('Computing claim efficiency...')
    claim_efficiency = {'profitable': 0, 'unprofitable': 0, 'totalGasUsd': 0, 'totalClaimUsd': 0}
    for e in events:
        if e.get('action') != 'claimYield': continue
        bt = e.get('blockTime', 0)
        date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
        gas_lamports = e.get('gasFee', 0)
        sol_price = PRICES.get('SOL', {}).get(date, 88)
        gas_usd = gas_lamports / 1e9 * sol_price

        # Estimate claim value
        market = resolve_market(e)
        pk = MARKET_PRICE_KEY.get(market, 'USD')
        price = get_price(date, pk)
        claim_val = 0
        for mint, delta in e.get('tokenChanges', {}).items():
            if delta > 0:
                sym = MINT_SYMBOLS_MAP.get(mint, '')
                if mint in TOKEN_PRICES:
                    claim_val += delta * TOKEN_PRICES[mint]
                elif sym.startswith(('SY-', 'PT-', 'YT-')) or mint in PRICEABLE_MINTS:
                    claim_val += delta * price

        claim_efficiency['totalGasUsd'] += gas_usd
        claim_efficiency['totalClaimUsd'] += claim_val
        if claim_val > gas_usd:
            claim_efficiency['profitable'] += 1
        else:
            claim_efficiency['unprofitable'] += 1

    claim_efficiency['totalGasUsd'] = round(claim_efficiency['totalGasUsd'], 2)
    claim_efficiency['totalClaimUsd'] = round(claim_efficiency['totalClaimUsd'], 2)

    # ========================================
    # 1-2, 34. PT/YT price history + implied APY
    # ========================================
    print('Computing PT price history...')
    import math
    pt_prices_by_market = defaultdict(list)
    for e in events:
        action = e.get('action', '')
        market = resolve_market(e)
        bt = e.get('blockTime', 0)
        if not market or not bt: continue
        if action not in ('buyPt', 'sellPt'): continue
        tc = e.get('tokenChanges', {})
        underlying_amt = 0
        pt_amt = 0
        for mint, delta in tc.items():
            sym = MINT_SYMBOLS_MAP.get(mint, '')
            if sym.startswith('PT-'):
                pt_amt = abs(delta)
            elif sym.startswith('SY-'):
                continue
            elif abs(delta) > 0.001:
                underlying_amt = abs(delta)
        if pt_amt > 0 and underlying_amt > 0:
            pt_price = underlying_amt / pt_amt
            if 0.5 < pt_price < 1.5:
                date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
                pt_prices_by_market[market].append((date, bt, round(pt_price, 6)))

    # Build daily PT price (median per day) + implied APY per market
    daily_pt_price = {}
    daily_implied_apy = {}
    for mk, prices in pt_prices_by_market.items():
        prices.sort(key=lambda x: x[1])
        mat_ts = 0
        for m_data in MARKET_META.values():
            if m_data.get('key') == mk:
                mat_ts = m_data.get('maturityTs', 0)
                break

        # Group by day and take median
        day_prices = defaultdict(list)
        day_times = {}
        for date, bt, pt_p in prices:
            day_prices[date].append(pt_p)
            day_times[date] = bt

        daily_pt = {}
        daily_apy = {}
        for date, pts in sorted(day_prices.items()):
            pts.sort()
            median_pt = pts[len(pts) // 2]
            daily_pt[date] = round(median_pt, 6)
            bt = day_times[date]
            if mat_ts > bt:
                years = (mat_ts - bt) / (365.25 * 86400)
                if years > 0.01:
                    apy = -math.log(median_pt) / years
                    daily_apy[date] = round(apy, 6)
        if daily_pt:
            daily_pt_price[mk] = daily_pt
            daily_implied_apy[mk] = daily_apy

    # ========================================
    # 18. Market rollover (expired → active)
    # ========================================
    print('Computing market rollover...')
    # Group markets by underlying ticker
    _all_markets = list(MARKET_META.values())
    markets_by_ticker = defaultdict(list)
    for m in _all_markets:
        ticker = m.get('underlyingTicker', '')
        if ticker:
            markets_by_ticker[ticker].append(m)

    rollover_data = {}
    for ticker, mkts in markets_by_ticker.items():
        mkts.sort(key=lambda m: m.get('maturityTs', 0))
        for i in range(len(mkts) - 1):
            expired = mkts[i]
            next_mk = mkts[i + 1]
            if expired.get('status') != 'expired': continue

            # Find wallets in expired market
            expired_wallets = set()
            next_wallets = set()
            for e in events:
                mk = resolve_market(e)
                signer = e.get('signer', '')
                if mk == expired['key'] and e.get('action') in ('buyYt', 'buyPt', 'addLiq'):
                    expired_wallets.add(signer)
                elif mk == next_mk['key'] and e.get('action') in ('buyYt', 'buyPt', 'addLiq'):
                    next_wallets.add(signer)

            overlap = expired_wallets & next_wallets
            if expired_wallets:
                rollover_data[f"{expired['key']}→{next_mk['key']}"] = {
                    'from': expired['key'],
                    'to': next_mk['key'],
                    'expiredUsers': len(expired_wallets),
                    'rolledOver': len(overlap),
                    'rolloverPct': round(len(overlap) / len(expired_wallets) * 100, 1),
                }

    # ========================================
    # 30. Organic vs incentivized (emission detection)
    # ========================================
    print('Computing organic vs incentivized...')
    emission_symbols = {'SWTCH', 'JTO', 'JUP', 'ORCA', 'MNDE', 'BLZE', 'F'}
    markets_with_emissions = set()
    emission_by_market = defaultdict(int)

    for e in events:
        if e.get('action') != 'claimYield': continue
        market = resolve_market(e)
        tc = e.get('tokenChanges', {})
        for mint, delta in tc.items():
            if delta > 0:
                sym = MINT_SYMBOLS_MAP.get(mint, '')
                if sym in emission_symbols:
                    markets_with_emissions.add(market)
                    emission_by_market[market] += 1

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
        'activityUsdProtocol': {a: [round(daily_activity_usd_protocol.get(d, {}).get(a, 0)) for d in all_dates] for a in action_types},
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
        'enrichedUsers': enriched_users,

        # For MarketCards: activity columns per market
        'marketActivity': market_cols,

        # Unclaimed yields
        'unclaimed': unclaimed,

        # PT price history + implied APY (per market, sparse daily)
        'ptPriceByMarket': daily_pt_price,
        'impliedApyByMarket': daily_implied_apy,

        # Market rollover
        'rollover': rollover_data,

        # Organic vs incentivized
        'marketsWithEmissions': list(markets_with_emissions),
        'emissionsByMarket': dict(emission_by_market),

        # Fee revenue
        'dailyFees': fee_series,
        'feesByMarket': {k: round(v, 2) for k, v in sorted(fees_by_market.items(), key=lambda x: -x[1]) if v > 0},
        'feesByPlatform': {k: round(v, 2) for k, v in sorted(fees_by_platform.items(), key=lambda x: -x[1]) if v > 0},
        'totalFeesUsd': round(sum(fee_series), 2),
        'totalGasUsd': round(total_gas_usd, 2),

        # Position analytics
        'positionDuration': duration_stats,
        'redemptionSpeed': redemption_speed,
        'claimEfficiency': claim_efficiency,

        # Strip/merge daily
        'dailyStrips': [daily_strips.get(d, 0) for d in all_dates],
        'dailyMerges': [daily_merges.get(d, 0) for d in all_dates],

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
    print(f'  Enriched users: {len(enriched_users):,}')


if __name__ == '__main__':
    main()
