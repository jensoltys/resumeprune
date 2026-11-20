// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Resume Prune authors. See LICENSE.
// Twig the bonsai: Resume Prune's mascot.
// Source of truth. scripts/recolor-lantern.py copies this file to public/shared/twig.js.
//
// Twig shows the match score on his body: shaggy canopy + stray branches at a low score,
// neat cloud pads at a high one, blossoms at 9 and 10, sparkles at 10.
//
//   <div class="twig" data-twig="8"></div>            drawn once at that score
//   <div class="twig" data-twig="5" data-twig-listen> redrawn on every 'rp:score' event
//   <p data-twig-bubble>                               speech bubble that follows the score
//   RPTwig.rank(el, lifetimeTweaks)                    pruning rank card
//
// shared/render.js fires document 'rp:score' ({detail:{score}}) each time it draws a match.
(function () {
  'use strict';
  var POT = ['#FFC062', '#E8912A', '#D98420'];
  var uid = 0;

  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function mix(a, b, t) {
    var pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    var r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
    var g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
    var bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }
  function f(n) { return (+n).toFixed(1); }

  function face(cx, cy, sc, t) {
    var s = '', iris = mix('#6B5B7B', '#2E8B57', t);
    [-1, 1].forEach(function (d) {
      var ex = cx + d * 14 * sc, ey = cy - 4 * sc;
      s += '<g class="twig-eye"><ellipse cx="' + f(ex) + '" cy="' + f(ey) + '" rx="' + f(8.5 * sc) + '" ry="' + f(10 * sc) + '" fill="#fff" stroke="#2A1E36" stroke-width="' + f(1.2 * sc) + '"/>' +
        '<circle cx="' + f(ex + d * .6 * sc) + '" cy="' + f(ey + 1.5 * sc) + '" r="' + f(6.2 * sc) + '" fill="' + iris + '"/>' +
        '<circle cx="' + f(ex + d * .6 * sc) + '" cy="' + f(ey + 1.5 * sc) + '" r="' + f(3.4 * sc) + '" fill="#1B1426"/>' +
        '<circle cx="' + f(ex + 2.4 * sc) + '" cy="' + f(ey - 2.2 * sc) + '" r="' + f(2.2 * sc) + '" fill="#fff"/>' +
        '<circle cx="' + f(ex - 2 * sc) + '" cy="' + f(ey + 3.4 * sc) + '" r="' + f(1 * sc) + '" fill="#fff"/></g>';
      if (t < .35) {
        var ix = ex - d * 6 * sc, ox = ex + d * 8 * sc;
        s += '<path d="M' + f(ox) + ' ' + f(ey - 13 * sc) + ' L' + f(ix) + ' ' + f(ey - 17.5 * sc) + '" stroke="#2A1E36" stroke-width="' + f(2.2 * sc) + '" stroke-linecap="round"/>';
      }
      s += '<ellipse cx="' + f(cx + d * 23 * sc) + '" cy="' + f(cy + 7 * sc) + '" rx="' + f(5.5 * sc) + '" ry="' + f(3.6 * sc) + '" fill="#FF8FA3" opacity="' + (.2 + .55 * t).toFixed(2) + '"/>';
    });
    var my = cy + 12 * sc, w = (t > .75 ? 10 : 7) * sc, c = (t - .4) * 18 * sc;
    if (t > .75) {
      s += '<path d="M' + f(cx - w) + ' ' + f(my) + ' Q' + f(cx) + ' ' + f(my + c * 1.5) + ' ' + f(cx + w) + ' ' + f(my) + ' Z" fill="#4A1D3A"/>' +
        '<ellipse cx="' + f(cx) + '" cy="' + f(my + c * .9) + '" rx="' + f(4 * sc) + '" ry="' + f(2.4 * sc) + '" fill="#FF8FA3"/>';
    } else {
      s += '<path d="M' + f(cx - w) + ' ' + f(my - c * .25) + ' Q' + f(cx) + ' ' + f(my + c) + ' ' + f(cx + w) + ' ' + f(my - c * .25) + '" fill="none" stroke="#2A1E36" stroke-width="' + f(2.3 * sc) + '" stroke-linecap="round"/>';
    }
    if (t < .25) {
      var sx = cx + 30 * sc, sy = cy - 24 * sc;
      s += '<path d="M' + f(sx) + ' ' + f(sy) + ' q -5 8 0 11 q 5 -3 0 -11 z" fill="#8FD3F4" stroke="#5AAED3" stroke-width="1"/>';
    }
    return s;
  }
  function leafShape(x, y, rot, sz, col) {
    return '<ellipse cx="' + f(x) + '" cy="' + f(y) + '" rx="' + sz + '" ry="' + sz * .5 + '" fill="' + col + '" transform="rotate(' + f(rot) + ' ' + f(x) + ' ' + f(y) + ')"/>';
  }
  function sparkle(x, y, r) {
    return '<path class="twig-sparkle" d="M' + x + ' ' + (y - r) + ' Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y + ' Q' + x + ' ' + y + ' ' + x + ' ' + (y + r) + ' Q' + x + ' ' + y + ' ' + (x - r) + ' ' + y + ' Q' + x + ' ' + y + ' ' + x + ' ' + (y - r) + 'Z" fill="#FFD36E"/>';
  }

  // score 1..10 (clamped). opts.pot = [top, bottom, rim], opts.label = accessible name.
  function svg(score, opts) {
    opts = opts || {};
    score = Math.max(1, Math.min(10, Math.round(Number(score) || 5)));
    var pot = opts.pot || POT, t = (score - 1) / 9, m = 1 - t, R = rng(7), id = 'twig' + (uid++), s = '';
    s += '<defs><linearGradient id="' + id + 'p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + pot[0] + '"/><stop offset="1" stop-color="' + pot[1] + '"/></linearGradient></defs>';
    s += '<ellipse cx="100" cy="212" rx="60" ry="6" fill="#000" opacity=".28"/>';
    s += '<path d="M96 162 C88 136 116 122 100 96 C92 82 104 70 100 58" stroke="#8A5A36" stroke-width="13" fill="none" stroke-linecap="round"/>';
    s += '<path d="M102 112 C120 106 134 100 146 90" stroke="#8A5A36" stroke-width="7" fill="none" stroke-linecap="round"/>';
    s += '<path d="M98 90 C80 86 70 78 60 70" stroke="#8A5A36" stroke-width="7" fill="none" stroke-linecap="round"/>';
    var pads = [[146, 82, 26], [58, 64, 24], [100, 44, 30]], dark = '', light = '', twigs = '', bl = '';
    pads.forEach(function (p) {
      var pts = [[0, 0, .62]];
      for (var i = 0; i < 6; i++) { var a = i / 6 * Math.PI * 2; pts.push([Math.cos(a) * .6, Math.sin(a) * .38, .5]); }
      pts.forEach(function (q) {
        var jx = (R() - .5) * p[2] * 1.4 * m, jy = (R() - .5) * p[2] * 1.3 * m, rr = p[2] * q[2] * (1 + R() * .8 * m);
        var x = p[0] + q[0] * p[2] + jx, y = p[1] + q[1] * p[2] + jy;
        dark += '<circle cx="' + f(x) + '" cy="' + f(y) + '" r="' + f(rr) + '" fill="#2E7D4F"/>';
        light += '<circle cx="' + f(x - 3) + '" cy="' + f(y - 4) + '" r="' + f(rr * .72) + '" fill="' + mix('#5E9F63', '#4FB06F', t) + '"/>';
      });
    });
    var n = Math.round(m * 17);
    for (var k = 0; k < n; k++) {
      var p = pads[k % 3], a = R() * Math.PI * 2, r0 = p[2] * .7, L = 16 + R() * 22;
      var x0 = p[0] + Math.cos(a) * r0, y0 = p[1] + Math.sin(a) * r0 * .7, x1 = x0 + Math.cos(a) * L, y1 = y0 + Math.sin(a) * L;
      twigs += '<path d="M' + f(x0) + ' ' + f(y0) + ' L' + f(x1) + ' ' + f(y1) + '" stroke="#7A4E2D" stroke-width="2.6" stroke-linecap="round"/>' + leafShape(x1, y1, a * 57.3, 6, '#5E9F63');
    }
    if (score >= 9) {
      var nb = (score - 8) * 6;
      for (var b = 0; b < nb; b++) {
        var p2 = pads[b % 3], bx = p2[0] + (R() - .5) * p2[2] * 1.3, by = p2[1] + (R() - .6) * p2[2] * .7;
        bl += '<circle cx="' + f(bx) + '" cy="' + f(by) + '" r="3.6" fill="#FF9CC2"/><circle cx="' + f(bx) + '" cy="' + f(by) + '" r="1.3" fill="#fff"/>';
      }
    }
    s += '<g class="twig-canopy">' + twigs + dark + light + bl + '</g>';
    s += '<path d="M44 168 L156 168 L146 206 Q100 214 54 206 Z" fill="url(#' + id + 'p)"/>';
    s += '<rect x="38" y="158" width="124" height="14" rx="7" fill="' + pot[2] + '"/><rect x="44" y="160" width="60" height="4" rx="2" fill="#fff" opacity=".3"/>';
    s += face(100, 186, .78, t);
    if (score === 10) s += sparkle(28, 40, 8) + sparkle(176, 36, 7) + sparkle(20, 120, 6) + sparkle(182, 130, 6);
    var label = opts.label || ('Twig the bonsai, looking like a ' + score + ' out of 10 match');
    return '<svg viewBox="0 0 200 220" role="img" aria-label="' + label + '">' + s + '</svg>';
  }

  var IDLE = "Paste a job and I'll size up the match.";
  var BANDS = [
    "Oof. We've got some overgrowth. Let's see what the job actually wants.",
    "Decent bones. A few branches are pointing the wrong way.",
    "Now we're shaping something. Fill a gap and I'll trim the rest.",
    "Look at that shape. Send it."
  ];
  var POKES = [
    "Every bullet should earn its spot. That's the whole rule.",
    "I only keep what fits. Works for trees, works for resumes.",
    "Snack budget? Cut. Microsoft Word? Cut. You're welcome.",
    "A bonsai is just a tree that took feedback well.",
    "Recruiters skim. Let's give them less to skim.",
    "I don't add branches I never grew. I won't add jobs you never had either.",
    "Two pages, tops. I've seen what three pages does to a person.",
    "Water me with a job description.",
    "Fill a gap and watch me perk up.",
    "I blossom at nine. No pressure.",
    "Careful, I'm holding very still for this pose.",
    "Pruned trees live longer. Pruned resumes get read."
  ];
  function line(score) {
    if (score == null) return IDLE;
    return BANDS[score <= 3 ? 0 : score <= 6 ? 1 : score <= 8 ? 2 : 3];
  }

  var RANKS = [
    { at: 1, name: 'Sprout Snipper' },
    { at: 5, name: 'Hedge Trimmer' },
    { at: 15, name: 'Topiary Artist' },
    { at: 40, name: 'Bonsai Master' }
  ];
  function rankFor(n) {
    var cur = null, next = RANKS[0];
    for (var i = 0; i < RANKS.length; i++) {
      if (n >= RANKS[i].at) { cur = RANKS[i]; next = RANKS[i + 1] || null; }
    }
    return { cur: cur, next: next };
  }
  function rank(el, lifetime) {
    if (!el) return;
    var n = Math.max(0, Number(lifetime) || 0), r = rankFor(n);
    var floor = r.cur ? r.cur.at : 0, pct = r.next ? Math.round((n - floor) / (r.next.at - floor) * 100) : 100;
    var left = r.next ? r.next.at - n : 0;
    var sub = r.next
      ? left + ' more tweak' + (left === 1 ? '' : 's') + ' to ' + r.next.name
      : 'Top rank. ' + n + ' tweaks and counting.';
    el.innerHTML =
      '<span class="rank-label">Pruning rank</span>' +
      '<b class="rank-name">' + (r.cur ? r.cur.name : 'No rank yet') + '</b>' +
      '<span class="rank-bar" role="progressbar" aria-label="Progress to the next rank" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i></span>' +
      '<small class="rank-sub">' + sub + '</small>';
    el.hidden = false;
  }

  function draw(el, score) { el.innerHTML = svg(score); el.dataset.twigNow = score; }
  function bubbleFor(el) {
    var scope = el.closest('[data-twig-scope]') || document;
    return scope.querySelector('[data-twig-bubble]');
  }
  function react(el, cls) {
    el.classList.remove('twig-pleased', 'twig-celebrate');
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(function () { el.classList.remove(cls); }, 1200);
  }
  function burst(el) {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var box = el.getBoundingClientRect(), cols = ['#FFB547', '#FF9CC2', '#8FE0A8', '#FFD36E'];
    for (var i = 0; i < 10; i++) {
      var d = document.createElement('i'), ang = i / 10 * Math.PI * 2 + Math.random() * .5, dist = 40 + Math.random() * 50;
      d.className = 'twig-particle';
      d.style.left = (box.left + box.width / 2) + 'px';
      d.style.top = (box.top + box.height * .35) + 'px';
      d.style.background = cols[i % cols.length];
      d.style.setProperty('--tx', f(Math.cos(ang) * dist) + 'px');
      d.style.setProperty('--ty', f(Math.sin(ang) * dist) + 'px');
      document.body.appendChild(d);
      setTimeout(function (n) { return function () { n.remove(); }; }(d), 800);
    }
  }

  var pokeIdx = Math.floor(Math.random() * POKES.length);
  function wire(el) {
    if (el.dataset.twigWired) return;
    el.dataset.twigWired = '1';
    draw(el, Number(el.dataset.twig) || 5);
    if (el.hasAttribute('data-twig-poke')) {
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', 'Poke Twig');
      var poke = function () {
        var b = bubbleFor(el);
        if (b) b.textContent = POKES[pokeIdx++ % POKES.length];
        react(el, 'twig-pleased');
        burst(el);
      };
      el.addEventListener('click', poke);
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); poke(); } });
    }
  }
  function mountAll(root) {
    (root || document).querySelectorAll('[data-twig]').forEach(wire);
    (root || document).querySelectorAll('[data-twig-bubble]').forEach(function (b) { if (!b.textContent.trim()) b.textContent = IDLE; });
  }
  document.addEventListener('rp:score', function (e) {
    var sc = Math.max(1, Math.min(10, Math.round(Number(e.detail && e.detail.score) || 5)));
    document.querySelectorAll('[data-twig-listen]').forEach(function (el) {
      draw(el, sc);
      react(el, sc >= 9 ? 'twig-celebrate' : 'twig-pleased');
      var b = bubbleFor(el);
      if (b) b.textContent = line(sc);
    });
  });

  function leaves(el) {
    if (!el || el.dataset.leavesDone) return;
    el.dataset.leavesDone = '1';
    var R = rng(3), cols = ['#4FB06F', '#FF9CC2', '#7FD89B', '#FFB547'];
    for (var i = 0; i < 8; i++) {
      var d = document.createElement('span');
      d.className = 'fall-leaf';
      d.style.left = (R() * 100).toFixed(1) + '%';
      d.style.animationDuration = (14 + R() * 12).toFixed(1) + 's';
      d.style.animationDelay = (-R() * 20).toFixed(1) + 's';
      d.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M3 17 C3 7 9 3 17 3 C17 11 13 17 3 17Z" fill="' + cols[i % cols.length] + '"/></svg>';
      el.appendChild(d);
    }
  }

  window.RPTwig = { svg: svg, line: line, rank: rank, rankFor: rankFor, RANKS: RANKS, mount: mountAll };
  function boot() { mountAll(); document.querySelectorAll('[data-leaves]').forEach(leaves); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
