// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Transactional email via Resend.
// Templates kept inline (small, focused). Brand styles match landing page palette.

// Set EMAIL_FROM to an address on a domain you verified in Resend. Until then this
// falls back to Resend's test sender, which only delivers to your own Resend account.
const FALLBACK_FROM = 'Resume Prune <onboarding@resend.dev>';

import { isOptedOut, makeUnsubscribeUrl } from './lib/unsubscribe.js';
import { sha256Hex } from './helpers.js';

// CAN-SPAM-required physical mailing address. Goes in every email footer.
export const LLC_POSTAL_ADDRESS = 'YOUR COMPANY NAME · YOUR BUSINESS ADDRESS';

// Marketing-tinged sends pass marketing:true so we can:
//  1) skip the send if the recipient has opted out
//  2) add a one-click unsubscribe link to the email
//  3) emit RFC 8058 List-Unsubscribe headers (still HTML-rendered as a link in clients that don't support it)
// Transactional sends (verify, password reset, account-delete confirmation) MUST go through regardless.
export async function sendEmail(env, { to, subject, html, text, from, marketing = false, unsubscribeUrl = null }) {
  if (!env.RESEND_API_KEY) {
    // No subject in the log: the sign-up subject line holds the code.
    console.error('RESEND_API_KEY not set; email skipped');
    return { skipped: true };
  }

  if (marketing) {
    const emailHash = await sha256Hex(String(to).trim().toLowerCase());
    if (await isOptedOut(env, emailHash)) {
      return { skipped: true, reason: 'opted-out' };
    }
  }

  const sender = from || env.EMAIL_FROM || FALLBACK_FROM;
  const body = { from: sender, to, subject, html, text };

  if (marketing && unsubscribeUrl) {
    // RFC 8058 one-click unsubscribe headers. Many clients (Gmail, Apple Mail)
    // surface a native Unsubscribe button when these are present.
    body.headers = {
      'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:privacy@example.com?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    console.error('Resend error', resp.status, detail);
    throw new Error(`Email send failed: ${resp.status}`);
  }
  return resp.json();
}

// Helper for templates: build the unsubscribe URL for a recipient.
export async function buildUnsubscribeUrl(env, email) {
  return makeUnsubscribeUrl(env, email);
}

// HTML escape for any user-derived strings going into a template literal.
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Normalize all-caps names to title case (only when the whole string is uppercase),
// so a cover signoff doesn't read as shouting. Leaves natural names alone.
function fixNameCase(s) {
  if (!s || typeof s !== 'string') return s;
  if (s !== s.toUpperCase()) return s;
  return s.split(/\s+/)
    .map(w => w.length === 0 ? w : w[0] + w.slice(1).toLowerCase())
    .join(' ');
}

const baseStyles = `
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
color: #1D2A22;
line-height: 1.6;
max-width: 560px;
margin: 0 auto;
padding: 24px;
`;

function shell({ heading, body, ctaUrl, ctaLabel, unsubscribeUrl }) {
  const cta = ctaUrl
    ? `<p><a href="${esc(ctaUrl)}" style="display:inline-block;background:#8A5A00;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">${esc(ctaLabel)}</a></p>`
    : '';
  const unsubLine = unsubscribeUrl
    ? `<p style="font-size:12px;color:#56655B;margin:0 0 6px"><a href="${esc(unsubscribeUrl)}" style="color:#56655B;text-decoration:underline">Unsubscribe</a> from product updates.</p>`
    : '';
  return `<!doctype html>
<html><body style="${baseStyles}">
<div style="background:#fefcf7;padding:32px;border-radius:14px;border:1px solid #e5dccd">
<h1 style="font-size:22px;color:#1F3A2B;margin:0 0 16px">${esc(heading)}</h1>
${body}
${cta}
<hr style="border:none;border-top:1px solid #e5dccd;margin:24px 0"/>
${unsubLine}
<p style="font-size:12px;color:#56655B;margin:0 0 4px">Resume Prune by YOUR COMPANY NAME &middot; Questions? support@example.com</p>
<p style="font-size:12px;color:#56655B;margin:0">${esc(LLC_POSTAL_ADDRESS)}</p>
</div></body></html>`;
}

// Code-based verification. A magic link to a young domain gets phishing-filtered
// by Gmail (accepted then silently dropped); a 6-digit code in the body lands.
export function verifyCodeTemplate({ code }) {
  return {
    subject: `Your Resume Prune code is ${code}`,
    html: shell({
      heading: 'Welcome to Resume Prune',
      body: `<p>Enter this code on the signup screen to verify your email and finish setting up your account:</p>
        <div style="font-size:34px;font-weight:bold;letter-spacing:8px;color:#1F3A2B;background:#FFF3DC;border-radius:12px;padding:18px 0;text-align:center;margin:8px 0 4px">${code}</div>
        <p style="font-size:13px;color:#56655B">This code expires in 30 minutes.</p>`,
    }),
    text: `Your Resume Prune verification code is: ${code}\n\nEnter it on the signup screen to finish setting up your account. It expires in 30 minutes.`,
  };
}

export function resetPasswordTemplate({ resetUrl }) {
  return {
    subject: 'Reset your Resume Prune password',
    html: shell({
      heading: 'Reset your password',
      body: '<p>Use the button below to set a new password. The link is valid for one hour.</p>',
      ctaUrl: resetUrl,
      ctaLabel: 'Reset password',
    }),
    text: `Reset link: ${resetUrl}`,
  };
}

// Subscription cancellation. scheduled=true → user just clicked cancel and keeps
// access until accessUntil (Stripe "cancel at period end"); scheduled=false → the
// subscription has fully ended. accessUntil is a unix-seconds timestamp.
// A guest checkout used an address that already has an account. The new
// subscription was canceled and the account wasn't touched.
export function duplicateCheckoutTemplate({ loginUrl }) {
  const said = "Someone just checked out with this email address, and it already has a Resume Prune account. We canceled the new subscription so it won't renew, and your account wasn't changed.";
  const next = 'If that was you, log in and pick your plan there, and write to support@example.com so we can refund this charge.';
  return {
    subject: "Your Resume Prune account wasn't changed",
    html: shell({
      heading: 'You already have an account',
      body: `<p>${said}</p><p>${next}</p>`,
      ctaUrl: loginUrl,
      ctaLabel: 'Log in',
    }),
    text: `${said} ${next} Log in: ${loginUrl}`,
  };
}

export function cancellationTemplate({ scheduled, accessUntil, manageUrl }) {
  const until = accessUntil
    ? new Date(accessUntil * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';
  if (scheduled) {
    return {
      subject: 'Your Resume Prune subscription is set to cancel',
      html: shell({
        heading: 'Cancellation scheduled',
        body: `<p>Your Resume Prune subscription is set to cancel${until ? ` on ${until}` : ' at the end of your current billing period'}. You keep full access until then, and you won't be charged again.</p><p>Changed your mind? You can resume anytime from your account.</p>`,
        ctaUrl: manageUrl,
        ctaLabel: 'Open Resume Prune',
      }),
      text: `Your Resume Prune subscription is set to cancel${until ? ` on ${until}` : ' at the end of your billing period'}. You keep access until then and won't be charged again. ${manageUrl}`,
    };
  }
  return {
    subject: 'Your Resume Prune subscription has been canceled',
    html: shell({
      heading: 'Subscription canceled',
      body: `<p>Your Resume Prune subscription has been canceled and your Pro access has ended. Your account and saved resume are still here whenever you want to come back.</p>`,
      ctaUrl: manageUrl,
      ctaLabel: 'Open Resume Prune',
    }),
    text: `Your Resume Prune subscription has been canceled and Pro access has ended. ${manageUrl}`,
  };
}

// Sent when someone tries to sign up with an email that already has an account.
// Lets the legitimate "forgot I had an account" user recover, while the API
// response stays generic so account-enumeration attacks still can't tell.
// Sent right after a successful purchase. Without it a paying customer
// gets nothing from Resume Prune. That is worst on
// guest checkout, where the post-payment redirect to /claim is the only route to
// an account — close that tab and you have paid with no way back that you'd
// think to look for. `claimUrl` is only passed when the account is still
// unclaimed; the claim endpoint refuses once a real password is set, so an old
// link in an inbox is inert.
// PLAN_BLURB describes what each plan actually gets, per lib/usage.js.
const PLAN_BLURB = {
  pro: { name: 'Pro', allowance: '40 tweaks a month' },
  sprint: { name: 'Sprint', allowance: '20 tweaks a week' },
};

export function purchaseWelcomeTemplate({ plan, claimUrl, dashboardUrl }) {
  const p = PLAN_BLURB[plan] || { name: 'your plan', allowance: 'your tweaks' };
  const needsClaim = !!claimUrl;
  const body = needsClaim
    ? `<p>Your payment went through and <strong>${esc(p.name)}</strong> is active. That is ${esc(p.allowance)}.</p>
       <p><strong>One thing left:</strong> set a password so you can get back in later. It takes about ten seconds.</p>
       <p><a href="${esc(claimUrl)}">${esc(claimUrl)}</a></p>
       <p>Keep this email until you have done it. Without a password there is no way back into your account.</p>`
    : `<p>Your payment went through and <strong>${esc(p.name)}</strong> is active on your account. That is ${esc(p.allowance)}.</p>
       <p>Paste in a resume and a job description, and prune away.</p>`;
  return {
    subject: `You're on Resume Prune ${p.name}`,
    html: shell({
      heading: needsClaim ? 'Payment received. One quick step.' : `You're on ${p.name}`,
      body,
      ctaUrl: needsClaim ? claimUrl : dashboardUrl,
      ctaLabel: needsClaim ? 'Set my password' : 'Open Resume Prune',
    }),
    text: needsClaim
      ? `Your payment went through and ${p.name} is active (${p.allowance}).\n\nOne thing left: set a password so you can get back in.\n${claimUrl}\n\nKeep this email until you have. Without a password there is no way back into your account.`
      : `Your payment went through and ${p.name} is active (${p.allowance}).\n\nOpen Resume Prune: ${dashboardUrl}`,
  };
}

export function accountExistsTemplate({ loginUrl, resetUrl }) {
  return {
    subject: 'You already have a Resume Prune account',
    html: shell({
      heading: 'You already have an account',
      body: `<p>Someone (probably you) just tried to sign up at Resume Prune with this email. You already have an account here, so we did not create a new one.</p>
             <p><strong>Sign in:</strong> <a href="${esc(loginUrl)}">${esc(loginUrl)}</a></p>
             <p><strong>Forgot your password?</strong> <a href="${esc(resetUrl)}">${esc(resetUrl)}</a></p>
             <p>If this was not you, no action is needed. Your account was not touched.</p>`,
      ctaUrl: loginUrl,
      ctaLabel: 'Sign in',
    }),
    text: `You already have a Resume Prune account.\nSign in: ${loginUrl}\nReset password: ${resetUrl}\n\nIf this was not you, no action is needed.`,
  };
}

// Server-side renderer: takes structured resume JSON and produces email-friendly HTML.
// Keeps inline styles (most email clients ignore <style>).
function renderResumeEmail(r) {
  if (!r) return '';
  const contact = [r.contact?.email, r.contact?.phone, r.contact?.location].filter(Boolean).map(esc).join(' &middot; ');
  const links = (r.contact?.links || []).filter(Boolean).map(esc).join(' &middot; ');
  const skills = (r.skills || []).map(s =>
    `<p style="margin:4px 0;font-size:14px"><strong>${esc(s.category)}:</strong> ${esc(s.items)}</p>`
  ).join('');
  const experience = (r.experience || []).map(j => `
    <div style="margin-bottom:14px">
      <p style="margin:0;font-weight:700">${esc(j.company)}${j.location ? ', ' + esc(j.location) : ''} <span style="font-weight:600;color:#444">${esc(j.dates || '')}</span></p>
      <p style="margin:0;font-style:italic;color:#444">${esc(j.role || '')}</p>
      <ul style="margin:6px 0 0 18px;padding:0">
        ${(j.bullets || []).map(b => `<li style="margin-bottom:4px">${esc(b)}</li>`).join('')}
      </ul>
    </div>
  `).join('');
  const education = (r.education || []).map(e =>
    `<p style="margin:2px 0;font-size:14px">${esc(e.degree)}${e.school ? ', ' + esc(e.school) : ''}${e.year ? ' (' + esc(e.year) + ')' : ''}${e.detail ? ' &middot; ' + esc(e.detail) : ''}</p>`
  ).join('');
  const projects = (r.projects || []).map(p =>
    `<p style="margin:6px 0;font-size:14px"><strong>${esc(p.name)}</strong>${p.tech ? ' &middot; <span style="color:#444">' + esc(p.tech) + '</span>' : ''}<br>${esc(p.summary || '')}</p>`
  ).join('');

  return `
    <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#000;background:white;padding:20px;border:1px solid #e5dccd;border-radius:8px;font-size:14px">
      <h2 style="font-size:20px;margin:0 0 4px;color:#000">${esc(r.name || '')}</h2>
      ${r.title_line ? `<p style="margin:0 0 4px;font-weight:600;color:#333">${esc(r.title_line)}</p>` : ''}
      <p style="margin:0 0 4px;font-size:13px;color:#333">${contact}</p>
      ${links ? `<p style="margin:0 0 12px;font-size:13px;color:#333">${links}</p>` : '<div style="margin-bottom:12px"></div>'}
      <hr style="border:none;border-top:1px solid #888;margin:8px 0 14px"/>
      ${r.summary ? `<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid #555;padding-bottom:3px;margin:14px 0 6px;color:#000">Summary</h3><p style="margin:0 0 12px">${esc(r.summary)}</p>` : ''}
      ${skills ? `<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid #555;padding-bottom:3px;margin:14px 0 6px;color:#000">Skills</h3>${skills}` : ''}
      ${experience ? `<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid #555;padding-bottom:3px;margin:14px 0 6px;color:#000">Experience</h3>${experience}` : ''}
      ${education ? `<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid #555;padding-bottom:3px;margin:14px 0 6px;color:#000">Education</h3>${education}` : ''}
      ${projects ? `<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid #555;padding-bottom:3px;margin:14px 0 6px;color:#000">Projects</h3>${projects}` : ''}
    </div>
  `;
}

function renderCoverEmail(c) {
  if (!c) return '';
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const contact = [c.contact?.email, c.contact?.phone, c.contact?.location].filter(Boolean).map(esc).join(' &middot; ');
  const paragraphs = (c.paragraphs || []).map(p => `<p style="margin:0 0 12px">${esc(p)}</p>`).join('');
  const displayName = fixNameCase(c.name || '');
  return `
    <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#000;background:white;padding:20px;border:1px solid #e5dccd;border-radius:8px;font-size:14px;line-height:1.55">
      <p style="margin:0 0 2px;font-weight:700;font-size:16px">${esc(displayName)}</p>
      <p style="margin:0 0 16px;font-size:13px;color:#333">${contact}</p>
      <p style="margin:0 0 14px;color:#444">${esc(today)}</p>
      <p style="margin:0 0 12px;font-weight:600">${esc(c.greeting || 'Dear Hiring Manager,')}</p>
      ${paragraphs}
      <p style="margin:14px 0 0;font-weight:600">${esc(c.signoff || 'Sincerely,')}<br>${esc(displayName)}</p>
    </div>
  `;
}

// The results are transactional (the person asked for them), so they're always sent.
// Only the closing plans pitch is promotional: promo:false drops it, the plans
// button and the unsubscribe line, for someone who opted out of product mail.
export function freeSampleTemplate({ resumeJson, coverJson, viewerUrl, signupUrl, unsubscribeUrl, promo = true }) {
  const viewerCta = viewerUrl
    ? `<p style="margin:0 0 18px"><a href="${esc(viewerUrl)}" style="display:inline-block;background:#8A5A00;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Open your sample to print or save</a></p>
       <p class="muted" style="font-size:12px;color:#56655B;margin:0 0 16px">This private link is yours alone. Don't share it. Available for 30 days.</p>`
    : '';
  return {
    subject: 'Your pruned resume + cover letter',
    html: shell({
      heading: 'Here is your sample',
      body: `
        <p>Below is your pruned resume and matching cover letter. <strong>Always review before you send.</strong></p>
        ${viewerCta}
        <h2 style="font-size:18px;color:#1F3A2B;margin-top:24px">Resume</h2>
        ${renderResumeEmail(resumeJson)}
        <h2 style="font-size:18px;color:#1F3A2B;margin-top:24px">Cover Letter</h2>
        ${renderCoverEmail(coverJson)}
        ${promo ? '<p style="margin-top:24px">Want to do this for every job application? Sprint is $9/week for 20 tweaks (great for active hunting). Pro is $14/month for 40 tweaks.</p>' : ''}
      `,
      ctaUrl: promo ? signupUrl : null,
      ctaLabel: 'See plans',
      unsubscribeUrl: promo ? unsubscribeUrl : null,
    }),
    text: `Here is your sample.${viewerUrl ? ' Open your private viewer: ' + viewerUrl : ''}${promo ? '\nSign up: ' + signupUrl : ''}${promo && unsubscribeUrl ? '\nUnsubscribe: ' + unsubscribeUrl : ''}`,
  };
}
