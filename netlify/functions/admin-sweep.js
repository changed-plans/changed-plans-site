'use strict';
/**
 * POST /api/admin/sweep — run the reservation-expiry sweeper on demand.
 * Admin-gated (role='admin'). Releases every order whose 15-minute hold
 * has lapsed (order -> cancelled, listing -> active) and reports what it
 * released. In production the same logic runs unattended from
 * scheduled-sweep.js; this endpoint exists for the desk and for local
 * testing. See _lib/sweep.js.
 */
const { ok, badRequest, forbidden, serverError } = require('./_lib/http');
const { sweepExpiredReservations } = require('./_lib/sweep');
const auth = require('./_lib/auth');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('POST only.');
  const admin = await auth.adminUser(event);
  if (!admin) return forbidden('Admin only.');
  try {
    const actor = admin.display_name || admin.email;
    return ok(await sweepExpiredReservations(actor));
  } catch (err) { return serverError(err); }
};
