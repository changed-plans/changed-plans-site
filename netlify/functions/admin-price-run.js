'use strict';
/**
 * POST /api/admin/run-pricing — run the price-drop engine on demand.
 * Admin-gated (role='admin'). Applies any due ladder drops to active
 * listings, never below the applicable (pocket / pre-authorized endgame)
 * floor. In production the same logic runs every 15 minutes from
 * scheduled-pricing.js — the cadence the concierge engine used. See
 * _lib/pricing.js for the three-number floor rules.
 */
const { ok, badRequest, forbidden, serverError } = require('./_lib/http');
const { runPriceEngine } = require('./_lib/pricing');
const auth = require('./_lib/auth');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('POST only.');
  const admin = await auth.adminUser(event);
  if (!admin) return forbidden('Admin only.');
  try {
    const actor = admin.display_name || admin.email;
    return ok(await runPriceEngine(actor));
  } catch (err) { return serverError(err); }
};
