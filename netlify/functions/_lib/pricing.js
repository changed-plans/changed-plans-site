'use strict';
/**
 * pricing.js — the price-drop engine, ported from the concierge playbook
 * (hidden_files/price_engine.py + listings.yaml) into the working site's
 * data model.
 *
 * The playbook rules being ported:
 *  - Staged drops on a clock: 10% off the original ask at T-48h, 20% at
 *    T-24h, the floor at T-6h (the Scott-approved default ladder,
 *    2026-10-18). Percent steps are computed from initial_price_cents —
 *    the seller's ask when the listing activated — never compounded.
 *  - A price NEVER drops below the applicable floor, and never rises:
 *    the engine only lowers, and only for listings whose seller granted
 *    drop authority (price_drops_enabled) at intake.
 *
 * The floor is the THREE-NUMBER INTAKE (rewritten 2026-10-31 after the
 * Kat Vierzba SeatGeek lesson — a $300 listing-price floor was not a
 * pocket floor, and she netted ~$202.50/ticket elsewhere):
 *  1. pocket_floor_cents  — the least the seller must NET per ticket.
 *     Changed Plans pays sellers 100% of the listing price, so the price
 *     floor on this channel IS the pocket floor. This is the standard
 *     floor at all times.
 *  2. endgame_floor_cents — the game-morning floor. Inside the endgame
 *     window (default: final 12 hours before the event) it REPLACES the
 *     pocket floor — floors decay as unsold risk rises.
 *  3. endgame_authorized  — the seller's pre-authorization to use the
 *     endgame floor without a consult round-trip. Without it, the engine
 *     may NOT cross below the pocket floor even in the endgame window:
 *     the endgame number only takes effect with the pre-authorization.
 *     (In a self-serve system this pre-authorized drop IS the "accept at
 *     or above the endgame floor on the spot" rule from the intake.)
 *
 * Only ACTIVE listings are repriced (active implies transfer-verified —
 * Code #4), and a listing with no pocket floor on file is never touched:
 * no floor settled at intake, no automatic drops, ever.
 *
 * Every change writes an audit_log row (entity 'listing', note carries
 * the old/new price, the ladder step, and the floor that bounded it).
 *
 * Entry points: netlify/functions/admin-price-run.js (POST
 * /api/admin/run-pricing, admin-gated, manual/local) and
 * netlify/functions/scheduled-pricing.js (every 15 minutes in
 * production — the same cadence the concierge engine ran on).
 */
const db = require('./db');
const { formatCents } = require('./money');

/** The default ladder: [hours before event, % off the initial ask].
 *  The final step (pctOff = null) means "go to the applicable floor". */
const LADDER = [
  { hoursBefore: 48, pctOff: 10 },
  { hoursBefore: 24, pctOff: 20 },
  { hoursBefore: 6, pctOff: null },
];

/** Is `now` inside this listing's endgame window? */
function inEndgameWindow(listing, nowMs) {
  const eventMs = Date.parse(listing.event_date);
  if (!Number.isFinite(eventMs)) return false;
  const windowMs = (listing.endgame_window_hours || 12) * 3600 * 1000;
  return nowMs >= eventMs - windowMs && nowMs < eventMs;
}

/**
 * The floor the engine may not cross for this listing right now.
 * Endgame floor applies only inside the window AND with pre-authorization.
 */
function applicableFloor(listing, nowMs) {
  if (
    listing.endgame_authorized &&
    listing.endgame_floor_cents != null &&
    inEndgameWindow(listing, nowMs)
  ) {
    return { floorCents: listing.endgame_floor_cents, kind: 'endgame' };
  }
  return { floorCents: listing.pocket_floor_cents, kind: 'pocket' };
}

/**
 * Pure pricing decision for one listing at one moment.
 * Returns { targetCents, step, floorCents, floorKind } or null when the
 * engine has no business touching this listing (no authority, no floor,
 * event already started, or no drop due yet).
 */
function computeTargetPrice(listing, nowMs = Date.now()) {
  if (!listing.price_drops_enabled) return null;
  if (listing.pocket_floor_cents == null) return null;
  const eventMs = Date.parse(listing.event_date);
  if (!Number.isFinite(eventMs) || nowMs >= eventMs) return null;

  const anchor = listing.initial_price_cents != null ? listing.initial_price_cents : listing.price_cents;
  const { floorCents, kind } = applicableFloor(listing, nowMs);
  const hoursLeft = (eventMs - nowMs) / 3600000;

  // Deepest due step wins (steps are evaluated from the event backwards).
  let step = null;
  for (const s of LADDER) {
    if (hoursLeft <= s.hoursBefore) step = s;
  }
  if (!step) return null;

  const rawTarget = step.pctOff === null
    ? floorCents
    : Math.round(anchor * (100 - step.pctOff) / 100);
  // The floor binds from below; the face-value cap can never be crossed
  // by a drop, but clamp defensively anyway (Code #1 is absolute).
  const target = Math.min(Math.max(rawTarget, floorCents), listing.face_price_cents);
  return { targetCents: target, step, floorCents, floorKind: kind };
}

/**
 * Apply due drops to every eligible active listing.
 * Returns { checked, changed: [{ listing_id, from_cents, to_cents, ... }] }.
 */
async function runPriceEngine(actor = 'price-engine') {
  const nowMs = Date.now();
  const rows = await db.all(
    "SELECT * FROM listings WHERE status = 'active' AND transfer_status = 'verified' AND price_drops_enabled = 1"
  );
  const changed = [];
  for (const listing of rows) {
    const decision = computeTargetPrice(listing, nowMs);
    if (!decision) continue;
    if (decision.targetCents >= listing.price_cents) continue; // drops only, never a raise
    await db.run('UPDATE listings SET price_cents = ?, updated_at = ? WHERE id = ?',
      decision.targetCents, db.now(), listing.id);
    const stepLabel = decision.step.pctOff === null ? 'floor step (T-6h)' : `${decision.step.pctOff}% step (T-${decision.step.hoursBefore}h)`;
    await db.audit('listing', listing.id, listing.status, listing.status, actor,
      `Price drop ${formatCents(listing.price_cents)} -> ${formatCents(decision.targetCents)} ` +
      `(${stepLabel}; ${decision.floorKind} floor ${formatCents(decision.floorCents)} binds)`);
    changed.push({
      listing_id: listing.id,
      from_cents: listing.price_cents,
      to_cents: decision.targetCents,
      floor_kind: decision.floorKind,
    });
  }
  return { checked: rows.length, changed };
}

module.exports = { LADDER, inEndgameWindow, applicableFloor, computeTargetPrice, runPriceEngine };
