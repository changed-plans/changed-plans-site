'use strict';
/**
 * mailer.js — transactional email via Resend (Scott's Phase 2 pick).
 *
 *   sendMail({ to, subject, text, html? }) -> { sent, stub?, id?, error? }
 *
 * Provider: Resend REST API (POST https://api.resend.com/emails), called
 * with Node's built-in fetch — zero npm dependencies, same pattern as
 * _lib/stripe.js. The API key comes from RESEND_API_KEY and the sender
 * from EMAIL_FROM ("Changed Plans <noreply@myplanschanged.com>" by
 * default; the sending domain must be verified in Resend before real
 * sends land — that's an account step for Scott, not code).
 *
 * STUB MODE: with no RESEND_API_KEY set, sendMail logs the message and
 * returns { sent: false, stub: true } — exactly the Stripe stub pattern,
 * so local development and the smoke test never need an account.
 * sendMail never throws: a mail failure must not crash sign-in or an
 * order flow. Callers get the outcome in the return value.
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Changed Plans <noreply@myplanschanged.com>';

function isStub() { return !RESEND_API_KEY; }

async function sendMail({ to, subject, text, html }) {
  if (!to || !subject || (!text && !html)) {
    return { sent: false, error: 'to, subject, and text or html are required.' };
  }
  if (isStub()) {
    console.log(`[mail:stub] to=${to} subject="${subject}" (RESEND_API_KEY unset — not sent)`);
    return { sent: false, stub: true };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: Array.isArray(to) ? to : [to],
        subject,
        ...(text ? { text } : {}),
        ...(html ? { html } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[mail] Resend error:', res.status, data);
      return { sent: false, error: (data && data.message) || `Resend HTTP ${res.status}` };
    }
    return { sent: true, id: data.id || null };
  } catch (err) {
    console.error('[mail] send failed:', err);
    return { sent: false, error: err.message };
  }
}

module.exports = { sendMail, isStub, EMAIL_FROM };
