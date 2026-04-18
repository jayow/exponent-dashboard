#!/usr/bin/env python3
"""Daily refresh orchestrator — runs all data pipelines in order.

Usage:
  python3 src/refresh.py           # full refresh (all steps)
  python3 src/refresh.py --quick   # skip historical indexing (just live snapshot)
  python3 src/refresh.py --hist    # only historical TVL pipeline

Steps (full refresh):
  1. fetch_markets.py         — discover active markets from Exponent API
  2. fetch_live_markets.mjs   — live TVL, prices, APY for active markets
  3. fetch_holders.py         — current PT/YT/LP holders per market
  4. discover_expired_markets  — find all historical markets on-chain
  5. fetch_sy_sigs.py         — incremental sig scrape for SY mints
  6. index_sy_transactions.py — incremental tx indexing (supply + rates)
  7. update correction factors — anchor supply to on-chain truth
  8. fetch_prices.py          — extend price history to today
  9. build_daily_tvl.py       — rebuild historical TVL JSON
  10. build_web_data.py       — rebuild wallet activity data
"""
import os, sys, subprocess, time, json
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src')
DATA = os.path.join(ROOT, 'data')


def run(cmd, label, timeout=600):
    """Run a command, print status, return success."""
    print(f'\n{"="*60}')
    print(f'[{datetime.now(timezone.utc).strftime("%H:%M:%S")}] {label}')
    print(f'{"="*60}')
    try:
        result = subprocess.run(
            cmd, shell=True, cwd=ROOT,
            timeout=timeout,
            capture_output=False,
        )
        if result.returncode != 0:
            print(f'  WARNING: {label} exited with code {result.returncode}')
            return False
        return True
    except subprocess.TimeoutExpired:
        print(f'  WARNING: {label} timed out after {timeout}s')
        return False
    except Exception as e:
        print(f'  ERROR: {label} failed: {e}')
        return False


def update_corrections():
    """Fetch on-chain SY supply and compute correction factors."""
    print(f'\n{"="*60}')
    print(f'[{datetime.now(timezone.utc).strftime("%H:%M:%S")}] Updating supply correction factors')
    print(f'{"="*60}')

    sys.path.insert(0, SRC)
    from config import rpc

    markets_path = os.path.join(DATA, 'tvl', 'all_markets.json')
    if not os.path.exists(markets_path):
        print('  Skipping — no all_markets.json')
        return

    markets = json.load(open(markets_path))
    sy_mints = list(set(m['syMint'] for m in markets))
    events_dir = os.path.join(DATA, 'tvl', 'sy_events')

    corrections = {}
    for sy in sy_mints:
        short = sy[:16]
        events_path = os.path.join(events_dir, f'{short}.jsonl')
        if not os.path.exists(events_path):
            continue
        try:
            result = rpc('getTokenSupply', [sy])
            actual = int(result['value']['amount'])
            cumulated = 0
            with open(events_path) as f:
                for line in f:
                    e = json.loads(line.strip())
                    cumulated += e.get('netDelta', 0)
            if cumulated > 0:
                corrections[sy] = actual / cumulated
        except:
            corrections[sy] = 1.0
        time.sleep(0.1)

    out_path = os.path.join(DATA, 'tvl', 'sy_corrections.json')
    json.dump(corrections, open(out_path, 'w'), indent=2)
    print(f'  Updated {len(corrections)} correction factors')


def main():
    args = sys.argv[1:]
    quick = '--quick' in args
    hist_only = '--hist' in args

    start = time.time()
    print(f'Exponent Dashboard — Daily Refresh')
    print(f'Started: {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")}')
    print(f'Mode: {"quick (live only)" if quick else "hist only" if hist_only else "full"}')

    results = {}

    if not hist_only:
        # Live snapshot pipeline
        results['markets'] = run(
            'python3 src/fetch_markets.py',
            'Step 1: Fetch active markets from API',
            timeout=60
        )

        results['live'] = run(
            'node src/fetch_live_markets.mjs',
            'Step 2: Fetch live market data + prices',
            timeout=120
        )

        results['holders'] = run(
            'python3 src/fetch_holders.py',
            'Step 3: Fetch current PT/YT/LP holders',
            timeout=300
        )

    if not quick:
        # Historical TVL pipeline
        results['discover'] = run(
            'python3 src/discover_expired_markets.py',
            'Step 4: Discover all markets (active + expired)',
            timeout=120
        )

        results['sy_sigs'] = run(
            'python3 src/fetch_sy_sigs.py',
            'Step 5: Fetch new SY mint signatures (incremental)',
            timeout=600
        )

        results['index'] = run(
            'python3 src/index_sy_transactions.py',
            'Step 6: Index new transactions (incremental)',
            timeout=3600
        )

        update_corrections()

        results['prices'] = run(
            'python3 src/fetch_prices.py',
            'Step 8: Fetch/extend price history',
            timeout=120
        )

        results['tvl'] = run(
            'python3 src/build_daily_tvl.py',
            'Step 9: Build daily TVL history',
            timeout=60
        )

        results['analytics'] = run(
            'python3 src/build_analytics.py',
            'Step 10: Build activity analytics',
            timeout=120
        )

    if not hist_only:
        results['web_data'] = run(
            'python3 src/build_web_data.py',
            'Step 11: Build wallet activity data',
            timeout=300
        )

    # Summary
    elapsed = time.time() - start
    print(f'\n{"="*60}')
    print(f'Refresh complete in {elapsed/60:.1f} minutes')
    print(f'{"="*60}')
    for step, ok in results.items():
        status = 'OK' if ok else 'FAILED'
        print(f'  {step:20s}: {status}')

    failed = [k for k, v in results.items() if not v]
    if failed:
        print(f'\n{len(failed)} step(s) failed: {", ".join(failed)}')
        sys.exit(1)
    else:
        print(f'\nAll steps passed.')


if __name__ == '__main__':
    main()
