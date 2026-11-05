'use strict';
/**
 * scheduled-pricing.js — Netlify SCHEDULED function (production only).
 * Runs the price-drop engine every 15 minutes — the same cadence the
 * concierge price engine (price_engine.py) ran on. Rules live in
 * _lib/pricing.js (ladder + three-number floors). The desk can run the
 * same engine by hand via POST /api/admin/run-pricing.
 *
 * Scheduled functions are invoked by Netlify's scheduler, not by HTTP —
 * there is intentionally no redirect for this file in netlify.toml.
 */
const { runPriceEngine } = require('./_lib/pricing');

exports.handler = async () => {
  const result = await runPriceEngine('scheduled-pricing');
  console.log('[scheduled-pricing]', JSON.stringify(result)); // log EVERY run — invocation evidence (2026-11-04)
  return { statusCode: 200, body: JSON.stringify(result) };
};

// Netlify scheduled-function declaration (cron, UTC).
exports.config = { schedule: '*/15 * * * *' };
