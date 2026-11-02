// GET /api/holdings?owner=<wallet> -> every token in the wallet with its USD value and SOL route, plus empty accounts and their locked rent.
const { isKey, accounts, prices, meta, rpc, send, SOL } = require('./_ej.js');

module.exports = async (req, res) => {
  const owner = String((req.query || {}).owner || '');
  if (!isKey(owner)) return send(res, 400, { error: 'That is not a Solana wallet address.' });
  try {
    const [accs, bal] = await Promise.all([accounts(owner), rpc('getBalance', [owner, { commitment: 'confirmed' }])]);
    const held = accs.filter((a) => a.raw !== '0' && a.mint !== SOL && !a.frozen);
    const empty = accs.filter((a) => a.raw === '0' && a.closable);
    const mints = [...new Set(held.map((a) => a.mint))];
    const [px, md] = await Promise.all([prices([...mints, SOL]), meta(mints)]);
    const solUsd = px[SOL] ? px[SOL].usdPrice : null;
    const tokens = held.map((a) => {
      const p = px[a.mint], m = md[a.mint] || {};
      return { mint: a.mint, account: a.account, program: a.program === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ? 'token-2022' : 'token', amount: a.ui, raw: a.raw, decimals: a.decimals, symbol: m.symbol || null, name: m.name || null, icon: m.icon || null, verified: !!m.verified, usd: p ? a.ui * p.usdPrice : null, priced: !!p, rent: a.lamports, closable: a.closable };
    }).sort((x, y) => (y.usd || 0) - (x.usd || 0));
    return send(res, 200, { owner, sol: bal.value, solUsd, tokens, empty: empty.length, emptyRent: empty.reduce((s, a) => s + a.lamports, 0), at: Date.now() }, 's-maxage=10');
  } catch (e) { return send(res, 502, { error: 'Could not read that wallet right now, try again.' }); }
};
