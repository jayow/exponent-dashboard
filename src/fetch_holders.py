#!/usr/bin/env python3
"""Fetch current YT and PT holders for each Exponent market.

YT: from YieldPosition program accounts (discriminator e35c92311d55475e)
    - vault field at offset 40 maps to market via API's vaultAddress
PT: from standard SPL token accounts (getProgramAccounts by mint)

Writes web/public/holders.json
"""
import json, sys, os, struct
import base58
sys.path.insert(0, os.path.dirname(__file__))
from config import rpc, DATA_DIR

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API_MARKETS = os.path.join(DATA_DIR, 'exponent_markets_api.json')
MARKETS = os.path.join(DATA_DIR, 'markets.json')
OUT = os.path.join(ROOT, 'web/public/holders.json')

EXPONENT_PROGRAM = 'ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7'
CLMM_PROGRAM = 'XPC1MM4dYACDfykNuXYZ5una2DsMDWL24CrYubCvarC'
TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
YT_DISC = 'e35c92311d55475e'
LP_DISC = '69f125c8e002fc5a'
CLMM_MARKET_DISC = 'f2f01a0f94bab9cd'

def get_all_yt_positions():
    """Fetch all YieldPosition accounts from Exponent program.
    Two sizes: 124 bytes (standard) and 164 bytes (Solstice w/ emissions).
    Both share the same layout for the first 80 bytes."""
    disc_bytes = bytes.fromhex(YT_DISC)
    disc_b58 = base58.b58encode(disc_bytes).decode()
    positions = []
    import base64
    for size in [124, 164, 204]:
        result = rpc('getProgramAccounts', [
            EXPONENT_PROGRAM,
            {
                'encoding': 'base64',
                'filters': [
                    {'dataSize': size},
                    {'memcmp': {'offset': 0, 'bytes': disc_b58}},
                ],
            },
        ])
        for acct in (result or []):
            data = base64.b64decode(acct['account']['data'][0])
            owner = base58.b58encode(data[8:40]).decode()
            vault = base58.b58encode(data[40:72]).decode()
            yt_bal = struct.unpack('<Q', data[72:80])[0]
            if yt_bal > 0:
                positions.append({'owner': owner, 'vault': vault, 'balance': yt_bal})
        print(f'  size={size}: {len(result or [])} accounts', flush=True)
    return positions

def get_pt_holders(mint):
    """Fetch all holders of a PT mint via standard token accounts."""
    result = rpc('getProgramAccounts', [
        TOKEN_PROGRAM,
        {
            'encoding': 'jsonParsed',
            'filters': [
                {'dataSize': 165},
                {'memcmp': {'offset': 0, 'bytes': mint}},
            ],
        },
    ])
    holders = []
    for acct in (result or []):
        info = acct['account']['data']['parsed']['info']
        amt = int(info.get('tokenAmount', {}).get('amount', '0'))
        dec = info.get('tokenAmount', {}).get('decimals', 6)
        owner = info.get('owner', '')
        if amt > 0:
            holders.append({'owner': owner, 'balance': amt / (10 ** dec)})
    holders.sort(key=lambda h: -h['balance'])
    return holders

