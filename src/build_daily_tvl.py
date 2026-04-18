#!/usr/bin/env python3
"""Phase 4: Build daily TVL time series from indexed SY events + prices.

Reads:
  data/tvl/sy_events/{mint}.jsonl  (supply deltas + exchange rates)
  data/tvl/prices.json             (daily USD prices)
  data/tvl/all_markets.json        (market metadata)

Writes:
  web/public/tvl-history.json
"""
import json, sys, os, glob
from datetime import datetime, timedelta, timezone
from collections import defaultdict
sys.path.insert(0, os.path.dirname(__file__))
from config import DATA_DIR

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVENTS_DIR = os.path.join(DATA_DIR, 'tvl', 'sy_events')
PRICES_PATH = os.path.join(DATA_DIR, 'tvl', 'prices.json')
MARKETS_PATH = os.path.join(DATA_DIR, 'tvl', 'all_markets.json')
CORRECTIONS_PATH = os.path.join(DATA_DIR, 'tvl', 'sy_corrections.json')
OUT = os.path.join(ROOT, 'web', 'public', 'tvl-history.json')
TOKEN_IDS_PATH = os.path.join(DATA_DIR, 'tvl', 'sy_token_ids.json')


def load_events(mint_short):
    """Load JSONL events for a SY mint, sorted by blockTime."""
    path = os.path.join(EVENTS_DIR, f'{mint_short}.jsonl')
    if not os.path.exists(path):
        return []
    events = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except:
                continue
    events.sort(key=lambda e: e.get('blockTime', 0))
    return events


def build_daily_supply(events, decimals):
    """From a list of events, build daily supply + exchange rate snapshots."""
    daily_supply = {}
    daily_rate = {}
    running_supply_raw = 0
    last_rate = None
    last_date = None

    for ev in events:
        bt = ev.get('blockTime')
        if not bt:
            continue
        date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
        running_supply_raw += ev.get('netDelta', 0)
        daily_supply[date] = running_supply_raw / (10 ** decimals)

        rate = ev.get('exchangeRate')
        if rate is not None and rate > 0:
            # Exponent emits exchange rate as u64 with 12 decimal precision
            last_rate = rate / 1e12
            daily_rate[date] = last_rate

    return daily_supply, daily_rate


def fill_forward(series, all_dates, default=None):
    """Fill forward a sparse date→value dict across all dates."""
    filled = {}
    last = default
    for d in all_dates:
        if d in series:
            last = series[d]
        filled[d] = last
    return filled


