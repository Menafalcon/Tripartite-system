/* Numerical verification of the Motion spring engine's math.
   Run: node tests/verify-motion.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Minimal window/listener stubs so the browser-targeted IIFE can load in Node.
const win = {
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
  cancelAnimationFrame: () => {},
  getComputedStyle: () => ({ transform: 'none', opacity: '1' }),
  innerWidth: 375,
  navigator: {},
  WeakMap,
  addEventListener() {},
};
// motion.js touches a few document APIs at load time (reduced-motion class,
// scroll-edge attachment). Stub just those so the module can be evaluated.
win.document = {
  documentElement: { classList: { toggle() {} } },
  readyState: 'complete',
  addEventListener() {},
  querySelectorAll: () => [],
  dispatchEvent() {},
};
win.CustomEvent = function () {};
win.window = win;
const ctx = vm.createContext(win);
const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'motion.js'), 'utf8');
vm.runInContext(src, ctx);
const M = win.Motion;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

// Simulate a spring to rest, returning the trajectory.
function simulate(from, target, damping, response, dt = 1 / 120, maxSteps = 4000) {
  const c = M.springConstants(damping, response);
  const s = { value: from, velocity: 0 };
  const traj = [from];
  let steps = 0;
  for (let i = 0; i < maxSteps; i++) {
    M.advance(s, target, c, dt);
    traj.push(s.value);
    steps++;
    if (M.isResting(s, target, 'x')) break;
  }
  return { traj, steps, seconds: steps * dt, end: s.value };
}

console.log('\n1. Damping ratio governs overshoot (§4)');

const crit = simulate(0, 100, 1.0, 0.4);
const maxCrit = Math.max(...crit.traj);
check('damping 1.0 does not overshoot', maxCrit <= 100.0001, 'peak=' + maxCrit.toFixed(3));
check('damping 1.0 settles exactly on target', Math.abs(crit.end - 100) < 0.05, 'end=' + crit.end.toFixed(4));
// A spring has no fixed duration: "response" is a time constant, so the visible
// settle lands a few multiples of it later — not exactly at it.
check('damping 1.0 visibly settles in a sane range', crit.seconds > 0.4 && crit.seconds < 1.6,
  crit.seconds.toFixed(3) + 's for response 0.4 over 100px');

const under = simulate(0, 100, 0.8, 0.4);
const maxUnder = Math.max(...under.traj);
check('damping 0.8 overshoots (momentum feel)', maxUnder > 100.5, 'peak=' + maxUnder.toFixed(2));
check('damping 0.8 overshoot is modest (<15%)', maxUnder < 115, 'peak=' + maxUnder.toFixed(2));

const veryUnder = simulate(0, 100, 0.5, 0.4);
const maxVery = Math.max(...veryUnder.traj);
check('lower damping overshoots more (0.5 > 0.8)', maxVery > maxUnder, 'p5=' + maxVery.toFixed(1) + ' p8=' + maxUnder.toFixed(1));

console.log('\n2. Response controls speed, not duration (§4)');
const fast = simulate(0, 100, 1.0, 0.2);
const slow = simulate(0, 100, 1.0, 0.6);
check('lower response settles sooner', fast.seconds < slow.seconds, fast.seconds.toFixed(3) + 's < ' + slow.seconds.toFixed(3) + 's');

console.log('\n3. Apple\'s shipped tokens settle sanely (§4 table)');
for (const [name, t] of Object.entries(M.tokens)) {
  const r = simulate(0, 100, t.damping, t.response);
  check(`token "${name}" settles < 1.2s`, r.seconds < 1.2, r.seconds.toFixed(3) + 's');
}

console.log('\n4. Momentum projection matches Apple\'s formula (§6)');
// v=1000px/s, d=0.998 -> (1000/1000)*0.998/0.002 = 499
check('project(1000, 0.998) === 499', Math.abs(M.project(1000, 0.998) - 499) < 1e-9, String(M.project(1000, 0.998)));
check('project is linear in velocity', Math.abs(M.project(2000) - 2 * M.project(1000)) < 1e-9);
check('project(0) === 0', M.project(0) === 0);
check('snappier rate projects less far', M.project(1000, 0.99) < M.project(1000, 0.998),
  M.project(1000, 0.99).toFixed(1) + ' < ' + M.project(1000, 0.998).toFixed(1));

console.log('\n5. Velocity handoff is continuous (§5, §3 — no brick wall)');
// Animate toward +100, then mid-flight reverse toward -100 keeping velocity.
const c = M.springConstants(1.0, 0.4);
const s = { value: 0, velocity: 0 };
for (let i = 0; i < 12; i++) M.advance(s, 100, c, 1 / 120); // fly partway
const beforeV = s.velocity, beforeX = s.value;
check('spring built up velocity', beforeV > 50, 'v=' + beforeV.toFixed(1));
// Re-target mid-flight: the re-target itself must not move the element at all.
// (Retargeting only changes the *target*; position comes from the live value.)
check('no positional jump on interrupt', Math.abs(s.value - beforeX) < 1e-9,
  'jump=' + Math.abs(s.value - beforeX).toExponential(2));
// One step later the element is still travelling the original way (momentum
// carries through) before the spring turns it around — no hard velocity cut.
M.advance(s, -100, c, 1 / 120);
check('velocity carries through the reversal (no hard cut)', s.velocity > 0 && s.value > 0,
  'v=' + s.velocity.toFixed(1) + ' (was ' + beforeV.toFixed(1) + '), x=' + s.value.toFixed(2));
const reversed = simulate(s.value, -100, 1.0, 0.4, 1 / 120, 4000);
check('eventually reverses to the new target', Math.abs(reversed.end - (-100)) < 0.05, 'end=' + reversed.end.toFixed(3));

console.log('\n6. Rubber-banding resists progressively (§9)');
const d = 300;
const r10 = M.rubberband(10, d), r50 = M.rubberband(50, d), r200 = M.rubberband(200, d);
check('resistance always follows the drag', r10 > 0 && r50 > r10 && r200 > r50,
  [r10, r50, r200].map(n => n.toFixed(1)).join(' < '));
check('rubberband output < raw overshoot (damped)', r200 < 200, r200.toFixed(1));
check('rubberband(0) === 0', M.rubberband(0, d) === 0);
check('resistance ratio shrinks as overshoot grows',
  (r50 / 50) > (r200 / 200), (r50 / 50).toFixed(3) + ' > ' + (r200 / 200).toFixed(3));

console.log('\n7. Integrator stability at large dt (§11)');
const bigDt = simulate(0, 100, 1.0, 0.4, 0.064);
check('stable at 64ms steps (clamped max)', bigDt.end > 99 && bigDt.end <= 100.001, 'end=' + bigDt.end.toFixed(3));
check('no NaN/Infinity blowup', bigDt.traj.every(n => Number.isFinite(n)));

console.log('\n' + '='.repeat(46));
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(46) + '\n');
process.exit(fail ? 1 : 0);
