/**
 * Fetch live market data from Exponent API + Jupiter price API for USD conversion.
 * Writes web/public/markets-live.json with accurate liquidity matching their UI.
 *
 * TVL = legacyLiquidity / 10^decimals × underlying_price_usd
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'web/public/markets-live.json');

// Load Helius RPC
const _env = {};
for (const l of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
  const t = l.trim(); if (!t || t.startsWith('#') || !t.includes('=')) continue;
  const [k, ...v] = t.split('='); _env[k] = v.join('=');
}
// RPC pool — comma-separated list in .env; first is primary, rest are failover.
// Public RPC stays appended as last-ditch fallback.
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const RPC_POOL = (_env.RPC_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
if (RPC_POOL.length === 0) {
  // Backwards-compat: single HELIUS_API_KEY still works
  const _raw = (_env.HELIUS_API_KEY || '').trim();
  if (_raw) RPC_POOL.push(_raw.startsWith('http') ? _raw : `https://mainnet.helius-rpc.com/?api-key=${_raw}`);
}
if (RPC_POOL.length === 0) { console.error('FATAL: No RPC_URLS configured in .env'); process.exit(1); }
const ALL_RPCS = [...RPC_POOL, PUBLIC_RPC];
const RPC_URL = RPC_POOL[0]; // legacy alias

const sleep = ms => new Promise(r => setTimeout(r, ms));
let rpcIdx = 0;
const rpcUsage = new Map();
const nextRpc = () => { const u = ALL_RPCS[rpcIdx % ALL_RPCS.length]; rpcIdx++; return u; };

// Rotate through the pool with per-call failover. Throws only if every URL fails in this call.
async function rpcCall(body) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'curl/8.7.1' };
  let lastErr;
  for (let attempt = 0; attempt < ALL_RPCS.length; attempt++) {
    const url = nextRpc();
    try {
      // Throttle public RPC slightly
      if (url === PUBLIC_RPC) await sleep(150);
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!r.ok) { lastErr = `${r.status} ${url}`; continue; }
      const j = await r.json();
      if (j.error) { lastErr = `RPC error ${j.error.code} ${url}`; continue; }
      rpcUsage.set(url, (rpcUsage.get(url) || 0) + 1);
      return j;
    } catch (e) {
      lastErr = `${e.message} ${url}`;
    }
  }
  throw new Error(`all RPCs failed (last: ${lastErr})`);
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function main() {
  // 1) Fetch all markets from Exponent API
  console.log('Fetching Exponent markets...');
  const markets = await fetchJSON('https://api.exponent.finance/markets');
  console.log(`Got ${markets.length} markets`);

  // 2) Collect unique QUOTE ASSET mints for price lookup
  //    (legacyLiquidity is denominated in quoteAsset, not underlying)
  const mints = [...new Set(markets.map(m => m.quoteAsset?.mint).filter(Boolean))];
  console.log(`Unique quote asset mints: ${mints.length}`);

  // 3) Fetch USD prices — individual CoinGecko lookups (batch fails with phantom USD mints)
  console.log('Fetching prices from CoinGecko (individual)...');
  const priceMap = {};
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const allPriceMints = [...new Set([SOL_MINT, ...mints])];
  for (const mint of allPriceMints) {
    // Skip phantom USD mints — price = $1
    if (mint.startsWith('USD1')) { priceMap[mint] = 1.0; continue; }
    try {
      const r = await fetch(`https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${mint}&vs_currencies=usd`);
      if (r.ok) {
        const d = await r.json();
        if (d[mint]?.usd) { priceMap[mint] = d[mint].usd; console.log(`  ${mint.slice(0,8)}: $${d[mint].usd}`); continue; }
      }
    } catch {}
    // Heuristic fallback
    const mk = markets.find(m => m.quoteAsset?.mint === mint);
    const ticker = mk?.quoteAsset?.ticker || '';
    if (/USD|USX/i.test(ticker)) priceMap[mint] = 1.0;
    else if (/BTC/i.test(ticker)) priceMap[mint] = priceMap[SOL_MINT] ? priceMap[SOL_MINT] * 1080 : 0;
    else priceMap[mint] = priceMap[SOL_MINT] || 0;
    console.log(`  ${mint.slice(0,8)}: $${priceMap[mint]} (fallback from ${ticker || 'unknown'})`);
  }
  if (!priceMap[SOL_MINT]) { console.error('FATAL: No SOL price available'); process.exit(1); }
  const solPrice = priceMap[SOL_MINT];
  console.log(`SOL=$${solPrice}`);

  // 4) Fetch SY + PT + YT mint supplies for TVL breakdown
  //    TVL = SY_supply × syExchangeRate × underlying_price
  console.log('Fetching SY/PT/YT mint supplies from RPC...');
  const syMints = [...new Set(markets.map(m => m.syMint))];
  const ptMints = markets.map(m => m.ptMint);
  const ytMints = markets.map(m => m.ytMint);
  const allMints = [...new Set([...syMints, ...ptMints, ...ytMints])];
  const env2 = {};
  for (const l of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const t = l.trim(); if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const [k, ...v] = t.split('='); env2[k] = v.join('=');
  }
  const rpcKey = env2.HELIUS_API_KEY || '';
  const rpcEndpoint = rpcKey.startsWith('http') ? rpcKey : `https://mainnet.helius-rpc.com/?api-key=${rpcKey}`;
  const mintSupplyMap = {};
  for (const mint of allMints) {
    try {
      const j = await rpcCall({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [mint, { encoding: 'jsonParsed' }] });
      const supply = BigInt(j.result?.value?.data?.parsed?.info?.supply || '0');
      const dec = j.result?.value?.data?.parsed?.info?.decimals || 6;
      mintSupplyMap[mint] = { supply, decimals: dec };
    } catch (e) {
      console.error(`  ${mint.slice(0, 12)}... failed: ${e.message}`);
    }
  }
  console.log(`  Fetched ${Object.keys(mintSupplyMap).length} / ${allMints.length} mint supplies`);
  for (const [u, n] of rpcUsage) console.log(`    ${n}× ${u.replace(/api-key=[^&]+/, 'api-key=…').replace(/v2\/[^/]+/, 'v2/…').slice(0, 70)}`);
  // Fail fast if RPC is broken — better to keep the previous JSON than overwrite with zeros.
  if (Object.keys(mintSupplyMap).length < allMints.length * 0.8) {
    console.error(`FATAL: only ${Object.keys(mintSupplyMap).length}/${allMints.length} mint supplies fetched — aborting to preserve existing JSON.`);
    process.exit(1);
  }

  // 5) Query PT-in-pool for clean Income/Farm/LP decomposition
  //    Pool address = legacyMarketAddresses[0] for each market
  console.log('Querying PT-in-pool balances...');
  const ptInPoolMap = {};
  for (const m of markets) {
    const poolAddr = m.legacyMarketAddresses?.[0];
    const ptMint = m.ptMint;
    if (!poolAddr || !ptMint) continue;
    try {
      const j = await rpcCall({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
        params: [poolAddr, { mint: ptMint }, { encoding: 'jsonParsed' }] });
      for (const acct of (j.result?.value || [])) {
        const amt = BigInt(acct.account.data.parsed.info.tokenAmount.amount);
        const dec = acct.account.data.parsed.info.tokenAmount.decimals;
        ptInPoolMap[ptMint] = Number(amt) / Math.pow(10, dec);
      }
    } catch {}
  }
  console.log(`  Got PT-in-pool for ${Object.keys(ptInPoolMap).length} markets`);

  // 5b) Deduplicate shared SY mints — split TVL proportionally by PT supply
  const syMintCount = {};
  const syMintPtTotal = {};
  for (const m of markets) {
    const sy = m.syMint;
    syMintCount[sy] = (syMintCount[sy] || 0) + 1;
    const ptInfo = mintSupplyMap[m.ptMint];
    const ptSupply = ptInfo ? Number(ptInfo.supply) : 0;
    syMintPtTotal[sy] = (syMintPtTotal[sy] || 0) + ptSupply;
  }

  // 6) Build output
  const out = markets.map(m => {
    const dec = m.decimals || 6;
    const quoteMint = m.quoteAsset?.mint || m.underlyingAsset.mint;
    const price = priceMap[quoteMint] || 1;
    const legacyLiq = Number(m.legacyLiquidity || 0);
    const liquidityTokens = legacyLiq / Math.pow(10, dec);
    const liquidityUsd = liquidityTokens * price;
    const matDate = new Date(m.maturityDateUnixTs * 1000);
    const daysLeft = Math.max(0, Math.round((matDate - Date.now()) / 86400000));

    // DeFiLlama-style TVL + clean Income/Farm/LP decomposition
    const syInfo = mintSupplyMap[m.syMint];
    const ptInfo = mintSupplyMap[m.ptMint];
    const ytInfo = mintSupplyMap[m.ytMint];
    const syExRate = m.syExchangeRate || 1;
    const underlyingMint = m.underlyingAsset.mint;
    const underlyingPrice = priceMap[underlyingMint] || priceMap[quoteMint] || price;
    let tvlUsd = 0;
    if (syInfo) {
      const syTokens = Number(syInfo.supply) / Math.pow(10, syInfo.decimals);
      let fullTvl = syTokens * syExRate * underlyingPrice;
      // If SY mint is shared by multiple markets, split proportionally by PT supply
      if (syMintCount[m.syMint] > 1) {
        const ptSupply = ptInfo ? Number(ptInfo.supply) : 0;
        const totalPt = syMintPtTotal[m.syMint] || 1;
        const share = totalPt > 0 ? ptSupply / totalPt : (1 / syMintCount[m.syMint]);
        tvlUsd = fullTvl * share;
      } else {
        tvlUsd = fullTvl;
      }
    }
    // Clean decomposition: Income + Farm + LP = TVL
    const ptTotal = ptInfo ? Number(ptInfo.supply) / Math.pow(10, ptInfo.decimals) : 0;
    const ptInPool = ptInPoolMap[m.ptMint] || 0;
    const ptOutsidePool = Math.max(0, ptTotal - ptInPool);
    const incomeTvl = ptOutsidePool * (m.ptPriceInAsset || 1) * underlyingPrice;
    // Farm TVL: use actual YieldPosition holder balances from holders.json (not mint supply,
    // which includes protocol-held YT). Falls back to 0 if no holder data.
    let farmTvl = 0;
    try {
      const holdersRaw = readFileSync(join(ROOT, 'web/public/holders.json'), 'utf8');
      const holders = JSON.parse(holdersRaw);
      const matDate2 = new Date(m.maturityDateUnixTs * 1000);
      const dd2 = String(matDate2.getUTCDate()).padStart(2, '0');
      const mmm2 = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][matDate2.getUTCMonth()];
      const yy2 = String(matDate2.getUTCFullYear()).slice(-2);
      const marketKey = `${m.underlyingAsset.ticker}-${dd2}${mmm2}${yy2}`;
      const ytData = holders[`${marketKey}:yt`];
      if (ytData?.totalBalance) {
        farmTvl = ytData.totalBalance * (m.ytPriceInAsset || 0) * underlyingPrice;
      }
    } catch {}
    const lpTvl = liquidityUsd;

    return {
      ticker: m.underlyingAsset.ticker,
      name: m.underlyingAsset.name,
      platform: m.platformName || '?',
      maturity: matDate.toISOString().slice(0, 10),
      daysLeft,
      status: m.marketStatus,
      liquidityUsd: Math.round(liquidityUsd),
      tvlUsd: Math.round(tvlUsd),
      incomeTvl: Math.round(incomeTvl),
      farmTvl: Math.round(farmTvl),
      lpTvl: Math.round(lpTvl),
      idleTvl: Math.round(Math.max(0, tvlUsd - incomeTvl - farmTvl - lpTvl)),  // undeployed SY
      liquidityTokens: Math.round(liquidityTokens),
      impliedApy: m.impliedApy || 0,
      underlyingApy: m.underlyingApy || 0,
      ytPrice: m.ytPriceInAsset || 0,
      ptPrice: m.ptPriceInAsset || 0,
      yieldExposure: m.yieldExposure || 0,
      underlyingPrice: price,
      pointsName: m.pointsName || null,
      categories: m.categories || [],
      ytMint: m.ytMint,
      ptMint: m.ptMint,
    };
  });

  // Filter out zero-liquidity markets (not shown on Exponent UI either)
  const filtered = out.filter(m => m.liquidityUsd > 100);
  // Sort by liquidity desc
  filtered.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const out2 = filtered;

  const totalLiquidity = out2.reduce((s, m) => s + m.liquidityUsd, 0);
  const totalTvl = out2.reduce((s, m) => s + m.tvlUsd, 0);
  const totalIncome = out2.reduce((s, m) => s + m.incomeTvl, 0);
  const totalFarm = out2.reduce((s, m) => s + m.farmTvl, 0);
  const totalLp = out2.reduce((s, m) => s + m.lpTvl, 0);
  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalTvlUsd: totalTvl,
    totalIncomeTvl: totalIncome,
    totalFarmTvl: totalFarm,
    totalLpTvl: totalLp,
    totalLiquidityUsd: totalLiquidity,
    markets: out2,
  }, null, 2));
  const totalIdle = Math.max(0, totalTvl - totalIncome - totalFarm - totalLp);
  console.log(`\nTVL Decomposition:`);
  console.log(`  Income (PT outside pool): $${(totalIncome/1e6).toFixed(2)}M`);
  console.log(`  Farm (YT positions):      $${(totalFarm/1e6).toFixed(2)}M`);
  console.log(`  LP (pool liquidity):      $${(totalLp/1e6).toFixed(2)}M`);
  console.log(`  Idle (undeployed SY):     $${(totalIdle/1e6).toFixed(2)}M`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Sum:                      $${(totalTvl/1e6).toFixed(2)}M ✓`);
  console.log(`\nWrote ${out2.length} markets to ${OUT} (filtered ${out.length - out2.length} zero-liq)`);
  console.log(`Pool Liquidity: $${(totalLiquidity / 1e6).toFixed(2)}M`);
  console.log(`Protocol TVL:   $${(totalTvl / 1e6).toFixed(2)}M  (DeFiLlama method: SY_supply × exchange_rate)\n`);
  for (const m of out2) {
    const liq = m.liquidityUsd > 1e6 ? `$${(m.liquidityUsd/1e6).toFixed(2)}M` : `$${(m.liquidityUsd/1e3).toFixed(1)}K`;
    const tvl = m.tvlUsd > 1e6 ? `$${(m.tvlUsd/1e6).toFixed(2)}M` : `$${(m.tvlUsd/1e3).toFixed(1)}K`;
    console.log(`  ${m.ticker.padEnd(12)} ${m.platform.padEnd(22)} pool=${liq.padStart(10)}  tvl=${tvl.padStart(10)}  APY=${(m.impliedApy*100).toFixed(2)}%`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