def main():
    markets = json.load(open(MARKETS_PATH))
    prices = json.load(open(PRICES_PATH))

    # Group markets by SY mint
    sy_to_markets = defaultdict(list)
    for m in markets:
        sy_to_markets[m['syMint']].append(m)

    # Determine the price feed key for each market
    # Load token identity map for unknown SY mints
    token_ids = {}
    if os.path.exists(TOKEN_IDS_PATH):
        token_ids = json.load(open(TOKEN_IDS_PATH))

    def price_key(m):
        qt = m.get('quoteTicker', '').upper()
        if qt in ('USD', 'USDC', 'USDT'):
            return 'USD'
        if qt in ('USX', 'EUSX'):
            return 'USD'
        if qt in ('XSOL',):
            return 'xSOL'
        if 'BTC' in qt:
            return 'BTC'
        if qt == 'SOL':
            return 'SOL'
        # Look up in token identity map
        tid = token_ids.get(m.get('syMint', ''), {})
        if tid.get('price'):
            return tid['price']
        # All tokens should be identified — log if we hit this
        print(f'  WARNING: no price feed for {m.get("key")} (sy={m.get("syMint","")[:16]})')
        return 'USD'

    # Load correction factors (anchor cumulated supply to on-chain truth)
    corrections = {}
    if os.path.exists(CORRECTIONS_PATH):
        corrections = json.load(open(CORRECTIONS_PATH))
        print(f'Loaded {len(corrections)} supply correction factors')

    # Build daily supply + rate for each unique SY mint
    print('Building daily supply curves...')
    sy_daily_supply = {}
    sy_daily_rate = {}
    all_dates_set = set()

    for sy, mkts in sy_to_markets.items():
        short = sy[:16]
        decimals = mkts[0].get('underlyingDecimals', 6)
        events = load_events(short)
        if not events:
            print(f'  {short}: no events')
            continue
        supply, rate = build_daily_supply(events, decimals)
        # Apply correction factor to anchor to on-chain supply
        correction = corrections.get(sy, 1.0)
        if correction != 1.0:
            supply = {d: v * correction for d, v in supply.items()}
        sy_daily_supply[sy] = supply
        sy_daily_rate[sy] = rate
        all_dates_set.update(supply.keys())
        cf = f' (corrected {correction:.4f})' if abs(correction - 1.0) > 0.001 else ''
        print(f'  {short}: {len(events)} events → {len(supply)} days{cf}')

    if not all_dates_set:
        print('No event data found. Run index_sy_transactions.py first.')
        return

    # Add price dates
    for pk in prices:
        all_dates_set.update(prices[pk].keys())

    all_dates = sorted(all_dates_set)
    print(f'\nDate range: {all_dates[0]} to {all_dates[-1]} ({len(all_dates)} days)')

    # Fill forward supply and rates
    print('Filling forward...')
    for sy in sy_daily_supply:
        sy_daily_supply[sy] = fill_forward(sy_daily_supply[sy], all_dates, default=0)
        default_rate = 1.0
        mkts = sy_to_markets[sy]
        if mkts and mkts[0].get('interfaceType') == 'one':
            default_rate = 1.0
        sy_daily_rate[sy] = fill_forward(sy_daily_rate.get(sy, {}), all_dates, default=default_rate)

    # Fill forward prices
    for pk in prices:
        prices[pk] = fill_forward(prices[pk], all_dates, default=None)

    # Compute daily TVL per market
    print('Computing daily TVL...')
    by_market = {}
    by_platform = defaultdict(lambda: [0.0] * len(all_dates))
    protocol_tvl = [0.0] * len(all_dates)

    for m in markets:
        sy = m['syMint']
        key = m['key']
        pk = price_key(m)
        platform = m.get('platform', 'Unknown')

        supply_series = sy_daily_supply.get(sy)
        rate_series = sy_daily_rate.get(sy)
        if not supply_series:
            continue

        tvl_series = []
        shared_markets = sy_to_markets[sy]
        for i, date in enumerate(all_dates):
            supply = supply_series.get(date, 0) or 0
            rate = rate_series.get(date, 1) or 1
            price = prices.get(pk, {}).get(date)
            if price is None or supply <= 0:
                tvl_series.append(0)
                continue

            mat_date = m.get('maturityDate', '9999-12-31')
            if date >= mat_date:
                tvl_series.append(0)
                continue

            # Dynamic split: count markets sharing this SY that are still active on this date
            active_on_date = sum(1 for sm in shared_markets if date < sm.get('maturityDate', '9999-12-31'))
            share = max(1, active_on_date)

            tvl = supply * rate * price / share
            tvl_series.append(round(tvl))

        by_market[key] = tvl_series
        for i, v in enumerate(tvl_series):
            protocol_tvl[i] += v
            by_platform[platform][i] += v

    # Round protocol totals
    protocol_tvl = [round(v) for v in protocol_tvl]
    for p in by_platform:
        by_platform[p] = [round(v) for v in by_platform[p]]

    # Filter out markets with no TVL ever
    by_market = {k: v for k, v in by_market.items() if max(v) > 0}

    # Build market metadata for the frontend
    market_meta = {}
    for m in markets:
        key = m['key']
        if key not in by_market:
            continue
        tvl_arr = by_market[key]
        peak_tvl = max(tvl_arr)
        peak_date = all_dates[tvl_arr.index(peak_tvl)] if peak_tvl > 0 else None
        market_meta[key] = {
            'platform': m.get('platform', ''),
            'ticker': m.get('underlyingTicker', key.split('-')[0]),
            'maturityDate': m.get('maturityDate', ''),
            'status': m.get('status', 'expired'),
            'peakTvl': round(peak_tvl),
            'peakDate': peak_date,
        }

    # Build daily inflow/outflow/volume from raw events — protocol, platform, and market level
    print('Computing daily flows...')
    daily_inflow = defaultdict(float)
    daily_outflow = defaultdict(float)
    platform_inflow = defaultdict(lambda: defaultdict(float))
    platform_outflow = defaultdict(lambda: defaultdict(float))
    market_inflow = defaultdict(lambda: defaultdict(float))
    market_outflow = defaultdict(lambda: defaultdict(float))
    total_volume_all_time = 0

    for sy, mkts in sy_to_markets.items():
        short = sy[:16]
        decimals = mkts[0].get('underlyingDecimals', 6)
        pk = price_key(mkts[0])
        platform = mkts[0].get('platform', 'Unknown')
        events = load_events(short)
        correction = corrections.get(sy, 1.0)
        shared = len(mkts)
        for ev in events:
            bt = ev.get('blockTime')
            if not bt:
                continue
            date = datetime.fromtimestamp(bt, tz=timezone.utc).strftime('%Y-%m-%d')
            price = prices.get(pk, {}).get(date)
            if not price:
                continue
            mint_usd = (ev.get('mintDelta', 0) / (10 ** decimals)) * correction * price
            burn_usd = (ev.get('burnDelta', 0) / (10 ** decimals)) * correction * price
            daily_inflow[date] += mint_usd
            daily_outflow[date] += burn_usd
            total_volume_all_time += mint_usd + burn_usd
            platform_inflow[platform][date] += mint_usd
            platform_outflow[platform][date] += burn_usd
            # Attribute to active markets sharing this SY on this date
            active_mkts = [m for m in mkts if date < m.get('maturityDate', '9999-12-31')]
            per_market = 1 / max(1, len(active_mkts))
            for am in active_mkts:
                market_inflow[am['key']][date] += mint_usd * per_market
                market_outflow[am['key']][date] += burn_usd * per_market

    inflow_series = [round(daily_inflow.get(d, 0)) for d in all_dates]
    outflow_series = [round(daily_outflow.get(d, 0)) for d in all_dates]
    net_flow_series = [round(daily_inflow.get(d, 0) - daily_outflow.get(d, 0)) for d in all_dates]
    volume_series = [round(daily_inflow.get(d, 0) + daily_outflow.get(d, 0)) for d in all_dates]

    # Per-platform flows
    flow_by_platform = {}
    for p in platform_inflow:
        flow_by_platform[p] = {
            'inflow': [round(platform_inflow[p].get(d, 0)) for d in all_dates],
            'outflow': [round(platform_outflow[p].get(d, 0)) for d in all_dates],
        }

    # Per-market flows
    flow_by_market = {}
    for mk in market_inflow:
        flow_by_market[mk] = {
            'inflow': [round(market_inflow[mk].get(d, 0)) for d in all_dates],
            'outflow': [round(market_outflow[mk].get(d, 0)) for d in all_dates],
        }

    # Protocol stats
    active_markets = sum(1 for m in markets if m.get('status') == 'active')
    expired_markets = sum(1 for m in markets if m.get('status') == 'expired')
    unique_platforms = len(set(m.get('platform', '') for m in markets if m.get('platform')))
    peak = max(protocol_tvl)
    peak_date = all_dates[protocol_tvl.index(peak)]
    first_date = next((d for d, v in zip(all_dates, protocol_tvl) if v > 0), all_dates[0])

    # APY history — underlying APY from exchange rate changes
    print('Computing APY history...')
    underlying_apy_by_market = {}
    for sy, mkts in sy_to_markets.items():
        rate_series = sy_daily_rate.get(sy)
        if not rate_series:
            continue
        filled_rates = fill_forward(rate_series, all_dates, default=1.0)
        for m in mkts:
            key = m['key']
            mat_date = m.get('maturityDate', '9999-12-31')
            apy_series = []
            for i, d in enumerate(all_dates):
                if d >= mat_date or i < 7:
                    apy_series.append(0)
                    continue
                rate_now = filled_rates.get(d) or 1.0
                rate_7d_ago = filled_rates.get(all_dates[i - 7]) or rate_now
                if rate_7d_ago > 0 and rate_now > rate_7d_ago:
                    weekly_return = rate_now / rate_7d_ago
                    apy = (weekly_return ** (365 / 7)) - 1
                    apy_series.append(round(apy * 10000) / 10000)
                else:
                    apy_series.append(0)
            if max(apy_series) > 0:
                underlying_apy_by_market[key] = apy_series

    # Implied APY — load from daily snapshots + current live data
    implied_apy_by_market = {}
    apy_snapshots_path = os.path.join(DATA_DIR, 'tvl', 'apy_snapshots.json')
    apy_snapshots = {}
    if os.path.exists(apy_snapshots_path):
        apy_snapshots = json.load(open(apy_snapshots_path))

    # Record today's implied APY from live data
    live_path = os.path.join(ROOT, 'web', 'public', 'markets-live.json')
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    if os.path.exists(live_path):
        live = json.load(open(live_path))
        for lm in live.get('markets', []):
            d = datetime.strptime(lm['maturity'], '%Y-%m-%d')
            dd = f'{d.day:02d}'
            mmm = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.month - 1]
            yy = str(d.year)[-2:]
            mkey = f'{lm["ticker"]}-{dd}{mmm}{yy}'
            if mkey not in apy_snapshots:
                apy_snapshots[mkey] = {}
            apy_snapshots[mkey][today] = {
                'implied': round(lm.get('impliedApy', 0), 6),
                'underlying': round(lm.get('underlyingApy', 0), 6),
            }
    json.dump(apy_snapshots, open(apy_snapshots_path, 'w'), indent=2)

    # Build implied APY time series from snapshots
    for mkey, snaps in apy_snapshots.items():
        implied_series = []
        for d in all_dates:
            snap = snaps.get(d)
            implied_series.append(round(snap['implied'], 6) if snap else 0)
        # Fill forward
        last_val = 0
        for i in range(len(implied_series)):
            if implied_series[i] > 0:
                last_val = implied_series[i]
            elif last_val > 0:
                implied_series[i] = last_val
        if max(implied_series) > 0:
            implied_apy_by_market[mkey] = implied_series

    # Holder analytics from current snapshot
    holders_path = os.path.join(ROOT, 'web', 'public', 'holders.json')
    unique_holders = 0
    top_holders = []
    holder_concentration = {}
    if os.path.exists(holders_path):
        holders_data = json.load(open(holders_path))
        all_wallets = set()
        wallet_total_usd = defaultdict(float)
        for snap_key, snap in holders_data.items():
            for h in snap.get('top', []):
                owner = h.get('owner', '')
                all_wallets.add(owner)
                wallet_total_usd[owner] += h.get('usd', 0)
        unique_holders = len(all_wallets)

        # Build set of known protocol addresses
        protocol_addrs = set()
        api_path = os.path.join(DATA_DIR, 'exponent_markets_api.json')
        if os.path.exists(api_path):
            api_data = json.load(open(api_path))
            for am in api_data:
                for field in ('vaultAddress', 'syMint', 'ptMint', 'ytMint'):
                    if am.get(field): protocol_addrs.add(am[field])
                for a in am.get('legacyMarketAddresses', []): protocol_addrs.add(a)
                for a in am.get('orderbookAddresses', []): protocol_addrs.add(a)
        clmm_path = os.path.join(DATA_DIR, 'clmm_market_map.json')
        if os.path.exists(clmm_path):
            protocol_addrs.update(json.load(open(clmm_path)).keys())
        protocol_addrs.add('ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7')
        protocol_addrs.add('XPC1MM4dYACDfykNuXYZ5una2DsMDWL24CrYubCvarC')

        # Count markets per wallet
        wallet_markets = defaultdict(set)
        for snap_key, snap in holders_data.items():
            market_name = snap_key.rsplit(':', 1)[0]
            for h in snap.get('top', []):
                wallet_markets[h.get('owner', '')].add(market_name)

        # Load wallet activity data for first/last txn dates
        data_path = os.path.join(ROOT, 'web', 'public', 'data.json')
        wallet_activity = {}
        if os.path.exists(data_path):
            web_data = json.load(open(data_path))
            for w in web_data.get('wallets', []):
                wallet_activity[w['addr']] = w

        events_dir = os.path.join(ROOT, 'web', 'public', 'events')

        # Top holders across all markets with enriched data
        top_raw = sorted(
            [(w, v) for w, v in wallet_total_usd.items() if v > 0],
            key=lambda x: -x[1]
        )[:50]

        top_holders = []
        for w, usd in top_raw:
            entry = {
                'wallet': w,
                'totalUsd': round(usd, 2),
                'markets': len(wallet_markets.get(w, set())),
                'type': 'protocol' if w in protocol_addrs else 'user',
            }
            # Get first/last txn from events file
            evt_path = os.path.join(events_dir, f'{w}.json')
            if os.path.exists(evt_path):
                try:
                    events = json.load(open(evt_path))
                    if events:
                        entry['firstTxn'] = datetime.fromtimestamp(events[0].get('blockTime', 0), tz=timezone.utc).strftime('%Y-%m-%d')
                        entry['lastTxn'] = datetime.fromtimestamp(events[-1].get('blockTime', 0), tz=timezone.utc).strftime('%Y-%m-%d')
                        entry['txCount'] = len(events)
                except:
                    pass
            # Fallback from data.json
            if 'txCount' not in entry:
                wa = wallet_activity.get(w, {})
                entry['txCount'] = wa.get('txs', 0)

            top_holders.append(entry)

        # Concentration per market
        for snap_key, snap in holders_data.items():
            holders_list = snap.get('top', [])
            total = snap.get('totalBalance', 0)
            if total > 0 and len(holders_list) > 0:
                top1 = holders_list[0]['balance'] / total if holders_list else 0
                top5_sum = sum(h['balance'] for h in holders_list[:5]) / total
                top10_sum = sum(h['balance'] for h in holders_list[:10]) / total
                holder_concentration[snap_key] = {
                    'holders': snap.get('holders', 0),
                    'top1Pct': round(top1 * 100, 1),
                    'top5Pct': round(top5_sum * 100, 1),
                    'top10Pct': round(top10_sum * 100, 1),
                }

    # Market lifecycle data
    lifecycle = []
    for m in markets:
        key = m['key']
        tvl_arr = by_market.get(key, [])
        first_tvl_date = None
        for i, v in enumerate(tvl_arr):
            if v > 0:
                first_tvl_date = all_dates[i]
                break
        lifecycle.append({
            'key': key,
            'platform': m.get('platform', ''),
            'status': m.get('status', ''),
            'maturityDate': m.get('maturityDate', ''),
            'firstTvlDate': first_tvl_date,
            'peakTvl': round(max(tvl_arr)) if tvl_arr else 0,
        })
    lifecycle.sort(key=lambda x: x.get('firstTvlDate') or '9999')

    output = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'dates': all_dates,
        'protocol': protocol_tvl,
        'byMarket': by_market,
        'byPlatform': dict(by_platform),
        'marketMeta': market_meta,
        'inflow': inflow_series,
        'outflow': outflow_series,
        'netFlow': net_flow_series,
        'volume': volume_series,
        'flowByPlatform': flow_by_platform,
        'flowByMarket': flow_by_market,
        'underlyingApyByMarket': underlying_apy_by_market,
        'impliedApyByMarket': implied_apy_by_market,
        'topHolders': top_holders,
        'holderConcentration': holder_concentration,
        'lifecycle': lifecycle,
        'stats': {
            'activeMarkets': active_markets,
            'expiredMarkets': expired_markets,
            'totalMarkets': active_markets + expired_markets,
            'platforms': unique_platforms,
            'peakTvl': round(peak),
            'peakDate': peak_date,
            'currentTvl': protocol_tvl[-1],
            'totalVolume': round(total_volume_all_time),
            'uniqueHolders': unique_holders,
            'firstDate': first_date,
            'protocolAgeDays': (datetime.now(timezone.utc) - datetime.strptime(first_date, '%Y-%m-%d').replace(tzinfo=timezone.utc)).days,
        },
    }

    json.dump(output, open(OUT, 'w'))
    print(f'\nWrote {OUT}')
    print(f'  {len(all_dates)} days, {len(by_market)} markets, {len(by_platform)} platforms')
    peak = max(protocol_tvl)
    peak_date = all_dates[protocol_tvl.index(peak)]
    current = protocol_tvl[-1]
    print(f'  Peak TVL: ${peak/1e6:.1f}M on {peak_date}')
    print(f'  Current TVL: ${current/1e6:.1f}M')


if __name__ == '__main__':
    main()
