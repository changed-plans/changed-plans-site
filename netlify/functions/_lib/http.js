'use strict';
/**
 * http.js — tiny helpers so every function returns the same shapes.
 * Netlify Functions style: handler(event) -> { statusCode, headers, body }.
 */

function json(statusCode, obj, extraHeaders = {}) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
    body: JSON.stringify(obj),
  };
}

function ok(obj, extraHeaders) { return json(200, obj, extraHeaders); }
function created(obj) { return json(201, obj); }
function badRequest(error) { return json(400, { error }); }
function unauthorized(error = 'Sign-in required.') { return json(401, { error }); }
function forbidden(error = 'Not allowed.') { return json(403, { error }); }
function notFound(error = 'Not found.') { return json(404, { error }); }
function conflict(error) { return json(409, { error }); }
function serverError(err) {
  console.error(err);
  return json(500, { error: 'Something went wrong on our side.' });
}

/** Parse a JSON request body; returns null (and caller 400s) on garbage. */
function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
  } catch {
    return null;
  }
}

/** Case-insensitive header lookup (Netlify lowercases, the dev server may not). */
function header(event, name) {
  const h = event.headers || {};
  return h[name] || h[name.toLowerCase()] || h[name.toUpperCase()] || null;
}

module.exports = { json, ok, created, badRequest, unauthorized, forbidden, notFound, conflict, serverError, parseBody, header };
