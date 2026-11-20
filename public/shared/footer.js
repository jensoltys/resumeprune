// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// footer.js - injects the site footer. Keep the credit and source link: the AGPL
// license asks you to offer your users the source of the copy you run.
(function() {
  const html = `
    <footer>
      <p>Built on <a href="https://github.com/jensoltys/resumeprune" target="_blank" rel="noopener noreferrer">Resume Prune</a> by
      <a href="https://jenbuiltit.com" target="_blank" rel="noopener noreferrer"><strong>Jen Built It</strong></a>.</p>
      <p style="margin-top:0.5rem"><a href="/guide">Guide</a> &middot; <a href="/legal/privacy">Privacy</a> &middot; <a href="/legal/terms">Terms</a> &middot; <a href="/legal/accessibility">Accessibility</a> &middot; <a href="/legal/do-not-sell">Do Not Sell or Share My Personal Information</a> &middot; <a href="https://github.com/jensoltys/resumeprune" target="_blank" rel="noopener noreferrer">Open source</a> &middot; <a href="mailto:support@example.com">Contact: support@example.com</a></p>
      <p style="margin-top:0.5rem;font-size:0.8rem;color:#A7B8AD">&copy; ${new Date().getFullYear()} YOUR COMPANY NAME &middot; YOUR BUSINESS ADDRESS</p>
      <p style="margin-top:0.5rem;font-size:0.75rem;color:#A7B8AD">Resume Prune isn't affiliated with or endorsed by LinkedIn or Microsoft. LinkedIn is a registered trademark or trademark of LinkedIn Corporation and its affiliates in the United States and/or other countries. Microsoft and Word are trademarks of the Microsoft group of companies.</p>
    </footer>`;
  document.body.insertAdjacentHTML('beforeend', html);
})();
