// POST /api/plan { owner, mints: [...], closeEmpty: bool } -> unsigned transactions: one full-balance swap to SOL per token
// (the emptied account is closed in the same transaction), plus batches that close empty accounts. The wallet signs them all at once.
const { isKey, accounts, swapTx, closeTxs, send, body, MAX_TOKENS, SOL } = require('./_ej.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const b = await body(req);
  const owner = String(b.owner || '');
  if (!isKey(owner)) return send(res, 400, { error: 'Connect a wallet first.' });
  const want = new Set((Array.isArray(b.mints) ? b.mints : []).map(String).slice(0, MAX_TOKENS));
  try {
    const accs = await accounts(owner);
    const pick = accs.filter((a) => want.has(a.mint) && a.raw !== '0' && a.mint !== SOL && !a.frozen);
    const treasury = isKey(process.env.TREASURY) ? process.env.TREASURY : '';
    const swaps = [], skipped = [];
    // quote in small parallel groups so Jupiter's rate limit holds
    for (let i = 0; i < pick.length; i += 2) {
      const part = await Promise.all(pick.slice(i, i + 2).map((a) => swapTx(owner, a, treasury).catch((e) => ({ mint: a.mint, error: /route|liquidity|COULD_NOT_FIND/i.test(e.message) ? 'no route to SOL' : 'quote failed' }))));
      for (const p of part) (p.error ? skipped : swaps).push(p);
    }
    const empties = b.closeEmpty ? accs.filter((a) => a.raw === '0' && a.closable).slice(0, 200) : [];
    const closes = empties.length ? await closeTxs(owner, empties) : [];
    const sum = (k) => swaps.reduce((s, x) => s + BigInt(x[k]), 0n);
    return send(res, 200, { owner, swaps, closes, skipped, totals: { outLamports: sum('outLamports').toString(), minLamports: sum('minLamports').toString(), feeLamports: sum('feeLamports').toString(), rentBack: (swaps.reduce((s, x) => s + x.rentBack, 0) + closes.reduce((s, c) => s + c.rentBack, 0)).toString() }, feeBps: treasury ? 50 : 0, at: Date.now() });
  } catch (e) { return send(res, 502, { error: 'Could not build the eject, try again.' }); }
};