def main():
    # Build vault → market key mapping from API data
    api_markets = json.load(open(API_MARKETS))
    markets = json.load(open(MARKETS))
    vault_to_key = {}
    for m in api_markets:
        import datetime
        t = m['underlyingAsset']['ticker']
        mat = datetime.datetime.utcfromtimestamp(m['maturityDateUnixTs']).strftime('%d%b%y').upper()
        key = f'{t}-{mat}'
        vault_to_key[m['vaultAddress']] = key

    # 1) Fetch all YT positions
    print('Fetching all YieldPosition accounts...', flush=True)
    yt_positions = get_all_yt_positions()
    print(f'  {len(yt_positions)} non-zero YT positions', flush=True)

    # Group by market
    yt_by_market = {}
    for p in yt_positions:
        key = vault_to_key.get(p['vault'], p['vault'][:8])
        if key not in yt_by_market:
            yt_by_market[key] = []
        # Find decimals from market config
        mk = next((m for m in markets if m['key'] == key), None)
        dec = mk.get('underlyingDecimals', 6) if mk else 6
        yt_by_market[key].append({
            'owner': p['owner'],
            'balance': p['balance'] / (10 ** dec),
        })

    for key in yt_by_market:
        yt_by_market[key].sort(key=lambda h: -h['balance'])

    # 2) Fetch all LP positions (sizes 128, 168, 208)
    print('Fetching all LpPosition accounts...', flush=True)
    lp_disc_bytes = bytes.fromhex(LP_DISC)
    lp_disc_b58 = base58.b58encode(lp_disc_bytes).decode()
    lp_positions = []
    import base64 as b64_lp
    for size in [128, 168, 208]:
        result = rpc('getProgramAccounts', [
            EXPONENT_PROGRAM,
            {
                'encoding': 'base64',
                'filters': [
                    {'dataSize': size},
                    {'memcmp': {'offset': 0, 'bytes': lp_disc_b58}},
                ],
            },
        ])
        for acct in (result or []):
            data = b64_lp.b64decode(acct['account']['data'][0])
            owner = base58.b58encode(data[8:40]).decode()
            market_addr = base58.b58encode(data[40:72]).decode()
            lp_bal = struct.unpack('<Q', data[72:80])[0]
            if lp_bal > 0:
                lp_positions.append({'owner': owner, 'market': market_addr, 'balance': lp_bal})
        print(f'  size={size}: {len(result or [])} accounts', flush=True)
    print(f'  Non-zero LP positions: {len(lp_positions)}', flush=True)

    # Map LP market addresses to market keys
    # Sources: legacyMarketAddresses + orderbookAddresses from API
    lp_market_to_key = {}
    import datetime as dt2
    key_by_vault = {}
    key_by_pt = {}
    key_by_yt = {}
    key_by_sy = {}
    for m in api_markets:
        t2 = m['underlyingAsset']['ticker']
        mat2 = dt2.datetime.fromtimestamp(m['maturityDateUnixTs'], tz=dt2.timezone.utc).strftime('%d%b%y').upper()
        k2 = f'{t2}-{mat2}'
        for addr in (m.get('legacyMarketAddresses') or []):
            lp_market_to_key[addr] = k2
        for addr in (m.get('orderbookAddresses') or []):
            lp_market_to_key[addr] = k2
        key_by_vault[m['vaultAddress']] = k2
        key_by_pt[m['ptMint']] = k2
        key_by_yt[m['ytMint']] = k2
        key_by_sy[m['syMint']] = k2

    # Auto-discover MarketThree (CLMM) addresses on-chain via discriminator d404847ea9797914
    MARKET3_DISC = 'd404847ea9797914'
    m3_disc_b58 = base58.b58encode(bytes.fromhex(MARKET3_DISC)).decode()
    print('  Auto-discovering MarketThree addresses...', flush=True)
    m3_result = rpc('getProgramAccounts', [
        EXPONENT_PROGRAM,
        {
            'encoding': 'base64',
            'filters': [
                {'memcmp': {'offset': 0, 'bytes': m3_disc_b58}},
            ],
        },
    ])
    discovered = 0
    for acct in (m3_result or []):
        addr = acct['pubkey']
        if addr in lp_market_to_key:
            continue
        data = b64_lp.b64decode(acct['account']['data'][0])
        found = None
        for off in range(8, min(len(data) - 31, 320), 32):
            pk = base58.b58encode(data[off:off+32]).decode()
            if pk in key_by_vault:
                found = key_by_vault[pk]; break
            if pk in key_by_pt:
                found = key_by_pt[pk]; break
            if pk in key_by_yt:
                found = key_by_yt[pk]; break
        if not found:
            for off in range(8, min(len(data) - 31, 320), 32):
                pk = base58.b58encode(data[off:off+32]).decode()
                if pk in key_by_sy:
                    found = key_by_sy[pk]; break
        if found:
            lp_market_to_key[addr] = found
            discovered += 1
    print(f'  Discovered {discovered} core MarketThree→market mappings', flush=True)

    # Also scan CLMM program (XPC1MM4) for market accounts
    clmm_disc_b58 = base58.b58encode(bytes.fromhex(CLMM_MARKET_DISC)).decode()
    clmm_result = rpc('getProgramAccounts', [
        CLMM_PROGRAM,
        {
            'encoding': 'base64',
            'filters': [
                {'memcmp': {'offset': 0, 'bytes': clmm_disc_b58}},
            ],
        },
    ])
    clmm_discovered = 0
    for acct in (clmm_result or []):
        addr = acct['pubkey']
        if addr in lp_market_to_key:
            continue
        data = b64_lp.b64decode(acct['account']['data'][0])
        found = None
        for off in range(8, min(len(data) - 31, 500), 32):
            pk = base58.b58encode(data[off:off+32]).decode()
            if pk in key_by_vault:
                found = key_by_vault[pk]; break
            if pk in key_by_pt:
                found = key_by_pt[pk]; break
            if pk in key_by_yt:
                found = key_by_yt[pk]; break
        if not found:
            for off in range(8, min(len(data) - 31, 500), 32):
                pk = base58.b58encode(data[off:off+32]).decode()
                if pk in key_by_sy:
                    found = key_by_sy[pk]; break
        if found:
            lp_market_to_key[addr] = found
            clmm_discovered += 1
    print(f'  Discovered {clmm_discovered} CLMM→market mappings ({len(lp_market_to_key)} total)', flush=True)

    lp_by_market = {}
    for p in lp_positions:
        key2 = lp_market_to_key.get(p['market'], None)
        if not key2: continue
        mk2 = next((m for m in markets if m['key'] == key2), None)
        dec2 = mk2.get('underlyingDecimals', 6) if mk2 else 6
        if key2 not in lp_by_market:
            lp_by_market[key2] = []
        lp_by_market[key2].append({
            'owner': p['owner'],
            'balance': p['balance'] / (10 ** dec2),
        })
    for key2 in lp_by_market:
        lp_by_market[key2].sort(key=lambda h: -h['balance'])

    # 3) Fetch PT holders per market
    print('Fetching PT holders per market...', flush=True)
    pt_by_market = {}
    for mk in markets:
        key = mk['key']
        print(f'  [{key}] PT mint {mk["ptMint"][:12]}...', end='', flush=True)
        try:
            holders = get_pt_holders(mk['ptMint'])
            pt_by_market[key] = holders
            print(f' {len(holders)} holders', flush=True)
        except Exception as e:
            print(f' ERROR: {e}', flush=True)

    # 3) Load live market prices for $ valuation
    live_path = os.path.join(ROOT, 'web/public/markets-live.json')
    price_map = {}  # market_key -> {ytPrice, ptPrice, underlyingPrice}
    if os.path.exists(live_path):
        live = json.load(open(live_path))
        for m in live.get('markets', []):
            import datetime
            d = datetime.datetime.strptime(m['maturity'], '%Y-%m-%d')
            dd = d.strftime('%d')
            mmm = d.strftime('%b').upper()
            yy = d.strftime('%y')
            mkey = f'{m["ticker"]}-{dd}{mmm}{yy}'
            price_map[mkey] = {
                'ytPrice': m.get('ytPrice', 0) * m.get('underlyingPrice', 1),
                'ptPrice': m.get('ptPrice', 1) * m.get('underlyingPrice', 1),
            }

    # 5) Build output with $ values
    out = {}
    for mk in markets:
        key = mk['key']
        prices = price_map.get(key, {'ytPrice': 0, 'ptPrice': 1})
        yt_holders = yt_by_market.get(key, [])
        pt_holders = pt_by_market.get(key, [])
        lp_holders = lp_by_market.get(key, [])
        for h in yt_holders:
            h['usd'] = round(h['balance'] * prices['ytPrice'], 2)
        for h in pt_holders:
            h['usd'] = round(h['balance'] * prices['ptPrice'], 2)
        # LP value ≈ balance × $1 per unit (LP tokens represent pool share, roughly 1:1 with underlying)
        for h in lp_holders:
            h['usd'] = round(h['balance'] * prices['ptPrice'], 2)  # approximate
        out[f'{key}:yt'] = {
            'market': key, 'type': 'yt',
            'holders': len(yt_holders),
            'totalBalance': round(sum(h['balance'] for h in yt_holders), 2),
            'totalUsd': round(sum(h['usd'] for h in yt_holders), 2),
            'top': yt_holders[:500],
        }
        out[f'{key}:pt'] = {
            'market': key, 'type': 'pt',
            'holders': len(pt_holders),
            'totalBalance': round(sum(h['balance'] for h in pt_holders), 2),
            'totalUsd': round(sum(h['usd'] for h in pt_holders), 2),
            'top': pt_holders[:500],
        }
        out[f'{key}:lp'] = {
            'market': key, 'type': 'lp',
            'holders': len(lp_holders),
            'totalBalance': round(sum(h['balance'] for h in lp_holders), 2),
            'totalUsd': round(sum(h.get('usd', 0) for h in lp_holders), 2),
            'top': lp_holders[:500],
        }

    json.dump(out, open(OUT, 'w'))
    print(f'\nWrote {OUT}')
    for mk in markets:
        key = mk['key']
        yt = out.get(f'{key}:yt', {})
        pt = out.get(f'{key}:pt', {})
        print(f'  {key:20s}  YT={yt.get("holders",0):>5d} holders  PT={pt.get("holders",0):>5d} holders')

if __name__ == '__main__':
    main()
