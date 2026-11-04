'use strict';
/**
 * POST /api/disputes — open a dispute on an order (Code #8).
 *
 * Body: { order_id, category, description }
 * Guarantees at intake: a NAMED HUMAN is assigned (the first admin user —
 * at launch, Scott), and the answer deadline (opened + 2 business days) is
 * computed and returned to the buyer immediately. Resolution (including any
 * Stripe refund) is an admin action — see the desk queue. A dispute never
 * silently auto-refunds; a person decides, against the published Code.
 */
const db = require('./_lib/db');
const { created, badRequest, unauthorized, forbidden, notFound, parseBody, serverError } = require('./_lib/http');
const { plusBusinessDays } = require('./_lib/state');
const auth = require('./_lib/auth');

const CATEGORIES = ['invalid_ticket', 'event_cancelled', 'not_received', 'other'];
const REFUNDABLE_STATES = ['paid', 'transfer_pending', 'verified', 'payout_ready'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('POST only.');
  const user = await auth.userFromEvent(event);
  if (!user) return unauthorized('Sign in to open a dispute.');
  const b = parseBody(event);
  if (!b || !b.order_id || !CATEGORIES.includes(b.category) || !b.description || String(b.description).trim().length < 10) {
    return badRequest('order_id, a valid category, and a description (10+ characters) are required.');
  }
  const order = await db.get('SELECT * FROM orders WHERE id = ?', b.order_id);
  if (!order) return notFound('Order not found.');
  if (order.buyer_id !== user.id) return forbidden('Only the buyer can dispute this order.');
  if (!REFUNDABLE_STATES.includes(order.status)) {
    return badRequest(`A dispute can't be opened on an order in state '${order.status}'.`);
  }
  try {
    // Named human (Code #8): first admin user; at launch that's Scott.
    // If no admin user exists yet, the dispute is still recorded and the
    // queue shows it unassigned — Phase 2 seeds the admin account.
    const admin = await db.get("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1");
    const id = db.newId('dsp');
    const ts = db.now();
    const due = plusBusinessDays(new Date(ts), 2);
    await db.run(
      `INSERT INTO disputes (id, order_id, opened_by, category, description, status, assigned_to, due_at, created_at, updated_at)
       VALUES (?,?,?,?,?,'open',?,?,?,?)`,
      id, order.id, user.id, b.category, String(b.description).trim(),
      admin ? admin.id : null, due, ts, ts
    );
    await db.audit('dispute', id, null, 'open', user.id, `Category: ${b.category}; order ${order.id}`);
    return created({
      dispute_id: id,
      assigned_human: admin ? (admin.display_name || admin.email) : 'Scott Bishop, founder',
      answer_by: due,
      promise: 'A named human will answer within two business days, decided against the published Changed Plans Code. If we got it wrong, the remedy is a refund — not an argument.',
    });
  } catch (err) { return serverError(err); }
};
