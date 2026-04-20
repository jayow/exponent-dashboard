#!/usr/bin/env python3
"""Reconstruct historical implied APY using authoritative pool PT escrow history.

Approach:
  1. pool_pt_history.json has (ts, sig, pt_balance) for every tx that touched
     each market's PT escrow — exact pool PT at every state change.
  2. For pool SY balance: walk BACKWARD from current on-chain state, applying
     SY deltas (mintDelta/burnDelta) from the matched indexed event.
  3. For rate: at each buyPt/sellPt/buyYt/sellYt event, compute rate_anchor from
     POST-trade state (current), reverse balances, compute pre-trade rate.

This is cleanly on-chain: pool PT from escrow postTokenBalances, rate from
stored MarketTwo field, SY deltas from transaction logs.

Writes: data/implied_apy_history.json
"""
import os, sys, json, glob, math, struct, base64
from datetime import datetime, timezone, timedelta
sys.path.insert(0, os.path.dirname(__file__))
from config import rpc, DATA_DIR
import base64, struct

YEAR_SEC = 31_536_000

EXCLUDE_PIDS = {
    'ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'Tokenz4ZrKpwFL2RKEh5Z7iWuFVvNW1jqTzPzhPDTDKG',
}
MIN_RATE_SCALED = int(1.0 * 1e12)
MAX_RATE_SCALED = int(2.0 * 1e12)


def decode_sy_rate_from_returns(event):
    returns = event.get('returns', {})
    if not returns:
        return 0
    for pid, b64_list in returns.items():
        if pid in EXCLUDE_PIDS:
            continue
        for b64 in b64_list:
            try:
                pad = '=' * ((4 - len(b64) % 4) % 4)
                data = base64.b64decode(b64 + pad)
            except Exception:
                continue
            for off in range(0, len(data) - 7, 8):
                rate = struct.unpack('<Q', data[off:off + 8])[0]
                if MIN_RATE_SCALED < rate < MAX_RATE_SCALED:
                    return rate
    return 0


def read_market_two(addr):
    result = rpc('getAccountInfo', [addr, {'encoding': 'base64'}])
    if not result or not result.get('value'):
        return None
    data = base64.b64decode(result['value']['data'][0])
    return {
        'expiry': struct.unpack('<Q', data[364:372])[0],
        'pt_balance': struct.unpack('<Q', data[372:380])[0],
        'sy_balance': struct.unpack('<Q', data[380:388])[0],
        'ln_fee_root': struct.unpack('<d', data[388:396])[0],
        'ln_implied_rate': struct.unpack('<d', data[396:404])[0],
        'rate_scalar_root': struct.unpack('<d', data[404:412])[0],
    }


def proportion_pt(pt, asset):
    return pt / (pt + asset)

def logit(p):
    return math.log(p / (1 - p))

def rate_scalar_fn(root, sec):
    return root / (sec / YEAR_SEC) if sec > 0 else float('inf')

def rate_from_anchor(pt, asset, scalar, anchor, sec):
    if pt <= 0 or asset <= 0 or sec <= 0:
        return None
    p = proportion_pt(pt, asset)
    if not (0 < p < 1):
        return None
    l_p = logit(p)
    xr = l_p / scalar + anchor
    if xr <= 0:
        return None
    return math.log(xr) / (sec / YEAR_SEC)

def anchor_from_rate(pt, asset, scalar, rate, sec):
    if pt <= 0 or asset <= 0 or sec <= 0:
        return None
    p = proportion_pt(pt, asset)
    if not (0 < p < 1):
        return None
    return math.exp(rate * sec / YEAR_SEC) - logit(p) / scalar


