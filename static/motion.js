/* ── MOTION — Tripartite System ────────────────────────────────────────────────
   A small, dependency-free spring engine translated from Apple's design guidance
   (WWDC "Designing Fluid Interfaces").

   The whole point of a spring here is that motion is *interruptible*: every
   animation keeps its live value and velocity, so a new target re-targets from
   where the element actually is, rather than snapping to a logical value.

   Public surface:
     Motion.spring(el, props, opts)   animate transform/opacity with a spring
     Motion.to(el, props, opts)       alias
     Motion.stop(el)                  halt animations on an element
     Motion.project(v, rate)          momentum projection (§6)
     Motion.rubberband(v, dim)        soft boundary resistance (§9)
     Motion.gesture(el, opts)         pointer-driven 1:1 drag (§2, §5, §10)
                                      -> { active, offset, close() }
     Motion.haptic(pattern)           vibration, same-frame with visuals (§13)
     Motion.reduced                   live reduced-motion flag
     Motion.tokens                    Apple's shipped damping/response values (§4)

   Animations are written as inline `transform`/`opacity` (compositor-friendly,
   §11) and always start from the *presentation* value read off the element.
──────────────────────────────────────────────────────────────────────────────── */

(function (global) {
  'use strict';

  var REDUCED = global.matchMedia
    ? global.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false, addEventListener: function () {} };

  // Apple's shipped values (§4). Damping controls overshoot, response is how
  // quickly the value settles — *not* a duration; a spring has no fixed duration.
  var TOKENS = {
    move:     { damping: 1.0, response: 0.4 },  // reposition, e.g. PiP
    rotate:   { damping: 0.8, response: 0.4 },  // rotation
    sheet:    { damping: 0.8, response: 0.3 },  // drawer / sheet
    // House style: critically damped everywhere by default, so nothing overshoots
    // unless a gesture actually carried momentum.
    ui:       { damping: 1.0, response: 0.35 },
    momentum: { damping: 0.8, response: 0.35 }
  };

  /* ── spring math ──────────────────────────────────────────────────────────── */

  var FIXED_DT = 1 / 120;      // internal integration step (subdivided from frame dt)
  var MAX_SUBSTEPS = 8;        // cap work after a backgrounded tab

  // Damping ratio + response -> the stiffness/damping the solver needs.
  // This is the standard iOS-style parameterisation.
  function springConstants(dampingRatio, response) {
    var omega = (2 * Math.PI) / Math.max(0.001, response);
    var zeta = Math.max(0.02, dampingRatio);
    return { omega: omega, zeta: zeta, stiffness: omega * omega, damping: 2 * zeta * omega };
  }

  // Pre-compute the exact one-step propagator for constant (stiffness, damping).
  // Integrating a damped harmonic oscillator with explicit Euler adds *numerical*
  // damping — it silently eats the overshoot a low damping ratio is supposed to
  // produce, and blows up when the step is large. Solving the ODE in closed form
  // instead is exact, unconditionally stable, and frame-rate independent (§11).
  function propagator(constants) {
    var omega = constants.omega, zeta = constants.zeta;
    var c = { omega: omega, zeta: zeta, kind: 'under' };
    if (zeta < 0.999) {
      c.kind = 'under';
      c.omegaD = omega * Math.sqrt(1 - zeta * zeta);
    } else if (zeta <= 1.001) {
      c.kind = 'critical';
    } else {
      c.kind = 'over';
      c.omegaD = omega * Math.sqrt(zeta * zeta - 1);
    }
    return c;
  }

  function advance(state, target, constants, dt) {
    var prop = constants.__prop;
    if (!prop) prop = constants.__prop = propagator(constants);

    if (dt > FIXED_DT) {
      // Subdivide so a long frame stays exact rather than taking one huge step.
      var steps = Math.min(MAX_SUBSTEPS, Math.ceil(dt / FIXED_DT));
      var sub = dt / steps;
      for (var i = 0; i < steps; i++) advanceFixed(state, target, prop, sub);
      return state;
    }
    advanceFixed(state, target, prop, dt);
    return state;
  }

  function advanceFixed(state, target, prop, dt) {
    var x = state.value - target;
    var v = state.velocity;
    var e, nx, nv;

    if (prop.kind === 'critical') {
      // x(t) = e^-ωt (x + (v + ωx)t)
      e = Math.exp(-prop.omega * dt);
      nx = e * (x + (v + prop.omega * x) * dt);
      nv = e * (v - prop.omega * dt * (v + prop.omega * x));
    } else {
      var wd = prop.omegaD;
      e = Math.exp(-prop.zeta * prop.omega * dt);
      var cos = Math.cos(wd * dt), sin = Math.sin(wd * dt);
      if (prop.kind === 'under') {
        nx = e * (x * cos + ((v + prop.zeta * prop.omega * x) / wd) * sin);
        nv = e * (-prop.zeta * prop.omega * x * cos - ((prop.zeta * prop.omega * (v + prop.zeta * prop.omega * x)) / wd) * sin
             - x * wd * sin + (v + prop.zeta * prop.omega * x) * cos);
      } else {
        // Overdamped: swap the trig for hyperbolic functions.
        var cosh = Math.cosh(wd * dt), sinh = Math.sinh(wd * dt);
        nx = e * (x * cosh + ((v + prop.zeta * prop.omega * x) / wd) * sinh);
        nv = e * (-prop.zeta * prop.omega * x * cosh - ((prop.zeta * prop.omega * (v + prop.zeta * prop.omega * x)) / wd) * sinh
             + x * wd * sinh + (v + prop.zeta * prop.omega * x) * cosh);
      }
    }

    state.value = nx + target;
    state.velocity = nv;
    if (!isFinite(state.value)) { state.value = target; state.velocity = 0; }
    if (!isFinite(state.velocity)) state.velocity = 0;
    return state;
  }

  // A spring never formally "ends"; we stop once it is visually settled.
  //
  // The tolerance must be *per axis*: 0.05px is invisible for a translation,
  // but scale and opacity are unitless and move a fraction of that, so the same
  // number would declare a scale animation finished after one frame.
  function restTolerance(key) {
    if (key === 'x' || key === 'y') return 0.1;        // px
    if (key === 'rotate') return 0.05;                 // deg
    return 0.001;                                      // scale / opacity
  }

  function isResting(state, target, key) {
    var tol = key == null ? 0.001 : restTolerance(key);
    return Math.abs(target - state.value) < tol && Math.abs(state.velocity) < tol;
  }

  /* ── transform composition ────────────────────────────────────────────────── */

  // Elements can be animated on several axes at once (x from a drag, scale from a
  // press). We keep one record per element and compose a single transform string,
  // so independent axes never fight each other (§3: decompose 2D motion).
  var TRANSFORM_KEYS = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate', 'blur'];
  var records = global.WeakMap ? new WeakMap() : null;
  var fallbackRecords = [];

  function recordFor(el) {
    if (records) {
      if (!records.has(el)) records.set(el, { values: {}, anims: {}, transform: '', opacity: null });
      return records.get(el);
    }
    for (var i = 0; i < fallbackRecords.length; i++) {
      if (fallbackRecords[i].el === el) return fallbackRecords[i].rec;
    }
    var rec = { values: {}, anims: {}, transform: '', opacity: null };
    fallbackRecords.push({ el: el, rec: rec });
    return rec;
  }

  function unitFor(key, v) {
    if (key === 'scale' || key === 'scaleX' || key === 'scaleY') return '';
    if (key === 'rotate') return 'deg';
    return 'px';
  }

  function composeTransform(rec) {
    var v = rec.values, parts = [];
    if (v.x) parts.push('translate3d(' + v.x + 'px,0,0)');
    if (v.y) parts.push('translate3d(0,' + v.y + 'px,0)');
    if (v.scale != null && v.scale !== 1) parts.push('scale(' + v.scale + ')');
    if (v.scaleX != null && v.scaleX !== 1) parts.push('scaleX(' + v.scaleX + ')');
    if (v.scaleY != null && v.scaleY !== 1) parts.push('scaleY(' + v.scaleY + ')');
    if (v.rotate) parts.push('rotate(' + v.rotate + 'deg)');
    return parts.join(' ');
  }

  function applyRecord(el, rec) {
    var t = composeTransform(rec);
    if (t !== rec.transform) { el.style.transform = t; rec.transform = t; }
    if (rec.opacity != null) el.style.opacity = rec.opacity;
  }

  // Read the *live* on-screen value. If we have no record yet (e.g. the element
  // is positioned by CSS), fall back to its computed matrix so an interruption
  // starts from what the user can actually see, not from 0 (§3).
  function currentValue(el, rec, key) {
    if (rec.values[key] != null) return rec.values[key];
    if (key === 'scale' || key === 'scaleX' || key === 'scaleY') {
      var s = currentScale(el);
      rec.values[key] = s;
      return s;
    }
    if (key === 'x' || key === 'y') {
      var m = currentMatrix(el);
      var val = key === 'x' ? m.x : m.y;
      rec.values[key] = val;
      return val;
    }
    rec.values[key] = 0;
    return 0;
  }

  function currentScale(el) {
    var m = currentMatrix(el);
    return m.scale;
  }

  function currentMatrix(el) {
    var out = { x: 0, y: 0, scale: 1 };
    try {
      var t = global.getComputedStyle(el).transform;
      if (!t || t === 'none') return out;
      var nums = t.match(/matrix(3d)?\(([^)]+)\)/);
      if (!nums) return out;
      var p = nums[2].split(',').map(function (n) { return parseFloat(n); });
      if (nums[1]) { out.x = p[12] || 0; out.y = p[13] || 0; out.scale = p[0] || 1; }
      else { out.x = p[4] || 0; out.y = p[5] || 0; out.scale = p[0] || 1; }
    } catch (e) {}
    return out;
  }

  /* ── core animation ───────────────────────────────────────────────────────── */

  function spring(el, props, opts) {
    if (!el) return null;
    opts = opts || {};
    var rec = recordFor(el);
    var wantsMotion = 'x' in props || 'y' in props || 'scale' in props ||
                      'scaleX' in props || 'scaleY' in props || 'rotate' in props;
    var wantsOpacity = 'opacity' in props;

    // §14 — reduced motion is a gentler equivalent, not "no feedback".
    // Movement collapses to a short opacity cross-fade; opacity still animates.
    if (REDUCED.matches) {
      if (wantsOpacity) {
        el.style.transition = 'opacity ' + (opts.fadeMs || 200) + 'ms ease';
        el.style.opacity = props.opacity;
      }
      if (wantsMotion && !wantsOpacity) {
        // No cross-fade available for movement — settle immediately and cleanly.
        var r0 = recordFor(el);
        if ('x' in props) r0.values.x = props.x;
        if ('y' in props) r0.values.y = props.y;
        if ('scale' in props) r0.values.scale = props.scale;
        if ('scaleX' in props) r0.values.scaleX = props.scaleX;
        if ('scaleY' in props) r0.values.scaleY = props.scaleY;
        if ('rotate' in props) r0.values.rotate = props.rotate;
        applyRecord(el, r0);
      }
      if (opts.onComplete) setTimeout(opts.onComplete, 0);
      return null;
    }

    // Clear any CSS transition — transitions can't be grabbed mid-flight and
    // would fight the spring (§3: avoid CSS transitions for gesture-driven UI).
    el.style.transition = '';

    var token = typeof opts.token === 'string' ? TOKENS[opts.token] : null;
    var damping = opts.damping != null ? opts.damping
                : (token ? token.damping : TOKENS.ui.damping);
    var response = opts.response != null ? opts.response
                 : (token ? token.response : TOKENS.ui.response);
    var constants = springConstants(damping, response);

    // Momentum interactions may overshoot; anything else should not (§4).
    if (opts.momentum && opts.damping == null && !token) {
      constants = springConstants(TOKENS.momentum.damping, TOKENS.momentum.response);
    }

    if (wantsMotion) el.style.willChange = 'transform';
    if (wantsOpacity) el.style.willChange = (el.style.willChange ? el.style.willChange + ', ' : '') + 'opacity';

    var anim = rec.anims.__main;
    if (!anim) {
      anim = rec.anims.__main = { axes: {}, raf: 0, last: 0, onComplete: null, el: el, rec: rec };
    }
    anim.onComplete = opts.onComplete || null;

    requestAnimationFrame(function () {
      ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate'].forEach(function (key) {
        if (!(key in props)) return;
        // An explicit `initial` seeds the starting value. Without it the engine
        // reads the live computed matrix, which is the correct interruption
        // behaviour (§3) — but a caller that has just posed the element should
        // pass `initial` so the pose is authoritative rather than re-derived.
        var seeded = opts.initial && opts.initial[key] != null;
        var from = seeded ? opts.initial[key]
                 : currentValue(el, rec, key);
        if (seeded) rec.values[key] = from;
        if (key === 'scale' && !rec.values.__scaleInit) {
          rec.values.scale = from;
          rec.values.__scaleInit = true;
        }
        var axis = anim.axes[key];
        if (!axis) {
          axis = anim.axes[key] = { value: from, velocity: 0, target: props[key], constants: constants };
        } else {
          // Re-target from the current value, keeping velocity: this is what
          // makes a reversal continuous instead of a "brick wall" (§3).
          axis.target = props[key];
          axis.constants = constants;
        }
      });

      if (wantsOpacity) {
        var oa = anim.axes.opacity;
        var targetOpacity = props.opacity;
        if (!oa) {
          var live = parseFloat(global.getComputedStyle(el).opacity);
          if (isNaN(live)) live = rec.opacity != null ? rec.opacity : 1;
          oa = anim.axes.opacity = { value: live, velocity: 0, target: targetOpacity, constants: constants };
        } else {
          oa.target = targetOpacity;
          oa.constants = constants;
        }
      }

      // Hand off the gesture's release velocity so there is no visible seam
      // between dragging and animating (§5).
      if (opts.velocity && anim.axes.__pendingVelocity == null) anim.axes.__pendingVelocity = opts.velocity;

      startLoop(el, rec, anim);
    });

    return {
      stop: function () { stop(el); },
      then: function (fn) { anim.onComplete = fn; return this; }
    };
  }

  function startLoop(el, rec, anim) {
    if (anim.raf) return;
    anim.last = 0;
    var pending = anim.axes.__pendingVelocity;
    if (pending) {
      ['x', 'y'].forEach(function (k) {
        if (anim.axes[k] && pending[k] != null) anim.axes[k].velocity = pending[k];
      });
      if (pending.all != null) {
        Object.keys(anim.axes).forEach(function (k) {
          if (k !== '__pendingVelocity' && anim.axes[k]) anim.axes[k].velocity = pending.all;
        });
      }
      delete anim.axes.__pendingVelocity;
    }

    function frame(now) {
      anim.raf = 0;
      if (!anim.last) anim.last = now;
      // Cap the reported frame gap; advance() subdivides internally so a
      // backgrounded tab resumes smoothly instead of jumping.
      var dt = Math.min(0.25, Math.max(0.001, (now - anim.last) / 1000));
      anim.last = now;

      var resting = true;
      Object.keys(anim.axes).forEach(function (key) {
        if (key.charAt(0) === '_') return;
        var axis = anim.axes[key];
        advance(axis, axis.target, axis.constants, dt);
        // Land exactly on the target instead of stopping a hair short, so a
        // settled element is at identity (scale 1, y 0) rather than 0.999.
        if (isResting(axis, axis.target, key)) { axis.value = axis.target; axis.velocity = 0; }
        else resting = false;
        if (key === 'opacity') rec.opacity = axis.value;
        else rec.values[key] = axis.value;
      });

      applyRecord(el, rec);

      if (resting) {
        // Keep a settled transform in place: an element's resting position may
        // be non-identity (e.g. a drawer parked off-screen), and clearing it
        // would let the stylesheet snap it somewhere else.
        if (!rec.values.x && !rec.values.y && !rec.values.rotate &&
            (rec.values.scale == null || rec.values.scale === 1) &&
            (rec.values.scaleX == null || rec.values.scaleX === 1) &&
            (rec.values.scaleY == null || rec.values.scaleY === 1)) {
          el.style.transform = '';
          rec.transform = '';
        }
        el.style.willChange = '';
        var done = anim.onComplete;
        anim.onComplete = null;
        if (done) done();
        return;
      }
      anim.raf = requestAnimationFrame(frame);
    }
    anim.raf = requestAnimationFrame(frame);
  }

  function stop(el) {
    if (!el) return;
    var rec = recordFor(el);
    var anim = rec.anims.__main;
    if (anim && anim.raf) cancelAnimationFrame(anim.raf);
    if (anim) { anim.raf = 0; anim.axes = {}; }
  }

  /* ── momentum & boundaries (§6, §9) ───────────────────────────────────────── */

  // Apple's exact projection (exponential decay), not the v²/2a textbook form.
  function project(initialVelocity, decelerationRate) {
    var d = decelerationRate == null ? 0.998 : decelerationRate;
    return (initialVelocity / 1000) * d / (1 - d);
  }

  // Progressive resistance past a boundary: the further out, the less it follows.
  function rubberband(overshoot, dimension, constant) {
    var c = constant == null ? 0.55 : constant;
    if (!dimension) return 0;
    return (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));
  }

  /* ── gesture (§2 tracking, §5 handoff, §10 hysteresis) ────────────────────── */

  function gesture(el, opts) {
    if (!el) return { active: false, offset: 0, close: function () {} };
    opts = opts || {};
    var axis = opts.axis || 'x';          // 'x' horizontal drag, 'y' vertical
    var capture = opts.capture !== false;
    var hysteresis = opts.hysteresis == null ? 10 : opts.hysteresis;
    var dimension = opts.dimension || (global.innerWidth || 320);
    var bounds = opts.bounds || null;     // [min, max]
    var HISTORY = 5;                      // last few moves -> release velocity

    var active = false, decided = false, pointerId = null;
    var startPos = 0, startOffset = 0, offset = 0, moved = 0;
    var history = [];
    var rec = recordFor(el);

    function posOf(e) { return axis === 'x' ? e.clientX : e.clientY; }

    function velocity() {
      if (history.length < 2) return 0;
      var first = history[0], last = history[history.length - 1];
      var dt = (last.t - first.t) / 1000;
      if (dt <= 0) return 0;
      return (last.p - first.p) / dt;      // px/s
    }

    function onDown(e) {
      if (e.button != null && e.button !== 0) return;
      if (opts.canStart && !opts.canStart(e)) return;
      active = true; decided = false; moved = 0;
      pointerId = e.pointerId;
      startPos = posOf(e);
      startOffset = opts.offset ? opts.offset() : (rec.values[axis] || 0);
      offset = startOffset;
      history = [{ p: startPos, t: e.timeStamp || performance.now() }];
      if (capture && el.setPointerCapture && pointerId != null) {
        try { el.setPointerCapture(pointerId); } catch (err) {}
      }
      stop(el);
      if (opts.onStart) opts.onStart(e);
    }

    function onMove(e) {
      if (!active) return;
      var p = posOf(e);
      var delta = p - startPos;

      // §10 — require a small movement threshold before committing to a
      // direction, so a tap with slight drift isn't read as a drag.
      if (!decided) {
        if (Math.abs(delta) < hysteresis) return;
        decided = true;
        el.style.transition = '';
        if (opts.onCommit) opts.onCommit(e);
      }

      moved = delta;
      history.push({ p: p, t: e.timeStamp || performance.now() });
      if (history.length > HISTORY) history.shift();

      var next = startOffset + delta;
      // §9 — resist progressively past a boundary instead of stopping hard.
      if (bounds) {
        if (next < bounds[0]) next = bounds[0] + rubberband(next - bounds[0], dimension);
        else if (next > bounds[1]) next = bounds[1] + rubberband(next - bounds[1], dimension);
      }

      var vals = {};
      vals[axis] = next;
      rec.values[axis] = next;             // keep the record authoritative
      applyRecord(el, rec);
      offset = next;
      if (opts.onDrag) opts.onDrag(next, e);
    }

    function finish(e, cancelled) {
      if (!active) return;
      active = false;
      if (capture && el.releasePointerCapture && pointerId != null) {
        try { el.releasePointerCapture(pointerId); } catch (err) {}
      }
      var v = velocity();
      var wasDecided = decided;
      decided = false;
      if (opts.onEnd) opts.onEnd({ offset: offset, velocity: v, moved: moved, committed: wasDecided, cancelled: !!cancelled });
    }

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', function (e) { finish(e, false); });
    el.addEventListener('pointercancel', function (e) { finish(e, true); });

    // Return a handle: `active` lets callers know a drag is in flight (so they
    // don't fight it), and `close()` detaches the listeners entirely.
    return {
      get active() { return active; },
      get offset() { return offset; },
      close: function () {
        el.removeEventListener('pointerdown', onDown);
        el.removeEventListener('pointermove', onMove);
      }
    };
  }

  /* ── multimodal feedback (§13) ────────────────────────────────────────────── */

  // Fire in the same frame as the visual change; reserve for meaningful moments.
  function haptic(pattern) {
    if (REDUCED.matches && pattern !== 0) return;
    try {
      if (global.navigator && global.navigator.vibrate) global.navigator.vibrate(pattern);
    } catch (e) {}
  }

  /* ── scroll edge effects (§12) ────────────────────────────────────────────── */

  // Instead of a hard 1px divider under sticky chrome, mark whether content is
  // currently scrolled under it, and fade a mask only where they overlap.
  function scrollEdge(scroller, target, threshold) {
    if (!scroller) return function () {};
    var t = threshold == null ? 4 : threshold;
    var node = target || scroller;
    var raf = 0;
    function update() {
      raf = 0;
      var scrolled = scroller.scrollTop > t;
      node.classList.toggle('is-scrolled', scrolled);
    }
    function onScroll() { if (!raf) raf = requestAnimationFrame(update); }
    scroller.addEventListener('scroll', onScroll, { passive: true });
    update();
    return function () { scroller.removeEventListener('scroll', onScroll); };
  }

  function attachScrollEdges(root) {
    (root || document).querySelectorAll('[data-scroll-edge]').forEach(function (el) {
      scrollEdge(el, el.closest('.main') || document.body);
    });
  }

  /* ── exports ──────────────────────────────────────────────────────────────── */

  var Motion = {
    spring: spring,
    to: spring,
    stop: stop,
    // Introspection for tests and debugging: the live values the engine is
    // integrating for an element, plus the last transform it wrote.
    inspect: function (el) {
      var rec = recordFor(el);
      return {
        values: JSON.parse(JSON.stringify(rec.values)),
        opacity: rec.opacity,
        transform: rec.transform,
        running: !!(rec.anims.__main && rec.anims.__main.raf)
      };
    },
    project: project,
    rubberband: rubberband,
    gesture: gesture,
    haptic: haptic,
    scrollEdge: scrollEdge,
    attachScrollEdges: attachScrollEdges,
    springConstants: springConstants,
    advance: advance,
    isResting: isResting,
    tokens: TOKENS,
    get reduced() { return REDUCED.matches; }
  };

  global.Motion = Motion;

  // Let CSS react to reduced motion without JS (and keep the flag live if the
  // user flips it while the app is open).
  if (REDUCED.addEventListener) {
    REDUCED.addEventListener('change', function () {
      document.documentElement.classList.toggle('reduced-motion', REDUCED.matches);
      document.dispatchEvent(new CustomEvent('motionchange', { detail: REDUCED.matches }));
    });
  }
  document.documentElement.classList.toggle('reduced-motion', REDUCED.matches);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { attachScrollEdges(document); });
  } else {
    attachScrollEdges(document);
  }
})(typeof window !== 'undefined' ? window : this);
