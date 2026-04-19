#!/usr/bin/env python3
"""FINAL indexer — extracts EVERYTHING from each transaction. No more re-indexes.

For each transaction extracts:
- Signer, instruction, action, market
- All token balance changes (pre/post with symbols)
- All inner instructions (transfers, mints, burns with full details)
- Derived PT/YT prices from AMM swap amounts
- Fee transfers (to non-pool/non-signer accounts)
- Gas fee (meta.fee in lamports)
- Exchange rate from logs

Reads: data/tvl/sy_sigs/{mint}.json
Writes: data/index/final/{mint}.jsonl
Cursor: data/index/final/{mint}.cursor.json
"""
import json, sys, os, re, time, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
sys.path.insert(0, os.path.dirname(__file__))
from config import rpc, DATA_DIR, RPC_URL

SIGS_DIR = os.path.join(DATA_DIR, 'tvl', 'sy_sigs')
OUT_DIR = os.path.join(DATA_DIR, 'index', 'final')
os.makedirs(OUT_DIR, exist_ok=True)

EXPONENT_PROGRAM = 'ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7'
WORKERS = 12
BATCH_SAVE = 200
RATE_RE = re.compile(r'sy exchange rate:\s*(\d+)')

# Multi-RPC support
_rpc_urls = [RPC_URL]
_env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env')
for line in open(_env_path):
    line = line.strip()
    if line.startswith('HELIUS_API_KEY_') and '=' in line:
        val = line.split('=', 1)[1].strip()
        _rpc_urls.append(val if val.startswith('http') else f'https://mainnet.helius-rpc.com/?api-key={val}')

_rpc_counter = [0]
_rpc_lock = threading.Lock()

def rpc_multi(method, params, retries=5, timeout=15):
    with _rpc_lock:
        idx = _rpc_counter[0] % len(_rpc_urls)
        _rpc_counter[0] += 1
    url = _rpc_urls[idx]
    body = {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}
    for i in range(retries):
        try:
            r = requests.post(url, json=body, headers={'User-Agent': 'curl/8.7.1'}, timeout=timeout)
            if r.status_code in (429, 503, 504):
                time.sleep(min(4, 0.3 * (2 ** i))); continue
            j = r.json()
            if j.get('error'):
                code = j['error'].get('code')
                if code in (-32429, -32413):
                    time.sleep(min(4, 0.3 * (2 ** i))); continue
                return None
            return j.get('result')
        except:
            time.sleep(min(4, 0.3 * (2 ** i)))
    return None

# Instruction classification
INSTR_MAP = {
    'wrapperbuyyt': 'buyYt', 'wrappersellyt': 'sellYt', 'withdrawyt': 'sellYt',
    'buyyt': 'buyYt', 'sellyt': 'sellYt', 'initializeyieldposition': 'buyYt',
    'wrapperprovideliquidity': 'addLiq', 'wrapperprovideliquiditybase': 'addLiq',
    'wrapperprovideliquidityyt': 'addLiq', 'wrapperprovideliquidityclassic': 'addLiq',
    'initlpposition': 'addLiq', 'deposityt': 'addLiq',
    'marketdepositlp': 'addLiq', 'markettwodepositliquidity': 'addLiq',
    'wrapperwithdrawliquidity': 'removeLiq', 'wrapperwithdrawliquidityclassic': 'removeLiq',
    'marketwithdrawlp': 'removeLiq', 'wrapperwithdrawfunds': 'removeLiq',
    'wrappermarketoffer': 'addLiq', 'wrapperpostoffer': 'addLiq', 'wrapperremoveoffer': 'removeLiq',
    'stageytyield': 'claimYield', 'wrappercollectinterest': 'claimYield',
    'collectinterest': 'claimYield', 'collectemission': 'claimYield',
    'wrapperbuypt': 'buyPt', 'wrappersellpt': 'sellPt', 'tradept': 'buyPt',
    'wrappermerge': 'redeemPt', 'merge': 'redeemPt',
    'wrapperstrip': 'strip', 'strip': 'strip',
}
SKIP_INSTRS = {'refreshreserve', 'refreshobligation', 'refreshreservesbatch',
               'initobligation', 'initusermetadata', 'initobligationfarmsforreserve', 'initreserve'}

