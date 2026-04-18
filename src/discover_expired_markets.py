#!/usr/bin/env python3
"""Phase 0: Discover all Exponent markets (active + expired) from on-chain data.

Decodes MarketThree accounts from both the core Exponent program and the CLMM program.
Extracts SY mint, vault, PT mint, maturity timestamp for each market.
Merges with active market data from the API.

Writes data/tvl/all_markets.json
"""
import json, sys, os, struct, datetime
import base58, base64
sys.path.insert(0, os.path.dirname(__file__))
from config import rpc, DATA_DIR

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(DATA_DIR, 'tvl', 'all_markets.json')

EXPONENT_PROGRAM = 'ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7'
CORE_MARKET_DISC = 'd404847ea9797914'
TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'


def decode_pubkey(data, offset):
    return base58.b58encode(data[offset:offset+32]).decode()


def find_maturity_ts(data):
    """Try common offsets for the maturity timestamp (i64 LE)."""
    now = datetime.datetime.now(datetime.timezone.utc).timestamp()
    for offset in [416, 364, 312, 260, 208]:
        if offset + 8 > len(data):
            continue
        ts = struct.unpack('<q', data[offset:offset+8])[0]
        if 1700000000 < ts < 1900000000:
            return ts
    for offset in range(104, min(len(data) - 7, 500), 8):
        ts = struct.unpack('<q', data[offset:offset+8])[0]
        if 1700000000 < ts < 1900000000:
            return ts
    return None


def get_token_name(mint_addr):
    """Try to get token name from on-chain metadata."""
    try:
        result = rpc('getAccountInfo', [mint_addr, {'encoding': 'jsonParsed'}])
        if result and result.get('value'):
            parsed = result['value'].get('data', {})
            if isinstance(parsed, dict) and 'parsed' in parsed:
                info = parsed['parsed'].get('info', {})
                return info.get('name', ''), info.get('symbol', ''), info.get('decimals', 6)
    except:
        pass
    return '', '', 6


