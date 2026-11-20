// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Tiny fetch wrappers used by signup/login/reset pages.
// A dropped connection returns {ok:false, error} with plain copy, so every
// page that prints r.error shows something a person can act on.
const NET_ERR = "Can't reach the server. Check your connection and try again.";
async function postJson(url, body) {
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: NET_ERR };
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok && !data.error) data.error = r.status >= 500 ? 'Something went wrong on our end. Try again in a minute.' : 'Request failed.';
  return { ok: r.ok, ...data };
}
window.AuthClient = {
  async signup({ email, password, newsletter }) {
    return postJson('/api/auth/signup', { email, password, newsletter });
  },
  async login({ email, password }) {
    return postJson('/api/auth/login', { email, password });
  },
  async logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  },
  async resetRequest(email) {
    return postJson('/api/auth/reset-request', { email });
  },
  async resetConfirm(token, password) {
    return postJson('/api/auth/reset-confirm', { token, password });
  },
};
