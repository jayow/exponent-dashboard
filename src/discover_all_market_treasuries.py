#!/usr/bin/env python3
"""Enumerate ALL MarketTwo accounts (active + expired) from the Exponent program.

For each MarketTwo we extract:
  - pool_address (the MarketTwo account itself)
  - mint_pt, mint_sy, vault, token_fee_treasury_sy
  - ln_fee_rate_root, fee_treasury_sy_bps (for fee/revenue/LP split)
  - expiration_ts (to match with market keys if possible)

Cross-references with the API to assign market keys; expired markets use
a synthetic key derived from token metadata + maturity.

Writes: data/all_market_treasuries.json
"""
import os, sys, json, struct, base64, base58
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(__file__))
from config import rpc, DATA_DIR

EXPONENT_PROGRAM = 'ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7'
CORE_MARKET_DISC = 'd404847ea9797914'


def pk(data, off):
    return base58.b58encode(data[off:off+32]).decode()


def decode_market(data, pool_addr):
    out = {
        'pool': pool_addr,
        'mint_pt': pk(data, 40),
        'mint_sy': pk(data, 72),
        'vault': pk(data, 104),
        'mint_lp': pk(data, 136),
        'lp_escrow': pk(data, 168),
        'pt_escrow': pk(data, 200),
        'sy_escrow': pk(data, 232),
        'treasury': pk(data, 264),
    }
    try:
        out['bps'] = struct.unpack('<H', data[296:298])[0]
    except: out['bps'] = 0
    try:
        out['expiry_ts'] = struct.unpack('<Q', data[364:372])[0]
    except: out['expiry_ts'] = 0
    try:
        out['ln_fee_root'] = struct.unpack('<d', data[388:396])[0]
    except: out['ln_fee_root'] = 0
    try:
        out['ln_implied_rate'] = struct.unpack('<d', data[396:404])[0]
    except: out['ln_implied_rate'] = 0
    try:
        out['rate_scalar_root'] = struct.unpack('<d', data[404:412])[0]
    except: out['rate_scalar_root'] = 0
    return out


def main():
    print('Fetching all MarketTwo accounts from Exponent program...')
    disc_b58 = base58.b58encode(bytes.fromhex(CORE_MARKET_DISC)).decode()
    result = rpc('getProgramAccounts', [
        EXPONENT_PROGRAM,
        {'encoding': 'base64', 'filters': [{'memcmp': {'offset': 0, 'bytes': disc_b58}}]}
    ])
    if not result:
        print('No MarketTwo accounts found')
        return
    print(f'Found {len(result)} MarketTwo accounts')

    # Load active API for market keys
    api = json.load(open(os.path.join(DATA_DIR, 'exponent_markets_api.json')))
    # Build: pool_addr → market_key for active markets
    active_pool_to_key = {}
    # Also: pt_mint → ticker (for expired market fallback)
    pt_mint_to_ticker = {}
    pt_mint_to_decimals = {}
    for m in api:
        t = m['underlyingAsset']['ticker']
        mat = datetime.fromtimestamp(m['maturityDateUnixTs'], tz=timezone.utc).strftime('%d%b%y').upper()
        key = f'{t}-{mat}'
        for addr in m.get('legacyMarketAddresses', []):
            active_pool_to_key[addr] = {
                'key': key,
                'ticker': t,
                'decimals': m.get('decimals', 6),
                'platform': m.get('platformName', ''),
                'status': 'active',
            }
        pt_mint_to_ticker[m['ptMint']] = t
        pt_mint_to_decimals[m['ptMint']] = m.get('decimals', 6)

    # Try to resolve expired markets from all_markets.json
    all_mkt_path = os.path.join(DATA_DIR, 'tvl', 'all_markets.json')
    all_mkts = json.load(open(all_mkt_path)) if os.path.exists(all_mkt_path) else []
    sy_mint_to_info = {}
    for m in all_mkts:
        sy_mint_to_info[m.get('syMint', '')] = m

    markets = []
    for acct in result:
        data = base64.b64decode(acct['account']['data'][0])
        pool_addr = acct['pubkey']
        m = decode_market(data, pool_addr)

        # Assign market key
        if pool_addr in active_pool_to_key:
            info = active_pool_to_key[pool_addr]
            m['key'] = info['key']
            m['ticker'] = info['ticker']
            m['decimals'] = info['decimals']
            m['platform'] = info['platform']
            m['status'] = 'active'
        else:
            # Expired or unknown — derive from sy_mint + expiry
            sy_info = sy_mint_to_info.get(m['mint_sy'], {})
            ticker = sy_info.get('underlyingTicker', m['mint_sy'][:8])
            mat = datetime.fromtimestamp(m['expiry_ts'], tz=timezone.utc).strftime('%d%b%y').upper() if m['expiry_ts'] else 'UNKNOWN'
            m['key'] = f'{ticker}-{mat}'
            m['ticker'] = ticker
            m['decimals'] = sy_info.get('underlyingDecimals', 6)
            m['platform'] = sy_info.get('platform', '')
            m['status'] = 'expired'

        markets.append(m)

    # Print summary
    active = [m for m in markets if m['status'] == 'active']
    expired = [m for m in markets if m['status'] == 'expired']
    print(f'Active: {len(active)}, Expired: {len(expired)}')
    for m in sorted(markets, key=lambda x: -(x.get('expiry_ts', 0))):
        exp_dt = datetime.fromtimestamp(m['expiry_ts'], tz=timezone.utc).strftime('%Y-%m-%d') if m['expiry_ts'] else '?'
        print(f'  {m["status"]:8s} {m["key"]:25s} bps={m["bps"]:4d} exp={exp_dt}  pool={m["pool"][:16]}  treasury={m["treasury"][:16]}')

    out = os.path.join(DATA_DIR, 'all_market_treasuries.json')
    json.dump(markets, open(out, 'w'), indent=2)
    print(f'\nWrote {len(markets)} markets to {out}')


if __name__ == '__main__':
    main()
