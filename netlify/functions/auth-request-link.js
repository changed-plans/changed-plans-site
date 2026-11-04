'use strict';
/** POST /api/auth/request-link  { email, display_name? }
 *  Sends (Phase 2) or logs (Phase 1) a single-use sign-in link.
 *  In local mode the link is included in the response for testing. */
const { ok, badRequest, parseBody, serverError } = require('./_lib/http');
const auth = require('./_lib/auth');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('POST only.');
  const body = parseBody(event);
  if (!body || !body.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) {
    return badRequest('A valid email is required.');
  }
  try {
    const user = await auth.upsertUserByEmail(body.email, body.display_name);
    const token = await auth.createMagicToken(user.id);
    const devLink = auth.deliverMagicLink(user.email, token);
    // Always answer the same way in production so we don't leak account existence.
    return ok({ sent: true, ...(devLink ? { dev_link: devLink } : {}) });
  } catch (err) { return serverError(err); }
};
