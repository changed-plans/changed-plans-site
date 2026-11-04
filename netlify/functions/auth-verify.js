'use strict';
/** GET /api/auth/verify?token=…
 *  Consumes a magic token and sets the session cookie, then redirects into
 *  the app. This is the link a fan clicks in their email. */
const auth = require('./_lib/auth');

exports.handler = async (event) => {
  const token = (event.queryStringParameters || {}).token;
  const user = token ? await auth.consumeMagicToken(token) : null;
  const base = process.env.APP_BASE_URL || 'http://localhost:8888';
  if (!user) {
    return {
      statusCode: 302,
      headers: { location: `${base}/index.html?signin=expired` },
      body: '',
    };
  }
  return {
    statusCode: 302,
    headers: {
      location: `${base}/index.html?signin=ok`,
      'set-cookie': auth.sessionCookie(user.id),
    },
    body: '',
  };
};
