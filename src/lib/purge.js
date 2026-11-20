// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Daily retention purge, run by the cron in wrangler.toml ([triggers]).
// What it deletes is exactly what Privacy §6 promises:
//   - free-sample output (result_json) 30 days after it was made
//   - free-sample rows after 35 days, once they no longer count toward the
//     30-day free-sample limits
//   - rate-limit rows past every window (the longest window is one day)
//   - verify codes and reset tokens 7 days after they expired
//   - daily email-ceiling counters once their day is over (they hold no
//     address or IP, just a counter name and a date)
export async function purgeExpired(env, now = Math.floor(Date.now() / 1000)) {
  const day = 86400;
  const results = await env.DB.batch([
    env.DB.prepare('UPDATE free_samples SET result_json = NULL WHERE result_json IS NOT NULL AND used_at < ?').bind(now - 30 * day),
    env.DB.prepare('DELETE FROM free_samples WHERE used_at < ?').bind(now - 35 * day),
    env.DB.prepare('DELETE FROM rate_limits WHERE ts < ?').bind(now - 2 * day),
    env.DB.prepare('DELETE FROM email_tokens WHERE expires_at < ?').bind(now - 7 * day),
    env.DB.prepare('DELETE FROM daily_counts WHERE day < ?').bind(new Date((now - day) * 1000).toISOString().slice(0, 10)),
  ]);
  const n = results.map(r => (r && r.meta && r.meta.changes) || 0);
  console.log(JSON.stringify({ evt: 'purge', samples_cleared: n[0], samples_deleted: n[1], rate_limits: n[2], email_tokens: n[3], daily_counts: n[4] }));
  return n;
}
