// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Twig's celebration popups (round 2, approved 2026-09-27). Source of truth:
// scripts/recolor-lantern.py copies this file to public/shared/celebrate.js.
//
//   RPCelebrate.show({ title, msg, score, size })   size: 'small' | 'medium' | 'big'
//
// App help only: no promos, no links to anything sold (a rule for celebrations).
// One popup at a time. A second show() while one is open waits in a queue.
// Each popup is one history entry ({ rp: 'celeb' }), so Back closes it and nothing else.
(function () {
  'use strict';
  var queue = [], open = null, returnFocus = null;
  var COLS = ['#FFB547', '#FF9CC2', '#8FE0A8', '#FFD36E', '#EAF2EC'];

  function reduced() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function isCelebEntry() { return !!(history.state && history.state.rp === 'celeb'); }

  function confetti(count) {
    if (reduced()) return;
    var c = document.createElement('canvas'), ctx = c.getContext && c.getContext('2d');
    if (!ctx) return;
    c.className = 'celeb-confetti';
    c.width = innerWidth; c.height = innerHeight;
    document.body.appendChild(c);
    var bits = [];
    for (var i = 0; i < count; i++) {
      bits.push({ x: innerWidth / 2 + (Math.random() - .5) * 160, y: innerHeight * .35,
        vx: (Math.random() - .5) * 13, vy: -Math.random() * 13 - 4, r: Math.random() * 6.3,
        vr: (Math.random() - .5) * .35, w: 6 + Math.random() * 6, h: 4 + Math.random() * 4, c: COLS[i % COLS.length] });
    }
    var t0 = performance.now();
    (function frame(now) {
      var age = now - t0;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.globalAlpha = Math.max(0, 1 - age / 2600);
      bits.forEach(function (b) {
        b.vy += .32; b.x += b.vx; b.y += b.vy; b.r += b.vr; b.vx *= .99;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c;
        ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
      });
      if (age < 2600) requestAnimationFrame(frame); else c.remove();
    })(t0);
  }

  function build(o) {
    var ov = document.createElement('div');
    ov.className = 'celeb-overlay celeb-' + (o.size || 'small');
    ov.innerHTML =
      '<div class="celeb-box" role="dialog" aria-modal="true" aria-labelledby="celebTitle" aria-describedby="celebMsg" tabindex="-1">' +
        '<div class="celeb-twig">' + (window.RPTwig ? RPTwig.svg(o.score || 9, { label: 'Twig the bonsai, celebrating' }) : '') + '</div>' +
        '<h2 class="celeb-title" id="celebTitle"></h2>' +
        '<p class="celeb-msg" id="celebMsg"></p>' +
        '<button type="button" class="celeb-close">' + (o.size === 'big' ? 'Heck yes' : 'Nice') + '</button>' +
      '</div>';
    ov.querySelector('.celeb-title').textContent = o.title || '';
    ov.querySelector('.celeb-msg').textContent = o.msg || '';
    ov.querySelector('.celeb-close').addEventListener('click', function () { close(); });
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    return ov;
  }

  function show(o) {
    if (open) { queue.push(o); return; }
    returnFocus = document.activeElement;
    open = build(o);
    document.body.appendChild(open);
    if (!isCelebEntry()) { try { history.pushState({ rp: 'celeb' }, ''); } catch (e) { /* ignore */ } }
    open.querySelector('.celeb-close').focus({ preventScroll: true });
    var n = o.size === 'big' ? 160 : o.size === 'medium' ? 80 : 30;
    confetti(n);
    if (o.size === 'big') setTimeout(function () { confetti(120); }, 650);
  }

  // fromHistory=true means popstate already unwound the entry, so tear down directly.
  function close(fromHistory) {
    if (!open) return;
    if (!fromHistory && isCelebEntry()) { history.back(); return; }
    open.remove();
    open = null;
    if (queue.length) { setTimeout(function () { show(queue.shift()); }, 250); return; }
    if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }

  window.addEventListener('popstate', function () { if (open && !isCelebEntry()) close(true); });
  document.addEventListener('keydown', function (e) {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') { e.preventDefault(); open.querySelector('.celeb-close').focus(); } // one control, keep focus in
  });

  window.RPCelebrate = { show: show, close: close, isOpen: function () { return !!open; } };
})();