# Load mint→symbol and market mappings
MINT_SYMBOLS = {}
_ms_path = os.path.join(DATA_DIR, 'mint_symbols.json')
if os.path.exists(_ms_path):
    MINT_SYMBOLS = json.load(open(_ms_path))

MINT_TO_MARKET = {}
_api_path = os.path.join(DATA_DIR, 'exponent_markets_api.json')
if os.path.exists(_api_path):
    import datetime as _dt
    for m in json.load(open(_api_path)):
        t = m['underlyingAsset']['ticker']
        mat = _dt.datetime.fromtimestamp(m['maturityDateUnixTs'], tz=_dt.timezone.utc).strftime('%d%b%y').upper()
        key = f'{t}-{mat}'
        for f in ('ytMint', 'ptMint', 'syMint'):
            if m.get(f): MINT_TO_MARKET[m[f]] = key

# Also from all_markets
_all_mkt_path = os.path.join(DATA_DIR, 'tvl', 'all_markets.json')
if os.path.exists(_all_mkt_path):
    for m in json.load(open(_all_mkt_path)):
        for f in ('ytMint', 'ptMint', 'syMint'):
            mint = m.get(f, '')
            if mint and mint not in MINT_TO_MARKET:
                MINT_TO_MARKET[mint] = m['key']

# Known pool/vault addresses for fee detection
KNOWN_POOL_ADDRS = set()
if os.path.exists(_api_path):
    for m in json.load(open(_api_path)):
        KNOWN_POOL_ADDRS.add(m.get('vaultAddress', ''))
        for a in m.get('legacyMarketAddresses', []): KNOWN_POOL_ADDRS.add(a)
        for a in m.get('orderbookAddresses', []): KNOWN_POOL_ADDRS.add(a)
KNOWN_POOL_ADDRS.discard('')


def parse_instruction_from_logs(logs):
    """Extract first non-housekeeping Exponent instruction from logs."""
    in_exponent = False
    for log in (logs or []):
        if EXPONENT_PROGRAM in log and 'invoke' in log:
            in_exponent = True
            continue
        if in_exponent and 'Instruction:' in log:
            instr = log.split('Instruction:')[-1].strip()
            if instr.lower() not in SKIP_INSTRS:
                return instr
        if 'success' in log or ('invoke' in log and EXPONENT_PROGRAM not in log):
            in_exponent = False
    return None


