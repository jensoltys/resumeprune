// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Common disposable / throwaway email domains. Block these on free-sample
// generation. Not exhaustive — just covers the popular ones that abuse-bots
// reach for. Maintain over time as new ones appear in logs.

const DOMAINS = new Set([
  // Mailinator family
  'mailinator.com', 'mailinator.net', 'mailinator2.com', 'sogetthis.com',
  // 10-minute / temp mail
  '10minutemail.com', '10minutemail.net', '20minutemail.com', '30minutemail.com',
  'tempmail.com', 'tempmailaddress.com', 'temp-mail.org', 'temp-mail.io',
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.de',
  'sharklasers.com', 'grr.la', 'pokemail.net', 'spam4.me',
  // Throwaway / receive-only
  'yopmail.com', 'yopmail.fr', 'yopmail.net',
  'maildrop.cc', 'mailnesia.com', 'getairmail.com',
  'dispostable.com', 'mintemail.com', 'fakeinbox.com', 'fakemailgenerator.com',
  'trashmail.com', 'trashmail.net', 'trashmail.de', 'trashmail.io',
  'mytemp.email', 'emailondeck.com', 'mohmal.com', 'mvrht.net',
  'deadaddress.com', 'spamgourmet.com', 'getnada.com', 'nada.email',
  'inboxbear.com', 'tempr.email',
  // Plus a few patterns common in abuse logs
  'mailcatch.com', 'throwawaymail.com', 'mailforspam.com',
]);

export function isDisposableEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return DOMAINS.has(domain);
}
