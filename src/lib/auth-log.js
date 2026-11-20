// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
import { sha256Hex, clientIp } from '../helpers.js';

// One structured line per auth event, read in Workers Logs ([observability]
// in wrangler.toml). Never a raw password, token, email or IP:
// email and IP are salted sha256 hashes, uid is the opaque account id.
export async function authLog(request, env, type, { uid, email } = {}) {
  try {
    const salt = env.JWT_SECRET || '';
    const line = { evt: 'auth', type, ip_hash: (await sha256Hex(`${salt}|log-ip|${clientIp(request)}`)).slice(0, 16) };
    if (uid) line.uid = uid;
    else if (email) line.email_hash = (await sha256Hex(`${salt}|log-email|${String(email).trim().toLowerCase()}`)).slice(0, 16);
    console.log(JSON.stringify(line));
  } catch { /* logging must never break auth */ }
}
