'use strict';
/**
 * /api/listings — ONE function for both methods (Phase 2 routing fix).
 *
 * Netlify redirects cannot branch on HTTP method, so the Phase 1 split
 * (POST -> listings-create, GET -> listings-list, same URL) cannot be
 * expressed in production routing. This module is the single redirect
 * target for /api/listings and dispatches on event.httpMethod to the
 * original handlers, which keep their own files and logic.
 */
const create = require('./listings-create');
const list = require('./listings-list');
const { badRequest } = require('./_lib/http');

exports.handler = async (event) => {
  if (event.httpMethod === 'POST') return create.handler(event);
  if (event.httpMethod === 'GET') return list.handler(event);
  return badRequest('GET or POST only.');
};
