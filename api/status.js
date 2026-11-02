// GET /api/status?sigs=a,b,c -> confirmation state of each signature.
const { rpc, send } = require('./_ej.js');

module.exports = async (req, res) => {
  const sigs = String((req.query || {}).sigs || '').split(',').filter((s) => /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s)).slice(0, 30);
  if (!sigs.length) return send(res, 400, { error: 'no signatures' });
  try {
    const r = await rpc('getSignatureStatuses', [sigs, { searchTransactionHistory: false }]);
    return send(res, 200, { statuses: r.value.map((v, i) => ({ sig: sigs[i], state: !v ? 'pending' : v.err ? 'failed' : v.confirmationStatus || 'processed' })) });
  } catch { return send(res, 502, { error: 'rpc unavailable' }); }
};
