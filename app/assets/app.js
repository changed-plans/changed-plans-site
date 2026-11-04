'use strict';
/* Shared helpers for the app pages: API calls + the magic-link sign-in box. */

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function money(cents) { return '$' + (cents / 100).toFixed(2); }

function qs(name) { return new URLSearchParams(location.search).get(name); }

function el(id) { return document.getElementById(id); }

function showError(node, err) {
  node.innerHTML = `<p class="err">${err.message || err}</p>`;
}

/** Wire the sign-in form (present in the header of every app page). */
function wireSignin() {
  const form = el('signin-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = el('signin-out');
    out.textContent = 'Sending your link…';
    try {
      const data = await api('/api/auth/request-link', {
        method: 'POST',
        body: JSON.stringify({ email: el('signin-email').value }),
      });
      out.innerHTML = data.dev_link
        ? `Local dev link (in production this is emailed): <a href="${data.dev_link}">sign in</a>`
        : 'Check your email for a sign-in link.';
    } catch (err) { showError(out, err); }
  });
}

document.addEventListener('DOMContentLoaded', wireSignin);
