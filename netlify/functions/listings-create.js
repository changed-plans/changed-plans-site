'use strict';
/**
 * POST /api/listings — seller intake (requires sign-in).
 *
 * Body: { event_name, event_date, venue, location, category, seats, qty,
 *         face_price, price, restrictions,
 *         pocket_floor?, endgame_floor?, endgame_authorized?,
 *         allow_price_drops? }   (prices as dollar strings)
 *
 * Enforces, server-side:
 *  - Code #1: price <= face value (money.validatePriceVsFace + DB CHECK).
 *  - Code #3: restrictions are REQUIRED — no listing without them.
 *  - Code #4: the listing is created in `awaiting_transfer`; it cannot be
 *    bought until the ticket is in our account and an admin verifies it.
 *  - The THREE-NUMBER FLOOR INTAKE (2026-10-31 standard): if the seller
 *    grants staged price-drop authority, the numbers are settled NOW, up
 *    front — pocket floor (required with drop authority), game-morning
 *    endgame floor (required if its use is pre-authorized), and the
 *    pre-authorization itself. Floors may never exceed face value, and
 *    the endgame floor may not exceed the pocket floor. See _lib/pricing.js.
 * Returns transfer instructions for the seller.
 */
const db = require('./_lib/db');
const { created, badRequest, unauthorized, parseBody, serverError } = require('./_lib/http');
const { dollarsToCents, validatePriceVsFace, formatCents } = require('./_lib/money');
const auth = require('./_lib/auth');
const { transitionListing } = require('./_lib/state');

// Where sellers send tickets inside Ticketmaster. Env-overridable; the
// default is the account Changed Plans already uses for concierge escrow.
const TRANSFER_TO = process.env.TRANSFER_TO_EMAIL || 'seugeneb@comcast.net';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('POST only.');
  const seller = await auth.userFromEvent(event);
  if (!seller) return unauthorized('Sign in to list tickets.');
  const b = parseBody(event);
  if (!b) return badRequest('Invalid JSON.');

  const required = ['event_name', 'event_date', 'venue', 'location', 'seats', 'restrictions'];
  for (const f of required) {
    if (!b[f] || String(b[f]).trim().length < 2) return badRequest(`Missing or too short: ${f}`);
  }
  if (String(b.restrictions).trim().length < 10) {
    return badRequest('Restrictions are required (Code #3): transferability, entry requirements, anything a buyer must know before paying.');
  }
  const qty = parseInt(b.qty, 10);
  if (!Number.isInteger(qty) || qty < 1 || qty > 20) return badRequest('Quantity must be 1–20.');

  const faceCents = dollarsToCents(b.face_price);
  const priceCents = dollarsToCents(b.price);
  if (faceCents === null || priceCents === null) return badRequest('Prices must look like 355 or 355.50.');
  const cap = validatePriceVsFace(priceCents, faceCents);
  if (!cap.ok) return badRequest(cap.error);

  // --- Three-number floor intake (only relevant with drop authority) ---
  const dropsEnabled = !!b.allow_price_drops;
  const endgameAuthorized = !!b.endgame_authorized;
  let pocketFloorCents = null;
  let endgameFloorCents = null;
  if (b.pocket_floor !== undefined && b.pocket_floor !== null && b.pocket_floor !== '') {
    pocketFloorCents = dollarsToCents(b.pocket_floor);
    if (pocketFloorCents === null) return badRequest('Pocket floor must look like 300 or 300.50.');
  }
  if (b.endgame_floor !== undefined && b.endgame_floor !== null && b.endgame_floor !== '') {
    endgameFloorCents = dollarsToCents(b.endgame_floor);
    if (endgameFloorCents === null) return badRequest('Endgame floor must look like 225 or 225.50.');
  }
  if (pocketFloorCents !== null && pocketFloorCents > faceCents) {
    return badRequest('Your pocket floor cannot exceed face value.');
  }
  if (endgameFloorCents !== null && pocketFloorCents !== null && endgameFloorCents > pocketFloorCents) {
    return badRequest('Your endgame floor cannot be higher than your pocket floor.');
  }
  if (dropsEnabled && pocketFloorCents === null) {
    return badRequest('With price-drop authority on, we need your pocket floor: the least you need to actually pocket per ticket.');
  }
  if (endgameAuthorized && endgameFloorCents === null) {
    return badRequest('Pre-authorizing the endgame needs your endgame floor: your real number on the morning of the event.');
  }

  try {
    const id = db.newId('lst');
    const ts = db.now();
    await db.run(
      `INSERT INTO listings (id, seller_id, event_name, event_date, venue, location, category,
         seats, qty, face_price_cents, price_cents, restrictions, status, transfer_status,
         initial_price_cents, pocket_floor_cents, endgame_floor_cents, endgame_authorized,
         price_drops_enabled, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, seller.id, b.event_name.trim(), b.event_date, b.venue.trim(), b.location.trim(),
      (b.category || 'Concerts').trim(), b.seats.trim(), qty, faceCents, priceCents,
      b.restrictions.trim(), 'draft', 'not_transferred',
      priceCents, pocketFloorCents, endgameFloorCents, endgameAuthorized ? 1 : 0,
      dropsEnabled ? 1 : 0, ts, ts
    );
    // The desk's inbound work item (Code #4: nothing is buyable yet).
    const transferId = db.newId('trn');
    await db.run(
      `INSERT INTO transfers (id, listing_id, order_id, direction, status, created_at, updated_at)
       VALUES (?,?,NULL,'inbound','requested',?,?)`,
      transferId, id, ts, ts
    );
    await transitionListing(id, 'awaiting_transfer', seller.id, 'Listing created; awaiting ticket transfer');

    return created({
      listing_id: id,
      transfer_id: transferId,
      status: 'awaiting_transfer',
      face_value: formatCents(faceCents),
      your_price: formatCents(priceCents),
      pricing: {
        price_drops_enabled: dropsEnabled,
        pocket_floor: pocketFloorCents === null ? null : formatCents(pocketFloorCents),
        endgame_floor: endgameFloorCents === null ? null : formatCents(endgameFloorCents),
        endgame_authorized: endgameAuthorized,
      },
      next_step:
        `Transfer the ${qty} ticket(s) in the Ticketmaster app to ${TRANSFER_TO} ` +
        `(the Changed Plans account). Once we've verified them in our account, your ` +
        `listing goes live — nothing can be sold before that (that's our Code, #4).`,
    });
  } catch (err) { return serverError(err); }
};