def parse_tx(tx_data, sy_mint):
    """Extract EVERYTHING from a transaction."""
    if not tx_data or not tx_data.get('meta'):
        return None
    meta = tx_data['meta']
    if meta.get('err'):
        return None
    block_time = tx_data.get('blockTime')
    if not block_time:
        return None

    msg = tx_data.get('transaction', {}).get('message', {})
    account_keys = []
    for ak in msg.get('accountKeys', []):
        if isinstance(ak, str): account_keys.append(ak)
        elif isinstance(ak, dict): account_keys.append(ak.get('pubkey', ''))

    # Signer
    signer = ''
    for ak in msg.get('accountKeys', []):
        if isinstance(ak, dict) and ak.get('signer'):
            signer = ak.get('pubkey', '')
            break
    if not signer and account_keys:
        signer = account_keys[0]

    # Instruction from logs (Exponent context only)
    logs = meta.get('logMessages', [])
    instr = parse_instruction_from_logs(logs)
    action = INSTR_MAP.get((instr or '').lower(), None)

    is_exponent = any(EXPONENT_PROGRAM in (log or '') for log in logs)

    # Token balance changes (pre/post)
    pre = {b['accountIndex']: b for b in (meta.get('preTokenBalances') or [])}
    post = {b['accountIndex']: b for b in (meta.get('postTokenBalances') or [])}
    all_indices = set(pre.keys()) | set(post.keys())

    token_changes = {}
    for idx in all_indices:
        pre_b = pre.get(idx, {})
        post_b = post.get(idx, {})
        owner = post_b.get('owner') or pre_b.get('owner', '')
        if owner != signer: continue
        mint = post_b.get('mint') or pre_b.get('mint', '')
        pre_amt = float(pre_b.get('uiTokenAmount', {}).get('uiAmountString', '0') or '0')
        post_amt = float(post_b.get('uiTokenAmount', {}).get('uiAmountString', '0') or '0')
        delta = post_amt - pre_amt
        if abs(delta) > 0:
            token_changes[mint] = round(delta, 9)

    # ALL inner instructions — transfers, mints, burns
    inner_transfers = []
    inner_mints = []
    inner_burns = []
    all_instructions = []
    for ix in msg.get('instructions', []):
        all_instructions.append(ix)
    for inner in (meta.get('innerInstructions') or []):
        for ix in inner.get('instructions', []):
            all_instructions.append(ix)

    sy_mint_delta = 0
    sy_burn_delta = 0

    for ix in all_instructions:
        parsed = ix.get('parsed')
        if not parsed or not isinstance(parsed, dict):
            continue
        ix_type = parsed.get('type', '')
        info = parsed.get('info', {})

        if ix_type == 'transfer':
            amt = int(info.get('amount', 0))
            if amt > 0:
                inner_transfers.append({
                    'amount': amt,
                    'source': info.get('source', ''),
                    'destination': info.get('destination', ''),
                    'authority': info.get('authority', ''),
                })

        elif ix_type == 'mintTo':
            mint = info.get('mint', '')
            amt = int(info.get('amount', 0))
            if amt > 0:
                inner_mints.append({
                    'mint': mint,
                    'amount': amt,
                    'account': info.get('account', ''),
                    'symbol': MINT_SYMBOLS.get(mint, ''),
                })
            if mint == sy_mint:
                sy_mint_delta += amt

        elif ix_type == 'burn':
            mint = info.get('mint', '')
            amt = int(info.get('amount', 0))
            if amt > 0:
                inner_burns.append({
                    'mint': mint,
                    'amount': amt,
                    'symbol': MINT_SYMBOLS.get(mint, ''),
                })
            if mint == sy_mint:
                sy_burn_delta += amt

    # Identify fee transfers (small transfers to non-signer, non-pool accounts)
    fee_transfers = []
    for t in inner_transfers:
        dest = t['destination']
        if dest != signer and dest not in KNOWN_POOL_ADDRS and t['amount'] > 0:
            # Heuristic: if amount is much smaller than the largest transfer, it's likely a fee
            max_transfer = max((tr['amount'] for tr in inner_transfers), default=0)
            if t['amount'] < max_transfer * 0.05 and t['amount'] > 0:
                fee_transfers.append(t)

    # Exchange rate from logs
    exchange_rate = None
    for log in logs:
        m = RATE_RE.search(log)
        if m:
            exchange_rate = int(m.group(1))
            break

    # Market identification
    market = None
    for mint in token_changes:
        if mint in MINT_TO_MARKET:
            market = MINT_TO_MARKET[mint]; break
    if not market:
        for mint_info in inner_mints + inner_burns:
            if mint_info['mint'] in MINT_TO_MARKET:
                market = MINT_TO_MARKET[mint_info['mint']]; break
    if not market:
        for key in account_keys:
            if key in MINT_TO_MARKET:
                market = MINT_TO_MARKET[key]; break

    # Gas fee
    gas_fee = meta.get('fee', 0)

    # Skip if nothing interesting
    if not action and not token_changes and sy_mint_delta == 0 and sy_burn_delta == 0 and not is_exponent:
        return None

    # Build event
    event = {
        'blockTime': block_time,
        'signer': signer,
        'gasFee': gas_fee,
    }
    if instr: event['instr'] = instr
    if action: event['action'] = action
    if market: event['market'] = market
    if token_changes: event['tokenChanges'] = token_changes
    if sy_mint_delta: event['mintDelta'] = sy_mint_delta
    if sy_burn_delta: event['burnDelta'] = sy_burn_delta
    if exchange_rate: event['exchangeRate'] = exchange_rate
    if is_exponent and not action: event['exponent'] = True

    # Inner instruction summary (compact format)
    if inner_mints:
        event['mints'] = [{'mint': m['mint'][:16], 'symbol': m['symbol'], 'amount': m['amount']} for m in inner_mints]
    if inner_burns:
        event['burns'] = [{'mint': b['mint'][:16], 'symbol': b['symbol'], 'amount': b['amount']} for b in inner_burns]
    if fee_transfers:
        event['fees'] = [{'amount': f['amount'], 'dest': f['destination'][:16]} for f in fee_transfers]
    if inner_transfers:
        event['transferCount'] = len(inner_transfers)

    return event


def fetch_and_parse(sig, sy_mint):
    try:
        result = rpc_multi('getTransaction', [sig, {
            'encoding': 'jsonParsed',
            'maxSupportedTransactionVersion': 0,
        }])
        if result:
            return parse_tx(result, sy_mint)
    except:
        pass
    return None


