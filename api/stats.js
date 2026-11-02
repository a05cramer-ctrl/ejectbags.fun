// GET /api/stats -> real totals from the treasury: every EJECT fee transfer is 0.5% of a swap's minimum SOL out,
// so volume = fees x 200. Reads the last 1000 treasury transactions. Cached 2 minutes.
const { rpc, isKey, send } = require('./_ej.js');

module.exports = async (req, res) => {
  const t = process.env.TREASURY;
  if (!isKey(t)) return send(res, 200, { ready: false });
  try {
    const sigs = await rpc('getSignaturesForAddress', [t, { limit: 1000, commitment: 'confirmed' }]);
    const ej = sigs.filter((s) => !s.err && s.memo && s.memo.includes('EJECT'));
    let fees = 0, wallets = new Set(), lastAt = 0;
    for (let i = 0; i < ej.length; i += 50) {
      const txs = await Promise.all(ej.slice(i, i + 50).map((s) => rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null)));
      for (const tx of txs) {
        if (!tx) continue;
        for (const ins of tx.transaction.message.instructions) if (ins.parsed && ins.parsed.type === 'transfer' && ins.parsed.info.destination === t) { fees += Number(ins.parsed.info.lamports); wallets.add(ins.parsed.info.source); }
        lastAt = Math.max(lastAt, (tx.blockTime || 0) * 1000);
      }
      if (i >= 200) break; // keep the function fast; counts the newest 250 ejected swaps
    }
    return send(res, 200, { ready: true, swaps: ej.length, wallets: wallets.size, feeLamports: fees, volumeLamports: fees * 200, lastAt }, 's-maxage=120, stale-while-revalidate=600');
  } catch { return send(res, 502, { error: 'rpc unavailable' }); }
};
