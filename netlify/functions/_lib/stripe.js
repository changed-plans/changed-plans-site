'use strict';
/**
 * stripe.js — Stripe access with ZERO npm dependencies.
 *
 * Uses Stripe's REST API directly (form-encoded POSTs, Bearer key) via Node's
 * built-in fetch. When the official `stripe` SDK is preferred in Phase 2, only
 * this file changes — callers use createCheckoutSession / createRefund /
 * constructEvent below.
 *
 * MODES:
 *  - Real: STRIPE_SECRET_KEY set (a TEST key, sk_test_…, while developing).
 *          Scott provides keys through secure channels — never via this repo.
 *  - Stub: no key set. createCheckoutSession returns a local stub URL so the
 *          full order flow can be exercised account-free, and the smoke test
 *          posts a fabricated webhook event. Stub mode REFUSES to run when
 *          APP_ENV=production.
 *
 * The hold model (ARCHITECTURE.md §6): we are merchant of record on a single
 * Stripe account. Checkout collects into the LLC's balance; "held" is a ledger
 * state in our orders table, released by admin action — not a Stripe construct.
 */
const crypto = require('node:crypto');
const { IS_LOCAL } = require('./auth');

const SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:8888';

const stubMode = !SECRET_KEY;
if (stubMode && !IS_LOCAL) {
  throw new Error('STRIPE_SECRET_KEY is required outside local mode.');
}
if (stubMode) console.warn('[stripe] STUB MODE — no STRIPE_SECRET_KEY; checkout is simulated locally.');
if (SECRET_KEY && !SECRET_KEY.startsWith('sk_test_') && IS_LOCAL) {
  console.warn('[stripe] WARNING: a non-test key is set while APP_ENV=local. Prefer sk_test_ keys in development.');
}

function formEncode(obj, prefix, out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) formEncode(v, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) => {
      if (item && typeof item === 'object') formEncode(item, `${key}[${i}]`, out);
      else out[`${key}[${i}]`] = String(item);
    });
    else out[key] = String(v);
  }
  return out;
}

async function stripePost(pathname, params) {
  const body = new URLSearchParams(formEncode(params)).toString();
  const res = await fetch(`https://api.stripe.com/v1${pathname}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe ${pathname} failed: ${data.error ? data.error.message : res.status}`);
  return data;
}

/**
 * Create a Checkout Session for an order. The full price (incl. fee) is one
 * line item — the buyer already saw the complete breakdown on our page
 * (Code #2), and Checkout re-displays the total before payment.
 */
async function createCheckoutSession({ order, listing }) {
  if (stubMode) {
    const id = `cs_stub_${order.id}`;
    return { id, url: `${BASE_URL}/checkout.html?stub=1&order=${order.id}&session=${id}` };
  }
  const session = await stripePost('/checkout/sessions', {
    mode: 'payment',
    success_url: `${BASE_URL}/order.html?id=${order.id}&paid=1`,
    cancel_url: `${BASE_URL}/checkout.html?id=${listing.id}&cancelled=1`,
    customer_email: order.buyer_email,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: order.total_cents,
        product_data: {
          name: `${listing.event_name} — ${listing.qty} ticket(s)`,
          description: `${listing.venue} · ${listing.seats} · Face value $${(listing.face_price_cents / 100).toFixed(2)}/ticket`,
        },
      },
    }],
    metadata: { order_id: order.id, listing_id: listing.id },
    payment_intent_data: { metadata: { order_id: order.id } },
  });
  return { id: session.id, url: session.url };
}

/** Full refund to the buyer (Code #6/#7: made whole, fee included). */
async function createRefund(paymentIntentId) {
  if (stubMode) return { id: `re_stub_${paymentIntentId}`, status: 'succeeded' };
  return stripePost('/refunds', { payment_intent: paymentIntentId });
}

/**
 * Verify a webhook signature (per Stripe's scheme: HMAC-SHA256 of
 * `${timestamp}.${rawBody}`), tolerating 5 minutes of clock skew.
 * If STRIPE_WEBHOOK_SECRET is unset we are in local dev: accept the event
 * but shout about it. Production must set the secret (cutover checklist).
 */
function constructEvent(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET) {
    console.warn('[stripe] WARNING: STRIPE_WEBHOOK_SECRET unset — accepting UNSIGNED webhook (local dev only).');
    return JSON.parse(rawBody);
  }
  const parts = Object.fromEntries(String(signatureHeader || '').split(',').map(p => p.split('=', 2)));
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
    .update(`${parts.t}.${rawBody}`).digest('hex');
  const given = parts.v1 || '';
  if (!given || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    throw new Error('Webhook signature verification failed.');
  }
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) {
    throw new Error('Webhook timestamp outside tolerance.');
  }
  return JSON.parse(rawBody);
}

module.exports = { createCheckoutSession, createRefund, constructEvent, stubMode };
