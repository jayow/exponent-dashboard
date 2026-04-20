#!/usr/bin/env python3
"""Backfill existing indexed events with `returns` (program return data) and
`logs` (filtered log messages) fields.

Goes through data/index/enriched/*.jsonl and re-fetches each transaction to
extract the program return data that wasn't captured in the original index.
Writes events back with the additional fields.

Run once (or as needed) to enrich the historical data. Future events get this
data captured directly by index_final.py.

Usage:
  python3 src/backfill_index_returns.py            # all files
  python3 src/backfill_index_returns.py MINT_ID    # specific sy mint
"""
import os, sys, json, glob, time
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, os.path.dirname(__file__))
from config import DATA_DIR
from index_final import rpc_multi

WORKERS = 24
BATCH = 200
IN_DIR = os.path.join(DATA_DIR, 'index', 'enriched')


def fetch_returns_and_logs(sig):
    """Fetch a transaction and extract returns + filtered logs."""
    result = rpc_multi('getTransaction', [sig, {'encoding': 'json', 'maxSupportedTransactionVersion': 0}])
    if not result or not result.get('meta'):
        return None, None
    logs = result['meta'].get('logMessages', []) or []

    program_returns = {}
    for log in logs:
        if log.startswith('Program return: '):
            parts = log[len('Program return: '):].split(' ', 1)
            if len(parts) == 2:
                pid, b64 = parts
                program_returns.setdefault(pid, []).append(b64)

    rich_logs = [l for l in logs if (
        'Program log:' in l or 'Program return:' in l or 'invoke' in l or 'success' in l or 'failed' in l
    )]
    return program_returns, rich_logs


def process_file(path):
    """Read all events, backfill missing fields, write back."""
    events = []
    need_backfill = []
    with open(path) as fh:
        for line in fh:
            e = json.loads(line)
            events.append(e)
            # Skip if already has returns or is not an Exponent-related event
            if 'returns' in e or 'logs' in e:
                continue
            if not e.get('sig'):
                continue
            # Only backfill events with action or exponent flag
            if not (e.get('action') or e.get('exponent')):
                continue
            need_backfill.append(len(events) - 1)

    if not need_backfill:
        return 0, 0

    print(f'  {os.path.basename(path)}: {len(need_backfill)} of {len(events)} events need backfill')

    updated = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = {}
        for i in need_backfill:
            sig = events[i]['sig']
            futures[ex.submit(fetch_returns_and_logs, sig)] = i

        for f in as_completed(futures):
            i = futures[f]
            try:
                returns, logs = f.result()
            except Exception:
                continue
            if returns:
                events[i]['returns'] = returns
                updated += 1
            if logs:
                events[i]['logs'] = logs

    # Write atomically (temp file + rename) to avoid partial-write corruption
    tmp = path + '.tmp'
    with open(tmp, 'w') as fh:
        for e in events:
            fh.write(json.dumps(e) + '\n')
    os.replace(tmp, path)
    return updated, len(need_backfill)


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else None
    files = sorted(glob.glob(os.path.join(IN_DIR, '*.jsonl')))
    if target:
        files = [f for f in files if target in os.path.basename(f)]

    print(f'Processing {len(files)} file(s)...')
    total_updated = 0
    total_needed = 0
    for f in files:
        u, n = process_file(f)
        total_updated += u
        total_needed += n
    print(f'\nBackfilled {total_updated}/{total_needed} events with returns data')


if __name__ == '__main__':
    main()
