'use strict';
/**
 * GET /api/auth/me — who am I? Returns the signed-in user (public shape,
 * including role) or { user: null }. The admin desk uses it to show whose
 * name admin actions will carry; every page can use it for sign-in state.
 */
const { ok, serverError } = require('./_lib/http');
const auth = require('./_lib/auth');

exports.handler = async (event) => {
  try {
    return ok({ user: auth.publicUser(await auth.userFromEvent(event)) });
  } catch (err) { return serverError(err); }
};
