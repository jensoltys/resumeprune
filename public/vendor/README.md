# Vendored client libraries

These ship with the static assets so the CSP can stay narrow (`script-src 'self'`).

| File | Source | Version | License |
|------|--------|---------|---------|
| `pdf.min.mjs` | https://github.com/mozilla/pdf.js | 4.10.38 | Apache-2.0 |
| `pdf.worker.min.mjs` | (same) | 4.10.38 | Apache-2.0 |
| `mammoth.browser.min.js` | https://github.com/mwilliamson/mammoth.js | 1.8.0 | BSD-2-Clause |
| `jspdf.umd.min.js` | npm `jspdf@4.2.1` dist/ (tarball shasum 6ba0d263999313f91f369ee80ecf235046b2acd8 matches the registry) | 4.2.1 | MIT |

Each library's license text ships next to it: `LICENSE.pdfjs.txt`, `LICENSE.mammoth.txt` and `LICENSE.jspdf.txt`.

## When to update

Bump only when a security advisory or a parsing bug shows up. After any version bump, upload
one PDF and one DOCX on /onboarding to check parsing still works.
