// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Prices and plan buttons stay hidden until /api/config says paid plans are set up
// (STRIPE_SECRET_KEY plus at least one plan price). Mark anything that names a
// price or a paid plan with data-billing. data-no-billing shows only when billing is off.
(function () {
  var css = document.createElement('style');
  css.textContent = 'html:not(.billing-on) [data-plan], html:not(.billing-on) [data-billing] { display: none !important; }'
    + ' html.billing-on [data-no-billing] { display: none !important; }';
  document.head.appendChild(css);
  fetch('/api/config', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (c) { if (c && c.billing) document.documentElement.classList.add('billing-on'); })
    .catch(function () {});
})();
