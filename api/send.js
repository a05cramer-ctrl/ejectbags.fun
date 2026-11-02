// POST /api/send { txs: [base64 signed transactions] } -> sends each one, returns signatures (or the error per tx).
const { rpc, send, body } = require('./_ej.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const b = await body(req);
  const txs = (Array.isArray(b.txs) ? b.txs : []).slice(0, 30);
  if (!txs.length) return send(res, 400, { error: 'nothing to send' });
  const out = await Promise.all(txs.map(async (t) => {
    try { return { sig: await rpc('sendTransaction', [t, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]) }; }
    catch (e) { return { error: String(e.message || e).slice(0, 160) }; }
  }));
  return send(res, 200, { results: out });
};
