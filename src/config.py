"""Shared config — loads .env and provides RPC helpers with multi-endpoint failover."""
import os, json, time, itertools
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Load .env
ENV = {}
for l in open(os.path.join(ROOT, '.env')):
    l = l.strip()
    if not l or l.startswith('#') or '=' not in l: continue
    k, v = l.split('=', 1); ENV[k] = v

# RPC pool — comma-separated list; first is primary, rest are failover
RPC_URLS = [u.strip() for u in ENV.get('RPC_URLS', '').split(',') if u.strip()]
if not RPC_URLS:
    raise RuntimeError('No RPC_URLS configured in .env')

# Public Solana RPC as last-resort fallback (heavily rate-limited)
PUBLIC_RPC = 'https://api.mainnet-beta.solana.com'
ALL_RPCS = RPC_URLS + [PUBLIC_RPC]

# Backwards-compat: primary URL exposed as RPC_URL (some scripts may import it directly)
RPC_URL = RPC_URLS[0]

# Helius enhanced transactions API — optional, only used by parse_events.py
HELIUS_KEY = ENV.get('HELIUS_API_KEY', '').strip()
ENHANCED_URL = f'https://api.helius.xyz/v0/transactions?api-key={HELIUS_KEY}&commitment=confirmed' if HELIUS_KEY else ''

EXPONENT_PROGRAM = 'ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7'
EXPONENT_API = 'https://api.exponent.finance/markets'

DATA_DIR = os.path.join(ROOT, 'data')
os.makedirs(DATA_DIR, exist_ok=True)

# Rotation: cycle through RPCs so load is spread across providers.
# When a request fails we advance and try the next URL before sleeping.
_rpc_cycle = itertools.cycle(ALL_RPCS)

def _next_url():
    return next(_rpc_cycle)

def rpc(method, params, retries=15, timeout=30):
    body = {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}
    last_err = None
    for i in range(retries):
        url = _next_url()
        try:
            r = requests.post(url, json=body,
                              headers={'Content-Type': 'application/json', 'User-Agent': 'curl/8.7.1'},
                              timeout=timeout)
            if r.status_code in (429, 413, 503, 504):
                last_err = f'{url}: HTTP {r.status_code}'
                # Try the next URL immediately; back off only after cycling through all
                if i >= len(ALL_RPCS):
                    time.sleep(min(4, 0.3*(2**(i - len(ALL_RPCS)))))
                continue
            r.raise_for_status()
            j = r.json()
            if j.get('error'):
                code = j['error'].get('code')
                # Rotate to next URL on rate limits AND node-capability errors
                # (e.g. -32011 "Transaction history is not available from this node"
                # which the public Solana RPC returns for getSignaturesForAddress).
                if code in (-32429, -32413, -32005, -32603, -32011, -32007, -32008, -32009):
                    last_err = f'{url}: RPC error {code}'
                    if i >= len(ALL_RPCS):
                        time.sleep(min(4, 0.3*(2**(i - len(ALL_RPCS)))))
                    continue
                raise RuntimeError(j['error'])
            return j.get('result')
        except requests.exceptions.RequestException as e:
            last_err = f'{url}: {type(e).__name__}'
            if i >= len(ALL_RPCS):
                time.sleep(min(4, 0.3*(2**(i - len(ALL_RPCS)))))
    raise RuntimeError(f'retries exhausted (last: {last_err})')

def enhanced_batch(sigs, retries=12, timeout=45):
    if not ENHANCED_URL:
        raise RuntimeError('HELIUS_API_KEY not set in .env — enhanced_batch is unavailable')
    for i in range(retries):
        try:
            r = requests.post(ENHANCED_URL, json={'transactions': sigs},
                              headers={'Content-Type': 'application/json', 'User-Agent': 'curl/8.7.1'},
                              timeout=timeout)
            if r.status_code in (429, 413, 403, 503, 504):
                time.sleep(min(8, 0.5*(2**i))); continue
            r.raise_for_status()
            return r.json()
        except requests.exceptions.RequestException:
            time.sleep(min(8, 0.5*(2**i)))
    raise RuntimeError('retries exhausted')
