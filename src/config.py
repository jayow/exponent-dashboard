"""Shared config — loads .env and provides Helius API helpers."""
import os, re, json, time
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Load .env
ENV = {}
for l in open(os.path.join(ROOT, '.env')):
    l = l.strip()
    if not l or l.startswith('#') or '=' not in l: continue
    k, v = l.split('=', 1); ENV[k] = v

RAW = ENV.get('HELIUS_API_KEY', '').strip()
HELIUS_KEY = re.search(r'api-key=([^&]+)', RAW).group(1) if RAW.startswith('http') else RAW
RPC_URL = f'https://mainnet.helius-rpc.com/?api-key={HELIUS_KEY}'
ENHANCED_URL = f'https://api.helius.xyz/v0/transactions?api-key={HELIUS_KEY}&commitment=confirmed'

EXPONENT_PROGRAM = 'ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7'
EXPONENT_API = 'https://api.exponent.finance/markets'

DATA_DIR = os.path.join(ROOT, 'data')
os.makedirs(DATA_DIR, exist_ok=True)

def rpc(method, params, retries=15, timeout=30):
    body = {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}
    for i in range(retries):
        try:
            r = requests.post(RPC_URL, json=body,
                              headers={'User-Agent': 'curl/8.7.1'}, timeout=timeout)
            if r.status_code in (429, 413, 503, 504):
                time.sleep(min(4, 0.3*(2**i))); continue
            j = r.json()
            if j.get('error'):
                code = j['error'].get('code')
                if code in (-32429, -32413):
                    time.sleep(min(4, 0.3*(2**i))); continue
                raise RuntimeError(j['error'])
            return j.get('result')
        except requests.exceptions.RequestException:
            time.sleep(min(4, 0.3*(2**i)))
    raise RuntimeError('retries exhausted')

def enhanced_batch(sigs, retries=12, timeout=45):
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
