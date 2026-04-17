#!/usr/bin/env python3
"""Parse Exponent signatures via Helius Enhanced Transactions API.
For each tx, detect which market(s) it touches (by YT, PT, or vault presence)
and emit one event per (signer, market) with token deltas and a heuristic action.
Resumable. Output: data/events.jsonl.
"""
import json, sys, os, time, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, os.path.dirname(__file__))
from config import enhanced_batch, EXPONENT_PROGRAM, DATA_DIR

SIGS_IN = os.path.join(DATA_DIR, 'sigs.json')
MARKETS = os.path.join(DATA_DIR, 'markets.json')
OUT     = os.path.join(DATA_DIR, 'events.jsonl')

BATCH = 100
CONCURRENCY = 6

def load_markets():
    mks = json.load(open(MARKETS))
    # Build lookup sets
    for m in mks:
        m['_yt'] = m['ytMint']
        m['_pt'] = m['ptMint']
        m['_vault'] = m.get('vault')
    return mks

def classify(tx, markets):
    if not tx or tx.get('transactionError'): return []
    instrs = tx.get('instructions') or []
    inner = []
    for i in instrs: inner += i.get('innerInstructions') or []
    if not any(ix.get('programId') == EXPONENT_PROGRAM for ix in instrs + inner):
        return []

    transfers = tx.get('tokenTransfers') or []
    mints = {t.get('mint') for t in transfers}
    for ad in tx.get('accountData') or []:
        for bc in ad.get('tokenBalanceChanges') or []:
            m = bc.get('mint')
            if m: mints.add(m)
    accounts = set()
    for ad in tx.get('accountData') or []:
        a = ad.get('account')
        if a: accounts.add(a)
    for ix in instrs:
        accounts.update(ix.get('accounts') or [])

    hits = []
    for m in markets:
        if m['_yt'] in mints or m['_pt'] in mints or (m['_vault'] and m['_vault'] in accounts):
            hits.append(m)
    if not hits: return []

    signer = tx.get('feePayer')
    def delta(mint):
        d = 0.0
        for t in transfers:
            if t.get('mint') != mint: continue
            if t.get('toUserAccount') == signer: d += float(t.get('tokenAmount') or 0)
            if t.get('fromUserAccount') == signer: d -= float(t.get('tokenAmount') or 0)
        return d

    events = []
    for m in hits:
        u = delta(m['underlying'])
        sy = delta(m['syMint'])
        yt = delta(m['_yt'])
        usd = abs(u + sy)  # approximate $1 per underlying unit (refined later if needed)
        action = 'other'
        if yt > 1e-4: action = 'buyYt'
        elif yt < -1e-4: action = 'sellYt'
        elif u < -1e-4 or sy < -1e-4: action = 'buyYt'
        elif u > 1e-4 or sy > 1e-4: action = 'sellYt'
        events.append({
            'sig': tx.get('signature'), 'blockTime': tx.get('timestamp'),
            'market': m['key'], 'signer': signer, 'action': action,
            'ytDelta': round(yt, 6), 'underlyingDelta': round(u + sy, 6),
            'usdNet': round(usd, 4),
        })
    return events

def main():
    markets = load_markets()
    sigs = [s['signature'] for s in json.load(open(SIGS_IN))]
    print(f'Loaded {len(sigs)} sigs, {len(markets)} markets', flush=True)

    done = set()
    if os.path.exists(OUT):
        kept = []
        for l in open(OUT):
            l = l.strip()
            if not l: continue
            try: r = json.loads(l)
            except: continue
            if r.get('error'): continue
            done.add(r.get('sig'))
            kept.append(l)
        open(OUT, 'w').write('\n'.join(kept) + '\n' if kept else '')
        print(f'Resuming: {len(done)} sigs parsed', flush=True)

    queue = [s for s in sigs if s not in done]
    batches = [queue[i:i+BATCH] for i in range(0, len(queue), BATCH)]
    print(f'Fetching {len(queue)} txs in {len(batches)} batches × {CONCURRENCY} workers...', flush=True)

    out = open(OUT, 'a')
    lock = threading.Lock()
    state = {'done': 0, 'total': len(queue), 'start': time.time()}

    def process(batch):
        try:
            txs = enhanced_batch(batch)
        except Exception as e:
            with lock:
                for sig in batch: out.write(json.dumps({'sig': sig, 'error': str(e)}) + '\n')
                state['done'] += len(batch)
            return
        lines = []
        for i, sig in enumerate(batch):
            tx = txs[i] if i < len(txs) else None
            if not tx:
                lines.append(json.dumps({'sig': sig, 'error': 'no-tx'})); continue
            evs = classify(tx, markets)
            if not evs:
                lines.append(json.dumps({'sig': sig, 'blockTime': tx.get('timestamp'), 'events': []}))
            else:
                for ev in evs: lines.append(json.dumps(ev))
        with lock:
            out.write('\n'.join(lines) + '\n'); out.flush()
            state['done'] += len(batch)
            if state['done'] % 500 == 0 or state['done'] == state['total']:
                rate = state['done'] / max(time.time() - state['start'], 1)
                eta = (state['total'] - state['done']) / max(rate, 0.001)
                sys.stdout.write(f"\rparsed {state['done']}/{state['total']}  rate={rate:.1f}/s  eta={eta/60:.1f}m")
                sys.stdout.flush()

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        futs = [ex.submit(process, b) for b in batches]
        for f in as_completed(futs): f.result()
    out.close()
    print(f"\nDone. parsed={state['done']}")

if __name__ == '__main__':
    main()
