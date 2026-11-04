'use strict';
/**
 * state.js — the order & listing state machines.
 *
 * Every status change in the system goes through transitionOrder /
 * transitionListing, which (a) enforce the whitelist below and (b) write an
 * audit_log row. If a transition isn't listed here, the code refuses it.
 * This is where Code #5 lives: there is NO path from PAID to PAYOUT_READY
 * that skips VERIFIED (transfer confirmed delivered to the buyer).
 */
const db = require('./db');

/** Order lifecycle — see ARCHITECTURE.md §5 for the diagram. */
const ORDER_TRANSITIONS = {
  reserved:         ['paid', 'cancelled'],                 // webhook success / expiry or failure
  paid:             ['transfer_pending', 'refund_pending'],
  transfer_pending: ['verified', 'refund_pending'],
  verified:         ['payout_ready', 'refund_pending'],
  payout_ready:     ['paid_out', 'refund_pending'],
  paid_out:         [],                                    // terminal (disputes after payout are handled off-order; Phase 2 policy)
  refund_pending:   ['refunded'],
  refunded:         [],                                    // terminal
  cancelled:        [],                                    // terminal
};

/** Listing lifecycle. Note the gate: -> active ONLY from awaiting_transfer,
 *  and listings-create/admin code must also check transfer_status='verified'
 *  before making that call (two locks on the same door, Code #4). */
const LISTING_TRANSITIONS = {
  draft:            ['awaiting_transfer', 'withdrawn'],
  awaiting_transfer:['active', 'withdrawn'],
  active:           ['reserved', 'withdrawn', 'expired'],
  reserved:         ['sold', 'active'],                    // back to active if the reservation dies
  sold:             ['closed'],
  closed:           [],
  withdrawn:        [],
  expired:          [],
};

function makeTransition(table, whitelist, entityLabel) {
  return async function transition(id, toStatus, actor, note) {
    const row = await db.get(`SELECT status FROM ${table} WHERE id = ?`, id);
    if (!row) throw new Error(`${entityLabel} ${id} not found`);
    const from = row.status;
    const allowed = whitelist[from] || [];
    if (!allowed.includes(toStatus)) {
      throw new Error(`Illegal ${entityLabel} transition: ${from} -> ${toStatus} (${id})`);
    }
    await db.run(`UPDATE ${table} SET status = ?, updated_at = ? WHERE id = ?`, toStatus, db.now(), id);
    await db.audit(entityLabel, id, from, toStatus, actor, note);
    return { from, to: toStatus };
  };
}

const transitionOrder = makeTransition('orders', ORDER_TRANSITIONS, 'order');
const transitionListing = makeTransition('listings', LISTING_TRANSITIONS, 'listing');

/** Two business days from a date (Code #8 dispute-answer clock). */
function plusBusinessDays(date, days) {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return d.toISOString();
}

module.exports = { ORDER_TRANSITIONS, LISTING_TRANSITIONS, transitionOrder, transitionListing, plusBusinessDays };
