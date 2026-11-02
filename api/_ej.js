// Shared EJECT helpers (files starting with _ are not routes on Vercel).
// Env: HELIUS_API_KEY (or RPC_URL) for Solana RPC, TREASURY (wallet that receives the 0.5% fee).
const { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount, SystemProgram, ComputeBudgetProgram } = require('@solana/web3.js');

const RPC = process.env.RPC_URL || (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 'https://api.mainnet-beta.solana.com');
const JUP = process.env.JUPITER_API_KEY ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
const JUPH = process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {};
const SOL = 'So11111111111111111111111111111111111111112';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const FEE_BPS = 50; // 0.5%
const MAX_TOKENS = 20;

async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function jup(path, opt = {}, tries = 4) {
  for (let i = 0; ; i++) {
    const r = await fetch(JUP + path, { ...opt, headers: { 'content-type': 'application/json', ...JUPH, ...(opt.headers || {}) } });
    if (r.status === 429 && i < tries) { await wait(700 * (i + 1)); continue; } // Jupiter's free tier rate limit: back off and retry
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || `jupiter ${r.status}`);
    return j;
  }
}
const isKey = (s) => { try { return new PublicKey(String(s)).toBase58() === String(s); } catch { return false; } };

// Every token account the wallet holds (classic + Token-2022), with balance, program, and whether it can be closed after a full swap.
async function accounts(owner) {
  const [a, b] = await Promise.all([TOKEN, TOKEN22].map((programId) => rpc('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }])));
  const out = [];
  for (const [list, program] of [[a, TOKEN], [b, TOKEN22]]) {
    for (const { pubkey, account } of (list && list.value) || []) {
      const info = account.data && account.data.parsed && account.data.parsed.info; if (!info) continue;
      const exts = info.extensions || [];
      const withheld = exts.some((e) => e.extension === 'transferFeeAmount' && Number(e.state && e.state.withheldAmount) > 0);
      out.push({ account: pubkey, mint: info.mint, program, raw: info.tokenAmount.amount, decimals: info.tokenAmount.decimals, ui: Number(info.tokenAmount.uiAmountString || 0), lamports: account.lamports, closable: !withheld && info.state === 'initialized' && !info.delegate, frozen: info.state === 'frozen' });
    }
  }
  return out;
}

async function prices(mints) {
  const res = {};
  for (let i = 0; i < mints.length; i += 50) {
    const j = await jup(`/price/v3?ids=${mints.slice(i, i + 50).join(',')}`).catch(() => ({}));
    Object.assign(res, j);
  }
  return res;
}
async function meta(mints) { // names + icons from Jupiter's token search (one call per 50)
  const res = {};
  for (let i = 0; i < mints.length; i += 50) {
    const j = await jup(`/tokens/v2/search?query=${mints.slice(i, i + 50).join(',')}`).catch(() => []);
    for (const t of Array.isArray(j) ? j : []) res[t.id] = { symbol: t.symbol, name: t.name, icon: t.icon, verified: !!t.isVerified };
  }
  return res;
}

const ix = (i) => new TransactionInstruction({ programId: new PublicKey(i.programId), keys: i.accounts.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(i.data, 'base64') });
const closeIx = (account, owner, program) => new TransactionInstruction({ programId: new PublicKey(program), keys: [{ pubkey: new PublicKey(account), isSigner: false, isWritable: true }, { pubkey: new PublicKey(owner), isSigner: false, isWritable: true }, { pubkey: new PublicKey(owner), isSigner: true, isWritable: false }], data: Buffer.from([9]) });
const memoIx = (text, owner) => new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: new PublicKey(owner), isSigner: true, isWritable: false }], data: Buffer.from(text, 'utf8') });

// One full-balance swap to SOL for one token account. Returns an unsigned v0 transaction + numbers.
async function swapTx(owner, acc, treasury) {
  const q = await jup(`/swap/v1/quote?inputMint=${acc.mint}&outputMint=${SOL}&amount=${acc.raw}&slippageBps=300&restrictIntermediateTokens=true&maxAccounts=40`);
  const s = await jup('/swap/v1/swap-instructions', { method: 'POST', body: JSON.stringify({ quoteResponse: q, userPublicKey: owner, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 100000, priorityLevel: 'high' } } }) });
  const minOut = BigInt(q.otherAmountThreshold);
  const fee = treasury ? (minOut * BigInt(FEE_BPS)) / 10000n : 0n;
  const ixs = [...(s.computeBudgetInstructions || []).map(ix), ...(s.setupInstructions || []).map(ix), ix(s.swapInstruction)];
  if (s.cleanupInstruction) ixs.push(ix(s.cleanupInstruction));
  if (acc.closable) ixs.push(closeIx(acc.account, owner, acc.program));
  if (fee > 0n) { ixs.push(SystemProgram.transfer({ fromPubkey: new PublicKey(owner), toPubkey: new PublicKey(treasury), lamports: fee })); ixs.push(memoIx('EJECT', owner)); }
  const alts = Object.entries(s.addressesByLookupTableAddress || {}).map(([key, addrs]) => new AddressLookupTableAccount({ key: new PublicKey(key), state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: addrs.map((a) => new PublicKey(a)) } }));
  const msg = new TransactionMessage({ payerKey: new PublicKey(owner), recentBlockhash: s.blockhashWithMetadata ? bs58enc(s.blockhashWithMetadata.blockhash) : (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash, instructions: ixs }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  if (tx.serialize().length > 1232) throw new Error('route too large');
  return { mint: acc.mint, tx: Buffer.from(tx.serialize()).toString('base64'), outLamports: q.outAmount, minLamports: q.otherAmountThreshold, feeLamports: fee.toString(), rentBack: acc.closable ? acc.lamports : 0, impact: Number(q.priceImpactPct || 0) };
}
// blockhashWithMetadata.blockhash comes back as a byte array
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58enc(b) {
  if (typeof b === 'string') return b;
  let n = 0n; for (const x of b) n = n * 256n + BigInt(x);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x === 0) s = '1' + s; else break; }
  return s;
}

// Close empty token accounts in batches of 20 per transaction (rent goes back to the owner, no fee).
async function closeTxs(owner, empties) {
  const { value } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const out = [];
  for (let i = 0; i < empties.length; i += 20) {
    const part = empties.slice(i, i + 20);
    const msg = new TransactionMessage({ payerKey: new PublicKey(owner), recentBlockhash: value.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 6000 * part.length + 2000 }), ...part.map((a) => closeIx(a.account, owner, a.program))] }).compileToV0Message();
    out.push({ close: part.length, tx: Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64'), rentBack: part.reduce((s, a) => s + a.lamports, 0) });
  }
  return out;
}

function send(res, code, body, cache = 'no-store') { res.setHeader('Cache-Control', cache); res.setHeader('Access-Control-Allow-Origin', '*'); res.status(code).json(body); }
async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } }); });
}

module.exports = { rpc, jup, isKey, accounts, prices, meta, swapTx, closeTxs, send, body, SOL, FEE_BPS, MAX_TOKENS, bs58enc };
