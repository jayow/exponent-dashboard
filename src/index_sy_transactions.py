#!/usr/bin/env python3
"""Phase 2: Single-pass transaction indexer for SY mint supply + exchange rates.

For each SY mint, fetches every transaction (jsonParsed) and extracts:
  - MintTo/Burn amounts → supply deltas
  - "Program log: sy exchange rate: N" → exchange rate snapshots
  - blockTime → date

Writes: data/tvl/sy_events/{mint_short}.jsonl  (one JSON line per tx with deltas)
Cursor: data/tvl/sy_events/{mint_short}.cursor.json
"""
import json, sys, os, re, time
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, os.path.dirname(__file__))
from config import rpc, DATA_DIR

SIGS_DIR = os.path.join(DATA_DIR, 'tvl', 'sy_sigs')
EVENTS_DIR = os.path.join(DATA_DIR, 'tvl', 'sy_events')
os.makedirs(EVENTS_DIR, exist_ok=True)

RATE_RE = re.compile(r'sy exchange rate:\s*(\d+)')
WORKERS = 8
BATCH_SAVE = 200


def mint_short(mint):
    return mint[:16]


def parse_tx(tx_data, sy_mint):
    """Extract supply deltas and exchange rate from a parsed transaction."""
    if not tx_data or not tx_data.get('meta'):
        return None

    meta = tx_data['meta']
    if meta.get('err'):
        return None

    block_time = tx_data.get('blockTime')
    if not block_time:
        return None

    mint_delta = 0
    burn_delta = 0

    # Scan all instructions (top-level + inner) for MintTo/Burn on our SY mint
    all_instructions = []
    msg = tx_data.get('transaction', {}).get('message', {})
    for ix in msg.get('instructions', []):
        all_instructions.append(ix)
    for inner in (meta.get('innerInstructions') or []):
        for ix in inner.get('instructions', []):
            all_instructions.append(ix)

    for ix in all_instructions:
        parsed = ix.get('parsed')
        if not parsed or not isinstance(parsed, dict):
            continue
        ix_type = parsed.get('type', '')
        info = parsed.get('info', {})
        if info.get('mint') != sy_mint:
            continue
        amount = int(info.get('amount', 0))
        if ix_type == 'mintTo':
            mint_delta += amount
        elif ix_type == 'burn':
            burn_delta += amount

    # Extract exchange rate from logs
    exchange_rate = None
    for log in (meta.get('logMessages') or []):
        m = RATE_RE.search(log)
        if m:
            exchange_rate = int(m.group(1))
            break

    net_delta = mint_delta - burn_delta
    if net_delta == 0 and exchange_rate is None:
        return None

    return {
        'blockTime': block_time,
        'mintDelta': mint_delta,
        'burnDelta': burn_delta,
        'netDelta': net_delta,
        'exchangeRate': exchange_rate,
    }


def fetch_and_parse(sig, sy_mint):
    """Fetch a single transaction and parse it."""
    try:
        result = rpc('getTransaction', [sig, {
            'encoding': 'jsonParsed',
            'maxSupportedTransactionVersion': 0,
        }], retries=5, timeout=15)
        if result:
            return parse_tx(result, sy_mint)
    except Exception as e:
        pass
    return None


def index_mint(sy_mint):
    """Index all transactions for a single SY mint."""
    short = mint_short(sy_mint)
    sigs_path = os.path.join(SIGS_DIR, f'{short}.json')
    events_path = os.path.join(EVENTS_DIR, f'{short}.jsonl')
    cursor_path = os.path.join(EVENTS_DIR, f'{short}.cursor.json')

    if not os.path.exists(sigs_path):
        print(f'  No signatures file for {short}')
        return 0

    sigs = json.load(open(sigs_path))
    total = len(sigs)

    # Load cursor (index of last processed sig)
    start_idx = 0
    if os.path.exists(cursor_path):
        start_idx = json.load(open(cursor_path)).get('index', 0)

    if start_idx >= total:
        print(f'  {short}: already complete ({total} sigs)')
        return 0

    print(f'  {short}: {total} sigs, resuming from index {start_idx}')

    remaining = sigs[start_idx:]
    events_written = 0
    processed = 0
    f_out = open(events_path, 'a')

    try:
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            # Process in chunks for cursor saving
            chunk_size = BATCH_SAVE
            for chunk_start in range(0, len(remaining), chunk_size):
                chunk = remaining[chunk_start:chunk_start + chunk_size]
                futures = {
                    pool.submit(fetch_and_parse, s['sig'], sy_mint): s['sig']
                    for s in chunk
                }

                try:
                    for future in as_completed(futures, timeout=180):
                        sig = futures[future]
                        processed += 1
                        try:
                            event = future.result(timeout=30)
                            if event:
                                event['sig'] = sig
                                f_out.write(json.dumps(event) + '\n')
                                events_written += 1
                        except Exception:
                            pass
                except TimeoutError:
                    # Cancel remaining futures and move on
                    for f in futures:
                        f.cancel()
                    processed += sum(1 for f in futures if not f.done())

                # Save cursor after each chunk
                current_idx = start_idx + chunk_start + len(chunk)
                json.dump({'index': current_idx}, open(cursor_path, 'w'))
                f_out.flush()

                pct = (current_idx / total) * 100
                print(f'    {current_idx}/{total} ({pct:.1f}%) — {events_written} events', flush=True)
    finally:
        f_out.close()

    # Mark complete
    json.dump({'index': total}, open(cursor_path, 'w'))
    print(f'  Done: {events_written} events from {total} transactions')
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

    # Sort by sig count (largest first) so we can monitor the big ones
    mint_sizes = []
    for sy in sy_mints:
        short = mint_short(sy)
        sigs_path = os.path.join(SIGS_DIR, f'{short}.json')
        count = len(json.load(open(sigs_path))) if os.path.exists(sigs_path) else 0
        mint_sizes.append((sy, count))
    mint_sizes.sort(key=lambda x: -x[1])

    total_events = 0
    for i, (sy, count) in enumerate(mint_sizes):
        keys = sy_mints[sy]
        print(f'\n[{i+1}/{len(mint_sizes)}] SY {sy[:16]}... ({count} sigs, markets: {", ".join(keys)})')
        events = index_mint(sy)
        total_events += events

    print(f'\nTotal events indexed: {total_events}')


if __name__ == '__main__':
    main()