def main():
    api_path = os.path.join(DATA_DIR, 'exponent_markets_api.json')
    api_markets = json.load(open(api_path))

    # Build lookup maps from active markets
    active_by_sy = {}
    active_by_vault = {}
    active_by_pt = {}
    active_by_yt = {}
    active_list = []

    for m in api_markets:
        t = m['underlyingAsset']['ticker']
        mat = datetime.datetime.fromtimestamp(
            m['maturityDateUnixTs'], tz=datetime.timezone.utc
        ).strftime('%d%b%y').upper()
        key = f'{t}-{mat}'
        entry = {
            'key': key,
            'syMint': m['syMint'],
            'vault': m['vaultAddress'],
            'ptMint': m['ptMint'],
            'ytMint': m['ytMint'],
            'underlyingMint': m['underlyingAsset']['mint'],
            'underlyingTicker': t,
            'underlyingDecimals': m.get('decimals', 6),
            'quoteMint': m.get('quoteAsset', {}).get('mint', m['underlyingAsset']['mint']),
            'quoteTicker': m.get('quoteAsset', {}).get('ticker', t),
            'maturityTs': m['maturityDateUnixTs'],
            'maturityDate': datetime.datetime.fromtimestamp(
                m['maturityDateUnixTs'], tz=datetime.timezone.utc
            ).strftime('%Y-%m-%d'),
            'platform': m.get('platformName', ''),
            'syExchangeRate': m.get('syExchangeRate', 1),
            'interfaceType': m.get('interfaceType', ''),
            'status': 'active',
        }
        active_list.append(entry)
        active_by_sy[m['syMint']] = key
        active_by_vault[m['vaultAddress']] = key
        active_by_pt[m['ptMint']] = key
        active_by_yt[m['ytMint']] = key

    print(f'Active markets from API: {len(active_list)}')

    # Fetch all MarketThree accounts from core program
    disc_b58 = base58.b58encode(bytes.fromhex(CORE_MARKET_DISC)).decode()
    print('Fetching MarketThree accounts from core program...')
    result = rpc('getProgramAccounts', [
        EXPONENT_PROGRAM,
        {'encoding': 'base64', 'filters': [{'memcmp': {'offset': 0, 'bytes': disc_b58}}]},
    ])
    print(f'  Found {len(result or [])} MarketThree accounts')

    # Track which SY mints we've already seen via active markets
    seen_sy_mints = {m['syMint'] for m in active_list}
    expired_list = []

    for acct in (result or []):
        data = base64.b64decode(acct['account']['data'][0])
        sy_mint = decode_pubkey(data, 72)

        # Check if this maps to an active market
        mapped = None
        for off in range(8, min(len(data) - 31, 320), 32):
            pk = decode_pubkey(data, off)
            if pk in active_by_vault:
                mapped = active_by_vault[pk]; break
            if pk in active_by_pt:
                mapped = active_by_pt[pk]; break
            if pk in active_by_yt:
                mapped = active_by_yt[pk]; break
        if mapped:
            continue

        # This is an expired/unknown market account
        maturity_ts = find_maturity_ts(data)
        if not maturity_ts:
            continue

        mat_date = datetime.datetime.fromtimestamp(maturity_ts, tz=datetime.timezone.utc)
        if mat_date > datetime.datetime.now(datetime.timezone.utc):
            continue  # future maturity = active, should have been in API

        vault = decode_pubkey(data, 104) if len(data) > 136 else ''

        # Deduplicate by SY mint + maturity date (not exact timestamp)
        dedup_key = f'{sy_mint}:{mat_date.strftime("%Y-%m-%d")}'
        if any(e.get('_dedup') == dedup_key for e in expired_list):
            continue

        expired_list.append({
            'syMint': sy_mint,
            'vault': vault,
            'maturityTs': maturity_ts,
            'maturityDate': mat_date.strftime('%Y-%m-%d'),
            'status': 'expired',
            'accountAddr': acct['pubkey'],
            '_dedup': dedup_key,
        })

    # Resolve SY mint metadata for expired markets
    # First, build lookup from active markets for shared SY mints
    print(f'  Found {len(expired_list)} expired market entries, resolving metadata...')
    sy_mint_info = {}
    for m in active_list:
        sy_mint_info[m['syMint']] = {
            'name': m['underlyingTicker'],
            'symbol': m['underlyingTicker'],
            'decimals': m['underlyingDecimals'],
            'quoteTicker': m['quoteTicker'],
            'quoteMint': m['quoteMint'],
            'platform': m['platform'],
        }

    unique_expired_sy = set(e['syMint'] for e in expired_list) - seen_sy_mints
    for sy in unique_expired_sy:
        name, symbol, decimals = get_token_name(sy)
        sy_mint_info[sy] = {'name': name, 'symbol': symbol, 'decimals': decimals}
        if symbol:
            print(f'    {sy[:16]}... → {symbol} ({name}), {decimals} decimals')
        else:
            print(f'    {sy[:16]}... → unknown token, {decimals} decimals')

    # Load token identity map (from Helius metadata)
    token_ids_path = os.path.join(DATA_DIR, 'tvl', 'sy_token_ids.json')
    token_ids = {}
    if os.path.exists(token_ids_path):
        token_ids = json.load(open(token_ids_path))

    # Enrich expired entries
    for e in expired_list:
        sy = e['syMint']
        info = sy_mint_info.get(sy, {})
        tid = token_ids.get(sy, {})
        mat = datetime.datetime.fromtimestamp(
            e['maturityTs'], tz=datetime.timezone.utc
        ).strftime('%d%b%y').upper()
        # Use token identity if available, then active market info, then fallback
        symbol = tid.get('symbol') or info.get('symbol', '') or sy[:8]
        e['key'] = f'{symbol}-{mat}'
        e['underlyingTicker'] = symbol
        e['underlyingDecimals'] = info.get('decimals', 6)
        # Set quoteTicker from token identity (drives pricing in build_daily_tvl)
        price_feed = tid.get('price', '')
        if price_feed == 'USD':
            e['quoteTicker'] = 'USD'
        elif price_feed == 'SOL':
            e['quoteTicker'] = 'SOL'
        elif price_feed == 'BTC':
            e['quoteTicker'] = 'cbBTC'
        else:
            e['quoteTicker'] = info.get('quoteTicker', '')
        e['quoteMint'] = info.get('quoteMint', '')
        e['underlyingMint'] = ''
        e['ptMint'] = ''
        e['ytMint'] = ''
        e['platform'] = info.get('platform', '')
        e['syExchangeRate'] = 1
        e['interfaceType'] = ''
        del e['_dedup']
        del e['accountAddr']

    all_markets = active_list + expired_list

    # Summary of unique SY mints
    all_sy = set(m['syMint'] for m in all_markets)
    print(f'\nTotal markets: {len(all_markets)} ({len(active_list)} active + {len(expired_list)} expired)')
    print(f'Unique SY mints: {len(all_sy)} ({len(seen_sy_mints)} active + {len(unique_expired_sy)} expired-only)')

    json.dump(all_markets, open(OUT, 'w'), indent=2)
    print(f'Wrote {OUT}')


if __name__ == '__main__':
    main()
