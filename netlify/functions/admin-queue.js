'use strict';
/**
 * GET /api/admin/queue — the transfer desk's three work lists + disputes.
 * Admin-gated: signed-in user with role='admin' (Phase 2; see _lib/auth.js).
 * Every list is exactly the work a named human owes:
 *   inbound  — tickets sellers sent us, awaiting verification (Code #4)
 *   outbound — paid orders whose buyer is waiting for the ticket
 *   payouts  — verified orders whose seller is waiting for money (Code #5)
 *   disputes — open disputes, soonest deadline first (Code #8)
 */
const db = require('./_lib/db');
const { ok, forbidden, serverError } = require('./_lib/http');
const { formatCents } = require('./_lib/money');
const auth = require('./_lib/auth');

exports.handler = async (event) => {
  const admin = await auth.adminUser(event);
  if (!admin) return forbidden('Admin only.');
  try {
    const inbound = (await db.all(
      `SELECT t.id AS transfer_id, t.status AS transfer_status_step, l.*
         FROM transfers t JOIN listings l ON l.id = t.listing_id
        WHERE t.direction = 'inbound' AND t.status != 'verified'
        ORDER BY t.created_at ASC`
    )).map((r) => ({
      transfer_id: r.transfer_id, step: r.transfer_status_step,
      listing_id: r.id, event_name: r.event_name, event_date: r.event_date,
      seats: r.seats, qty: r.qty, face_value: formatCents(r.face_price_cents),
      seller_id: r.seller_id,
    }));

    const outbound = (await db.all(
      `SELECT t.id AS transfer_id, t.status AS step, o.id AS order_id, o.total_cents,
              l.event_name, l.seats, bu.email AS buyer_email
         FROM transfers t
         JOIN orders o ON o.id = t.order_id
         JOIN listings l ON l.id = o.listing_id
         JOIN users bu ON bu.id = o.buyer_id
        WHERE t.direction = 'outbound' AND t.status != 'confirmed'
        ORDER BY t.created_at ASC`
    )).map((r) => ({
      transfer_id: r.transfer_id, step: r.step, order_id: r.order_id,
      event_name: r.event_name, seats: r.seats, buyer_email: r.buyer_email,
      held_amount: formatCents(r.total_cents),
    }));

    const payouts = (await db.all(
      `SELECT p.*, o.id AS order_id, su.email AS seller_email, l.event_name
         FROM payouts p
         JOIN orders o ON o.id = p.order_id
         JOIN users su ON su.id = p.seller_id
         JOIN listings l ON l.id = o.listing_id
        WHERE p.status = 'pending'
        ORDER BY p.created_at ASC`
    )).map((r) => ({
      payout_id: r.id, order_id: r.order_id, seller_email: r.seller_email,
      event_name: r.event_name, amount: formatCents(r.amount_cents), method: r.method,
    }));

    const disputes = (await db.all(
      `SELECT d.*, o.status AS order_status FROM disputes d
         JOIN orders o ON o.id = d.order_id
        WHERE d.status = 'open' ORDER BY d.due_at ASC`
    )).map((r) => ({
      dispute_id: r.id, order_id: r.order_id, order_status: r.order_status,
      category: r.category, description: r.description,
      assigned_to: r.assigned_to, answer_by: r.due_at,
    }));

    return ok({ admin: auth.publicUser(admin), inbound, outbound, payouts, disputes });
  } catch (err) { return serverError(err); }
};