def reconstruct_market(market_key, api_entry, events_by_sig, pool_pt_entries, mint_syms):
    """Walk backward from current state using authoritative pool PT history.

    Args:
        pool_pt_entries: list of (ts, sig, pt_balance_raw) sorted by ts
        events_by_sig: dict of sig → event (from enriched index)
    """
    pool_addr = api_entry['legacyMarketAddresses'][0]
    decimals = api_entry.get('decimals', 9)
    expiry = api_entry['maturityDateUnixTs']
    current_sy_rate = api_entry.get('syExchangeRate', 1.0)

    state = read_market_two(pool_addr)
    if not state:
        return None
    scale = 10 ** decimals

    pt = state['pt_balance'] / scale
    sy = state['sy_balance'] / scale
    rate = state['ln_implied_rate']
    rate_root = state['rate_scalar_root']

    # Build SY exchange rate series from events with exchangeRate or decodable returns
    sy_rate_series = []
    for sig, e in events_by_sig.items():
        er = e.get('exchangeRate', 0)
        if er <= 0:
            er = decode_sy_rate_from_returns(e)
        if er > 0:
            sy_rate_series.append((e.get('blockTime', 0), er / 1e12))
    sy_rate_series.sort()

    def get_sy_rate(ts):
        if not sy_rate_series: return current_sy_rate
        if ts >= sy_rate_series[-1][0]: return current_sy_rate
        if ts <= sy_rate_series[0][0]: return sy_rate_series[0][1]
        lo, hi = 0, len(sy_rate_series) - 1
        while lo < hi - 1:
            mid = (lo + hi) // 2
            if sy_rate_series[mid][0] <= ts: lo = mid
            else: hi = mid
        t0, r0 = sy_rate_series[lo]; t1, r1 = sy_rate_series[hi]
        if t1 == t0: return r0
        frac = (ts - t0) / (t1 - t0)
        return r0 + frac * (r1 - r0)

    # pool_pt_entries is sorted ascending by ts. Walk BACKWARD through entries.
    history = []  # (ts, pt, sy, rate)
    history.append((int(datetime.now(timezone.utc).timestamp()), pt, sy, rate))

    def get_pt(entry):
        """Extract pt balance from entry — supports old [ts, sig, int] and new [ts, sig, {pt,...}] formats."""
        val = entry[2]
        if isinstance(val, dict):
            return val.get('pt', 0)
        return val or 0

    # Walk from newest to oldest entry
    for i in range(len(pool_pt_entries) - 1, -1, -1):
        ts, sig = pool_pt_entries[i][0], pool_pt_entries[i][1]
        pt_post = get_pt(pool_pt_entries[i]) / scale
        pt_pre = 0.0 if i == 0 else get_pt(pool_pt_entries[i - 1]) / scale

        e = events_by_sig.get(sig)
        action = e.get('action', '') if e else ''
        mint_delta = (e.get('mintDelta', 0) / scale) if e else 0
        burn_delta = (e.get('burnDelta', 0) / scale) if e else 0

        # Pool SY change (estimate from event deltas)
        # buyPt/buyYt/addLiq: pool SY gained
        # sellPt/sellYt/removeLiq: pool SY lost
        sy_change = 0.0
        if action in ('buyPt', 'buyYt', 'addLiq'):
            sy_change = mint_delta if mint_delta > 0 else 0
        elif action in ('sellPt', 'sellYt', 'removeLiq'):
            sy_change = -(burn_delta if burn_delta > 0 else 0)

        sy_pre = max(sy - sy_change, 0.01)  # clamp to small positive to avoid formula breakdown

        sec = expiry - ts
        if sec <= 0:
            continue
        scalar = rate_scalar_fn(rate_root, sec)
        sy_rate = get_sy_rate(ts)
        asset_post = sy * sy_rate
        asset_pre = sy_pre * sy_rate

        trade_pt_action = action in ('buyPt', 'sellPt', 'buyYt', 'sellYt')

        # Only recompute rate if BOTH pre and post states are valid (balances > 0, proportion sensible)
        if (trade_pt_action and pt > 0.01 and asset_post > 0.01 and
                pt_pre > 0.01 and asset_pre > 0.01):
            anchor = anchor_from_rate(pt, asset_post, scalar, rate, sec)
            if anchor is not None:
                prev_rate = rate_from_anchor(pt_pre, asset_pre, scalar, anchor, sec)
                # Only accept physically plausible rates (0-50% APY)
                if prev_rate is not None and 0 < prev_rate < 0.5:
                    rate = prev_rate

        pt = pt_pre
        sy = sy_pre
        history.append((ts, pt, sy, rate))

    history.sort(key=lambda x: x[0])

    # Collapse to daily (last entry wins per day)
    daily = {}
    for ts, pt_h, sy_h, rate_h in history:
        date = datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y-%m-%d')
        daily[date] = {
            'ptBalance': round(pt_h, 2),
            'syBalance': round(sy_h, 2),
            'lnRate': round(rate_h, 8),
            'impliedApy': round(rate_h, 6),
        }
    return daily


def main():
    targets = sys.argv[1:] if len(sys.argv) > 1 else None

    api = json.load(open(os.path.join(DATA_DIR, 'exponent_markets_api.json')))
    mint_syms = json.load(open(os.path.join(DATA_DIR, 'mint_symbols.json')))

    pool_pt_path = os.path.join(DATA_DIR, 'pool_pt_history.json')
    pool_pt_history = json.load(open(pool_pt_path)) if os.path.exists(pool_pt_path) else {}

    print('Loading events by signature...')
    events_by_sig = {}
    for f in glob.glob(os.path.join(DATA_DIR, 'index', 'enriched', '*.jsonl')):
        with open(f) as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except:
                    continue
                sig = e.get('sig', '')
                if sig:
                    events_by_sig[sig] = e
    print(f'  {len(events_by_sig):,} events indexed by sig')

    history = {}
    for m in api:
        t = m['underlyingAsset']['ticker']
        mat = datetime.fromtimestamp(m['maturityDateUnixTs'], tz=timezone.utc).strftime('%d%b%y').upper()
        key = f'{t}-{mat}'
        if targets and key not in targets: continue
        if not m.get('legacyMarketAddresses'): continue
        pool_hist = pool_pt_history.get(key, [])
        if not pool_hist:
            print(f'Skipping {key} — no pool PT history')
            continue

        print(f'Reconstructing {key} ({len(pool_hist)} pool PT entries)...')
        daily = reconstruct_market(key, m, events_by_sig, pool_hist, mint_syms)
        if daily:
            history[key] = daily
            dates = sorted(daily.keys())
            vals = [daily[d]['impliedApy']*100 for d in dates]
            print(f'  {len(dates)} days, APY {min(vals):.2f}% - {max(vals):.2f}%')

    out_path = os.path.join(DATA_DIR, 'implied_apy_history.json')
    json.dump(history, open(out_path, 'w'), indent=2)
    print(f'\nWrote {out_path}')


if __name__ == '__main__':
    main()