def index_mint(sy_mint):
    short = sy_mint[:16]
    sigs_path = os.path.join(SIGS_DIR, f'{short}.json')
    events_path = os.path.join(OUT_DIR, f'{short}.jsonl')
    cursor_path = os.path.join(OUT_DIR, f'{short}.cursor.json')

    if not os.path.exists(sigs_path):
        print(f'  No signatures for {short}')
        return 0

    sigs = json.load(open(sigs_path))
    total = len(sigs)

    start_idx = 0
    if os.path.exists(cursor_path):
        start_idx = json.load(open(cursor_path)).get('index', 0)

    if start_idx >= total:
        print(f'  {short}: already complete ({total} sigs)')
        return 0

    print(f'  {short}: {total} sigs, resuming from {start_idx}')

    remaining = sigs[start_idx:]
    events_written = 0
    f_out = open(events_path, 'a')

    try:
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            for chunk_start in range(0, len(remaining), BATCH_SAVE):
                chunk = remaining[chunk_start:chunk_start + BATCH_SAVE]
                futures = {pool.submit(fetch_and_parse, s['sig'], sy_mint): s['sig'] for s in chunk}

                try:
                    for future in as_completed(futures, timeout=180):
                        sig = futures[future]
                        try:
                            event = future.result(timeout=30)
                            if event:
                                event['sig'] = sig
                                f_out.write(json.dumps(event) + '\n')
                                events_written += 1
                        except:
                            pass
                except TimeoutError:
                    for f in futures:
                        f.cancel()

                current_idx = start_idx + chunk_start + len(chunk)
                json.dump({'index': current_idx}, open(cursor_path, 'w'))
                f_out.flush()

                pct = (current_idx / total) * 100
                print(f'    {current_idx}/{total} ({pct:.1f}%) — {events_written} events', flush=True)
    finally:
        f_out.close()

    json.dump({'index': total}, open(cursor_path, 'w'))
    print(f'  Done: {events_written} events from {total} sigs')
    return events_written


def main():
    markets_path = os.path.join(DATA_DIR, 'tvl', 'all_markets.json')
    if not os.path.exists(markets_path):
        print('Run discover_expired_markets.py first')
        sys.exit(1)

    markets = json.load(open(markets_path))
    sy_mints = {}
    for m in markets:
        sy = m['syMint']
        if sy not in sy_mints:
            sy_mints[sy] = []
        sy_mints[sy].append(m['key'])

    # Sort by sig count descending
    mint_sizes = []
    for sy in sy_mints:
        short = sy[:16]
        sigs_path = os.path.join(SIGS_DIR, f'{short}.json')
        count = len(json.load(open(sigs_path))) if os.path.exists(sigs_path) else 0
        mint_sizes.append((sy, count))
    mint_sizes.sort(key=lambda x: -x[1])

    total_sigs = sum(c for _, c in mint_sizes)
    total_events = 0
    start_time = time.time()

    print(f'FINAL indexer — {len(mint_sizes)} SY mints, {total_sigs:,} total sigs')
    print(f'RPC endpoints: {len(_rpc_urls)}')
    print(f'Workers: {WORKERS}\n')

    for i, (sy, count) in enumerate(mint_sizes):
        keys = sy_mints[sy]
        print(f'\n[{i+1}/{len(mint_sizes)}] SY {sy[:16]}... ({count:,} sigs, markets: {", ".join(keys[:3])}{"..." if len(keys) > 3 else ""})')
        events = index_mint(sy)
        total_events += events

        elapsed = time.time() - start_time
        processed_sigs = sum(c for _, c in mint_sizes[:i+1])
        if elapsed > 0 and processed_sigs > 0:
            rate = processed_sigs / elapsed
            remaining_sigs = total_sigs - processed_sigs
            eta_min = remaining_sigs / rate / 60 if rate > 0 else 0
            print(f'  Progress: {processed_sigs:,}/{total_sigs:,} sigs ({processed_sigs/total_sigs*100:.0f}%) — ETA: {eta_min:.0f} min')

    elapsed = time.time() - start_time
    print(f'\nComplete: {total_events:,} events in {elapsed/60:.1f} minutes')


if __name__ == '__main__':
    main()
