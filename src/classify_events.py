#!/usr/bin/env python3
"""Classify each event by its on-chain Exponent instruction.
Same proven pattern from SolsticeAirdropUsers — skip housekeeping instrs,
find the real action.
"""
import json, sys, os, re, time, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, os.path.dirname(__file__))
from config import rpc as rpc_call, EXPONENT_PROGRAM, DATA_DIR

TRADES = os.path.join(DATA_DIR, 'events.jsonl')
CACHE  = os.path.join(DATA_DIR, 'sig_instr.json')

# Full instruction → action map (all variants discovered in SolsticeAirdropUsers)
_MAP = {
    'wrapperbuyyt':                    'buyYt',
    'buyyt':                           'buyYt',
    'initializeyieldposition':         'buyYt',
    'wrappersellyt':                   'sellYt',
    'sellyt':                          'sellYt',
    'withdrawyt':                      'sellYt',
    'wrapperprovideliquidity':         'addLiq',
    'wrapperprovideliquiditybase':     'addLiq',
    'wrapperprovideliquidityyt':       'addLiq',
    'initlpposition':                  'addLiq',
    'provideliquidity':                'addLiq',
    'markettwodepositleiquidity':       'addLiq',
    'markettwodepositleiquidity':       'addLiq',
    'marketdepositlp':                 'addLiq',
    'wrapperwithdrawliquidity':        'removeLiq',
    'wrapperwithdrawliquidityclassic': 'removeLiq',
    'wrapperremoveliquidity':          'removeLiq',
    'marketwithdrawlp':                'removeLiq',
    'removeliquidity':                 'removeLiq',
    'wrappercollectinterest':          'claimYield',
    'collectinterest':                 'claimYield',
    'stageytyield':                    'claimYield',
    'collectemission':                 'claimYield',
    # Income (PT)
    'wrapperbuypt':                    'buyPt',
    'wrappersellpt':                   'sellPt',
    'buypt':                           'buyPt',
    'sellpt':                          'sellPt',
    # LP inner steps (when top-level)
    'deposityt':                       'addLiq',
    # Strip = split underlying into PT+YT (neutral, creates tokens)
    'wrapperstrip':                    'strip',
    'strip':                           'strip',
    # Neutral / admin
    'wrappermerge':                    'redeemPt',
    'initmarkettwo':                   'other',
    'initializevault':                 'other',
    'addemission':                     'other',
}

SKIP_INSTRS = {'refreshreserve', 'refreshobligation'}

def get_instr(sig, retries=8):
    body = {'jsonrpc':'2.0','id':1,'method':'getTransaction',
            'params':[sig, {'encoding':'json','maxSupportedTransactionVersion':0}]}
    for i in range(retries):
        try:
            import requests
            r = requests.post(f'https://mainnet.helius-rpc.com/?api-key={os.environ.get("_HELIUS_KEY","")}',
                              json=body, headers={'User-Agent':'curl/8.7.1'}, timeout=30)
            if r.status_code in (429, 413, 503, 504):
                time.sleep(min(8, 0.5*(2**i))); continue
            j = r.json()
            if j.get('error'):
                msg = j['error'].get('message','')
                if 'max usage' in msg.lower() or 'too many' in msg.lower():
                    time.sleep(min(8, 0.5*(2**i))); continue
                return None
            logs = j['result']['meta'].get('logMessages', []) or []
            saw = False
            for l in logs:
                if f'Program {EXPONENT_PROGRAM} invoke' in l:
                    saw = True; continue
                if saw:
                    m = re.search(r'Instruction:\s*(\w+)', l)
                    if m:
                        name = m.group(1)
                        if name.lower() in SKIP_INSTRS:
                            saw = False; continue
                        return name
                    if l.startswith('Program ') and 'success' in l: saw = False
            return None
        except Exception:
            time.sleep(min(8, 0.5*(2**i)))
    return None

def main():
    # Load Helius key for get_instr
    from config import HELIUS_KEY
    os.environ['_HELIUS_KEY'] = HELIUS_KEY

    sigs = set()
    with open(TRADES) as f:
        for l in f:
            try: r = json.loads(l)
            except: continue
            if r.get('market'): sigs.add(r['sig'])
    print(f'Unique sigs: {len(sigs)}', flush=True)

    cache = {}
    if os.path.exists(CACHE):
        try: cache = json.load(open(CACHE))
        except: cache = {}
    pending = [s for s in sigs if s not in cache]
    print(f'Cached: {len(cache)}, to fetch: {len(pending)}', flush=True)

    lock = threading.Lock()
    state = {'done': 0, 'ok': 0, 'start': time.time()}
    def fetch(sig):
        inst = get_instr(sig)
        with lock:
            state['done'] += 1
            if inst:
                cache[sig] = inst
                state['ok'] += 1
            if state['done'] % 100 == 0:
                json.dump(cache, open(CACHE, 'w'))
                rate = state['done'] / max(time.time()-state['start'], 1)
                eta = (len(pending)-state['done']) / max(rate, 0.001)
                sys.stdout.write(f"\r{state['done']}/{len(pending)} ok={state['ok']} rate={rate:.1f}/s eta={eta/60:.1f}m")
                sys.stdout.flush()

    with ThreadPoolExecutor(max_workers=25) as ex:
        futs = [ex.submit(fetch, s) for s in pending]
        for f in as_completed(futs): f.result()
    json.dump(cache, open(CACHE, 'w'))
    print(f"\nDone. cached={len(cache)}", flush=True)

    # Re-classify
    out_lines = []
    counts = {}
    with open(TRADES) as f:
        for l in f:
            l = l.strip()
            if not l: continue
            try: r = json.loads(l)
            except: out_lines.append(l); continue
            if r.get('market'):
                inst = cache.get(r['sig'])
                r['instr'] = inst
                action = _MAP.get((inst or '').lower())
                if action:
                    r['action'] = action
                counts[r['action']] = counts.get(r['action'], 0) + 1
            out_lines.append(json.dumps(r))
    with open(TRADES, 'w') as f:
        f.write('\n'.join(out_lines) + '\n')
    print('Final event classification:')
    for k, v in sorted(counts.items(), key=lambda x: -x[1]):
        print(f'  {k}: {v}')

if __name__ == '__main__':
    main()
