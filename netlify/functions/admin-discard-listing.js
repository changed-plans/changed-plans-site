'use strict';
/**
 * POST /api/admin/discard-listing { listing_id } — withdraw a listing that
 * is still in the inbound stage (awaiting_transfer) and will never be
 * verified: a duplicate submission, a seller who never transfers, a test
 * listing. Admin-gated. The listing goes to the terminal `withdrawn` state
 * (state machine permits awaiting_transfer -> withdrawn), which also drops
 * it from the desk's inbound queue (the queue only shows listings still in
 * awaiting_transfer). Paid/active history is never discardable here —
 * anything that was ever buyable keeps its full record.
 * Added 2026-11-04: the desk had no way to remove Scott's accidental
 * duplicate test listing; the only path was raw SQL in Neon.
 */
const db = require('./_lib/db');
const { ok, badRequest, forbidden, notFound, conflict, parseBody, serverError } = require('./_lib/http');
const { transitionListing } = require('./_lib/state');
const auth = require('./_lib/auth');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('POST only.');
  const admin = await auth.adminUser(event);
  if (!admin) return forbidden('Admin only.');
  const body = parseBody(event);
  if (!body || !body.listing_id) return badRequest('listing_id is required.');
  try {
    const listing = await db.get('SELECT * FROM listings WHERE id = ?', body.listing_id);
    if (!listing) return notFound('Listing not found.');
    if (listing.status !== 'awaiting_transfer') {
      return conflict('Only a listing still awaiting its transfer can be discarded.');
    }
    const actor = admin.display_name || admin.email;
    await transitionListing(listing.id, 'withdrawn', actor, 'Discarded from the desk — never verified, never listed');
    return ok({ discarded: listing.id });
  } catch (err) { return serverError(err); }
};
