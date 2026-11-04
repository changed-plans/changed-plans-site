'use strict';
/**
 * scheduled-sweep.js — Netlify SCHEDULED function (production only).
 * Runs the reservation-expiry sweep every 5 minutes so a lapsed 15-minute
 * hold releases its listing promptly even when no Stripe event arrives.
 * The logic lives in _lib/sweep.js; the desk can run the same sweep by
 * hand via POST /api/admin/sweep.
 *
 * Scheduled functions are invoked by Netlify's scheduler, not by HTTP —
 * there is intentionally no redirect for this file in netlify.toml.
 */
const { sweepExpiredReservations } = require('./_lib/sweep');

exports.handler = async () => {
  const result = await sweepExpiredReservations('scheduled-sweep');
  if (result.released_count) console.log('[scheduled-sweep]', JSON.stringify(result));
  return { statusCode: 200, body: JSON.stringify(result) };
};

// Netlify scheduled-function declaration (cron, UTC).
exports.config = { schedule: '*/5 * * * *' };
