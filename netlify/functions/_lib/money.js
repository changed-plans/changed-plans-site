'use strict';
/**
 * money.js — every pricing rule in the business, in one place.
 *
 * Non-negotiables (Scott, and the Changed Plans Code #1/#2):
 *  - A listing price may NEVER exceed face value.
 *  - Buyer fee is 14% of the listing price total.
 *  - The buyer's FIRST completed transaction has the fee waived.
 *  - The seller receives 100% of the listing price.
 * All amounts are integer cents. No floats ever touch money here.
 */

const BUYER_FEE_BPS = 1400; // 14.00% expressed in basis points

/** Parse a user-entered dollar string ("355", "355.50") into integer cents. */
function dollarsToCents(input) {
  if (typeof input === 'number') input = String(input);
  if (typeof input !== 'string') return null;
  const m = input.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const cents = parseInt(m[1], 10) * 100 + parseInt((m[2] || '0').padEnd(2, '0'), 10);
  return Number.isSafeInteger(cents) ? cents : null;
}

function formatCents(cents) {
  return '$' + (cents / 100).toFixed(2);
}

/**
 * Validate a proposed listing price against face value (Code #1).
 * Returns { ok: true } or { ok: false, error } — callers must refuse on !ok.
 */
function validatePriceVsFace(priceCents, faceCents) {
  if (!Number.isInteger(priceCents) || !Number.isInteger(faceCents)) {
    return { ok: false, error: 'Prices must be whole cents.' };
  }
  if (faceCents <= 0) return { ok: false, error: 'Face value must be greater than zero.' };
  if (priceCents <= 0) return { ok: false, error: 'Price must be greater than zero.' };
  if (priceCents > faceCents) {
    return {
      ok: false,
      error: `Price ${formatCents(priceCents)} exceeds face value ${formatCents(faceCents)}. ` +
             'Face value or less, never above.',
    };
  }
  return { ok: true };
}

/**
 * Quote an order. `firstTransaction` = buyer's first completed purchase,
 * which waives the fee entirely (the locked line: "your first transaction is free").
 * Returns the full breakdown so the buyer sees the whole price up front (Code #2).
 */
function quoteOrder({ priceCentsPerTicket, qty, firstTransaction }) {
  const priceTotal = priceCentsPerTicket * qty;
  const fee = firstTransaction ? 0 : Math.round((priceTotal * BUYER_FEE_BPS) / 10000);
  return {
    qty,
    pricePerTicketCents: priceCentsPerTicket,
    priceTotalCents: priceTotal,
    buyerFeeCents: fee,
    feeWaived: !!firstTransaction,
    totalCents: priceTotal + fee,
    // The seller's payout is always 100% of the listing price total.
    sellerPayoutCents: priceTotal,
  };
}

module.exports = { BUYER_FEE_BPS, dollarsToCents, formatCents, validatePriceVsFace, quoteOrder };
