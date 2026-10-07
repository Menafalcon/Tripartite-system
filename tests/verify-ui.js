/* ── Live UI verification ───────────────────────────────────────────────────────
   Loads the real app in headless Chrome (driven over the DevTools Protocol, using
   the browser already on this machine and Node's built-in WebSocket — no extra
   packages) and asserts that the motion layer is wired up and behaving.

   Usage:  python launcher.py          # app must be running on :5050
           node tests/verify-ui.js
──────────────────────────────────────────────────────────────────────────────── */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => fs.existsSync(p));

const BASE = process.env.TRI_BASE || 'http://127.0.0.1:5050';
const SHOTS = path.join(__dirname, '..', 'shots');
// A per-run debug port avoids colliding with a leftover browser from an
// interrupted run (which otherwise makes every fetch fail with "Failed to fetch").
const PORT = 9300 + (process.pid % 400);
const profile = path.join(os.tmpdir(), 'tri-cdp-' + Date.now());

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});

if (!CHROME) {
  console.error('No Chrome or Edge found; cannot run the UI verification.');
  process.exit(2);
}

(async () => {
  // Fail fast with a clear message if the app isn't running.
  await new Promise((res, rej) => {
    http.get(BASE + '/api/ping', r => res(r.statusCode)).on('error', () =>
      rej(new Error('App is not reachable at ' + BASE + ' — start it with:  python launcher.py')));
  }).catch(e => { console.error(e.message); process.exit(2); });

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1280,900', 'about:blank'
  ], { stdio: 'ignore' });

  for (let i = 0; i < 50; i++) {
    try { const v = await get(`http://127.0.0.1:${PORT}/json/version`); if (v.webSocketDebuggerUrl) break; }
    catch (e) {}
    await sleep(200);
  }

  const tabs = await get(`http://127.0.0.1:${PORT}/json/list`);
  const target = tabs.find(t => t.type === 'page');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.binaryType = 'arraybuffer';
  let msgId = 0;
  const pending = new Map();
  const consoleErrors = [];
  const pageErrors = [];

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      pageErrors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
  });

  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('CDP websocket failed to open')));
  });
  const send = (method, params) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, (m) => res(m.result));
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r && r.exceptionDetails) return { __error: r.exceptionDetails.text + ' ' + ((r.exceptionDetails.exception || {}).description || '') };
    return r && r.result ? r.result.value : undefined;
  };
  const evalJson = async (expr) => {
    const raw = await evaluate(expr);
    if (raw && raw.__error) throw new Error('page threw: ' + raw.__error);
    if (typeof raw !== 'string') throw new Error('expected JSON string, got ' + JSON.stringify(raw));
    return JSON.parse(raw);
  };
  const load = async (url) => {
    consoleErrors.length = 0; pageErrors.length = 0;
    await send('Page.navigate', { url });
    await sleep(1700);
  };
  const login = async (user, pass) => {
    await load(BASE + '/');
    return evaluate(`(async () => {
      const r = await fetch('/api/login', {
        method:'POST', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({username:${JSON.stringify(user)}, password:${JSON.stringify(pass)}})
      });
      return r.status + ':' + (await r.text()).slice(0,80);
    })()`);
  };
  const AS = '?as=demo';   // impersonate the demo account (10 units / items / farms)

  console.log('\n0. Sign in through the real API (so protected pages render fully)');
  const loginResult = await login('demo', 'demo123');
  check('demo login succeeds', /^200:/.test(loginResult), loginResult);
  const me = await evalJson(`fetch('/api/me',{credentials:'include'}).then(r=>r.json()).then(u=>JSON.stringify({id:u.id}))`);
  check('session carries into the browser', me && me.id === 'demo', JSON.stringify(me));

  console.log('\n1. Engine loads on every page');
  const pages = ['/', '/rental.html', '/store.html', '/agriculture.html', '/hub.html', '/ai.html', '/profile.html', '/admin.html'];
  const engineReport = [];
  for (const p of pages) {
    await load(BASE + p + AS);
    const info = await evalJson(`JSON.stringify({
      motion: typeof window.Motion,
      spring: window.Motion && typeof window.Motion.spring,
      gesture: window.Motion && typeof window.Motion.gesture,
      project: window.Motion && typeof window.Motion.project,
      tokens: window.Motion && Object.keys(window.Motion.tokens).length,
      overlays: document.querySelectorAll('.overlay').length,
      patched: Array.from(document.querySelectorAll('.overlay')).filter(o=>o.__motionPatched).length
    })`);
    engineReport.push({ page: p, info, errs: [...pageErrors] });
  }
  for (const r of engineReport) {
    check(`Motion engine present on ${r.page}`,
      r.info.motion === 'object' && r.info.spring === 'function' && r.info.gesture === 'function', JSON.stringify(r.info));
  }
  check('no uncaught JS exceptions on any page', engineReport.every(r => r.errs.length === 0),
    engineReport.filter(r => r.errs.length).map(r => r.page + ': ' + r.errs[0]).join(' | '));
  const withOverlays = engineReport.filter(r => r.info.overlays > 0);
  check('protected pages render their modals', withOverlays.length >= 4, withOverlays.length + ' pages had overlays');
  check('every rendered overlay is motion-patched',
    withOverlays.every(r => r.info.patched === r.info.overlays),
    withOverlays.map(r => r.page + ' ' + r.info.patched + '/' + r.info.overlays).join(', '));

  console.log('\n2. Overlay motion is wired to existing call sites');
  await load(BASE + '/rental.html' + AS);
  const ov = await evalJson(`JSON.stringify({
    count: document.querySelectorAll('.overlay').length,
    patched: Array.from(document.querySelectorAll('.overlay')).filter(o=>o.__motionPatched).length,
    allHidden: Array.from(document.querySelectorAll('.overlay')).every(o=>getComputedStyle(o).display==='none')
  })`);
  check('overlays found on page', ov.count > 0, 'count=' + ov.count);
  check('every overlay is motion-patched', ov.patched === ov.count, ov.patched + '/' + ov.count);
  check('overlays start hidden', ov.allHidden);

  console.log('\n3. Opening a modal springs the sheet (animated, not an instant flip)');
  const op = await evalJson(`(async () => {
    const o = document.querySelector('.overlay');
    const sheet = o.querySelector('.modal') || o.firstElementChild;
    o.classList.add('open');            // exactly what the pages do
    // Sample repeatedly: a spring has no fixed duration, so we assert it is
    // *still moving* across frames rather than checking one arbitrary instant.
    const samples = [];
    for (let i = 0; i < 8; i++) {
      await new Promise(r => requestAnimationFrame(r));
      samples.push(sheet.style.transform || '');
    }
    await new Promise(r => setTimeout(r, 1400));
    return JSON.stringify({
      samples,
      distinct: new Set(samples).size,
      moved: samples.some(s => /translate3d|scale/.test(s)),
      midDisp: getComputedStyle(o).display,
      after: { t: sheet.style.transform, op: sheet.style.opacity }
    });
  })()`);
  check('modal becomes visible when opened', op.midDisp === 'flex', 'display=' + op.midDisp);
  check('sheet animates through multiple distinct frames', op.moved && op.distinct >= 2,
    'distinct=' + op.distinct + ' samples=' + JSON.stringify(op.samples));
  check('sheet settles at identity transform',
    op.after.t === '' || op.after.t === 'none' || !/scale\(0\./.test(op.after.t), 'transform=' + JSON.stringify(op.after.t));
  check('sheet ends fully opaque', op.after.op === '1' || op.after.op === '', 'opacity=' + op.after.op);

  console.log('\n4. Reversing mid-flight does not jump (the interrupt test)');
  const ip = await evalJson(`(async () => {
    const o = document.querySelector('.overlay');
    const sheet = o.querySelector('.modal') || o.firstElementChild;
    o.classList.remove('open');                     // start closing
    await new Promise(r=>setTimeout(r,5));
    o.classList.remove('open');
    await new Promise(r=>setTimeout(r,120));
    const a = sheet.getBoundingClientRect().top;    // live on-screen position
    o.classList.add('open');                        // grab it again, mid-close
    const b = sheet.getBoundingClientRect().top;    // must not jump
    await new Promise(r=>setTimeout(r,700));
    return JSON.stringify({ jump: Math.abs(b - a), reopened: o.classList.contains('open'), disp: getComputedStyle(o).display });
  })()`);
  check('re-opening mid-close does not teleport the sheet', ip.jump < 12, 'jump=' + ip.jump.toFixed(2) + 'px');
  check('modal is open again after interrupt', ip.reopened && ip.disp === 'flex');

  console.log('\n4b. Re-opening after a completed close is not left invisible');
  const reopen = await evalJson(`(async () => {
    const o = document.querySelector('.overlay');
    const sheet = o.querySelector('.modal') || o.firstElementChild;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    o.classList.add('open'); await wait(900);       // fully open
    o.classList.remove('open'); await wait(1100);   // fully closed + hidden
    const hiddenDisplay = getComputedStyle(o).display;
    o.classList.add('open');                        // open it again
    await wait(30);
    const early = { overlay: getComputedStyle(o).opacity, sheet: getComputedStyle(sheet).opacity, disp: getComputedStyle(o).display };
    await wait(900);
    const settled = { overlay: getComputedStyle(o).opacity, sheet: getComputedStyle(sheet).opacity };
    return JSON.stringify({ hiddenDisplay, early, settled });
  })()`);
  check('overlay is hidden after a completed close', reopen.hiddenDisplay === 'none', reopen.hiddenDisplay);
  check('re-open is visible again, not stuck at opacity 0',
    parseFloat(reopen.early.overlay) > 0 && parseFloat(reopen.early.sheet) > 0, JSON.stringify(reopen.early));
  check('re-open settles fully opaque',
    parseFloat(reopen.settled.overlay) === 1 && parseFloat(reopen.settled.sheet) === 1, JSON.stringify(reopen.settled));

  console.log('\n5. Drawer is a spring, off-screen at rest, and 1:1 draggable');
  // Drive the drawer test at a phone width, so the mobile media query applies.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await load(BASE + '/rental.html' + AS);
  const dr = await evalJson(`(async () => {
    const sb = document.getElementById('sidebar');
    const ov = document.getElementById('sb-overlay');
    if (!sb) return JSON.stringify({ missing: true });
    // Measure the rendered position, not the inline style: the real question is
    // whether the drawer actually travels on and off screen.
    const restLeft = sb.getBoundingClientRect().left;
    sb.classList.add('open');
    const frames = [];
    for (let i = 0; i < 6; i++) {
      await new Promise(r => requestAnimationFrame(r));
      frames.push(Math.round(sb.getBoundingClientRect().left));
    }
    await new Promise(r=>setTimeout(r,900));
    const openLeft = sb.getBoundingClientRect().left;
    sb.classList.remove('open');
    await new Promise(r=>setTimeout(r,900));
    const closedLeft = sb.getBoundingClientRect().left;
    return JSON.stringify({ restLeft, frames, distinctFrames: new Set(frames).size, openLeft, closedLeft,
      hasScrim: !!ov, hasGesture: typeof window.Motion.gesture === 'function' });
  })()`);
  check('drawer exists and a scrim is wired', !dr.missing && dr.hasScrim, JSON.stringify(dr));
  check('drawer is off-screen at rest', dr.restLeft < 0, 'restLeft=' + dr.restLeft);
  check('drawer animates rather than snapping', dr.distinctFrames >= 3,
    'frames=' + JSON.stringify(dr.frames));
  check('drawer travels to the open edge', Math.abs(dr.openLeft) < 2, 'openLeft=' + dr.openLeft);
  check('drawer returns off-screen when closed', dr.closedLeft < 0, 'closedLeft=' + dr.closedLeft);
  check('gesture engine is available to the drawer', dr.hasGesture === true);
  await send('Emulation.clearDeviceMetricsOverride');

  console.log('\n6. Reduced motion degrades gracefully');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await load(BASE + '/rental.html' + AS);
  const rmd = await evalJson(`(async () => {
    const o = document.querySelector('.overlay');
    o.classList.add('open');
    await new Promise(r=>setTimeout(r,60));
    const sheet = o.querySelector('.modal') || o.firstElementChild;
    return JSON.stringify({ reducedFlag: window.Motion.reduced, disp: getComputedStyle(o).display,
      op: getComputedStyle(sheet).opacity,
      htmlClass: document.documentElement.classList.contains('reduced-motion') });
  })()`);
  check('engine reports reduced motion', rmd.reducedFlag === true && rmd.htmlClass === true, JSON.stringify(rmd));
  check('modal still opens with reduced motion (feedback kept)', rmd.disp === 'flex', 'display=' + rmd.disp);
  check('reduced motion uses a fade, sheet still becomes visible', parseFloat(rmd.op) > 0, 'opacity=' + rmd.op);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

  console.log('\n6b. No horizontal overflow at phone width');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const overflow = [];
  for (const p of ['/rental.html', '/store.html', '/agriculture.html', '/hub.html', '/profile.html', '/admin.html']) {
    await load(BASE + p + AS);
    await sleep(700);
    overflow.push({ page: p, ...(await evalJson(`JSON.stringify({
      inner: window.innerWidth, htmlScroll: document.documentElement.scrollWidth
    })`)) });
  }
  await send('Emulation.clearDeviceMetricsOverride');
  check('no page scrolls horizontally at 390px', overflow.every(o => o.htmlScroll <= o.inner + 1),
    overflow.map(o => o.page + '=' + o.htmlScroll + '/' + o.inner).join(', '));

  console.log('\n7. Materials & typography are applied');
  await load(BASE + '/rental.html' + AS);
  const cs = await evalJson(`(() => {
    const topbar = document.querySelector('.topbar');
    const tc = topbar ? getComputedStyle(topbar) : null;
    const body = getComputedStyle(document.body);
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4'));
    const tracked = headings.filter(h => parseFloat(getComputedStyle(h).letterSpacing) < 0);
    return JSON.stringify({
      topbarBackdrop: tc ? (tc.backdropFilter || tc.webkitBackdropFilter) : null,
      topbarBg: tc ? tc.backgroundColor : null,
      bodyFont: body.fontFamily,
      headingCount: headings.length,
      trackedCount: tracked.length,
      untracked: headings.filter(h => !(parseFloat(getComputedStyle(h).letterSpacing) < 0))
        .map(h => h.tagName + ':' + getComputedStyle(h).letterSpacing),
      hasBlurVar: getComputedStyle(document.documentElement).getPropertyValue('--blur-chrome').trim()
    });
  })()`);
  check('translucent chrome uses backdrop-filter', /blur/.test(cs.topbarBackdrop || ''), 'backdrop=' + cs.topbarBackdrop);
  check('chrome background is translucent (not opaque)', /rgba\(/.test(cs.topbarBg || ''), 'bg=' + cs.topbarBg);
  check('blur token is defined', cs.hasBlurVar.length > 0, '--blur-chrome=' + cs.hasBlurVar);
  check('system font stack is used', /system-ui|-apple-system|Segoe/.test(cs.bodyFont), cs.bodyFont);
  check('every heading carries negative tracking', cs.headingCount > 0 && cs.trackedCount === cs.headingCount,
    cs.trackedCount + '/' + cs.headingCount + ' untracked=' + JSON.stringify(cs.untracked));

  console.log('\n8. Screenshots for visual review');
  fs.mkdirSync(SHOTS, { recursive: true });
  const shots = [
    ['/hub.html', 'hub'], ['/rental.html', 'rental'], ['/store.html', 'store'],
    ['/agriculture.html', 'agriculture'], ['/profile.html', 'profile'], ['/admin.html', 'admin']
  ];
  for (const [url, name] of shots) {
    await load(BASE + url + AS);
    await sleep(1100);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r && r.data) {
      fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
      check('screenshot captured: ' + name, true);
    } else check('screenshot captured: ' + name, false);
  }
  // Clear cookies so "/" renders the login form instead of redirecting onward.
  await send('Network.clearBrowserCookies');
  await load(BASE + '/');
  await sleep(900);
  let r = await send('Page.captureScreenshot', { format: 'png' });
  if (r && r.data) { fs.writeFileSync(path.join(SHOTS, 'login.png'), Buffer.from(r.data, 'base64')); check('screenshot captured: login', true); }
  else check('screenshot captured: login', false);

  // Phone-width shots, to check the drawer and bottom-sheet layouts.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await login('demo', 'demo123');
  await load(BASE + '/rental.html' + AS);
  await sleep(900);
  r = await send('Page.captureScreenshot', { format: 'png' });
  if (r && r.data) { fs.writeFileSync(path.join(SHOTS, 'mobile-rental.png'), Buffer.from(r.data, 'base64')); check('screenshot captured: mobile-rental', true); }
  await evaluate('openSidebar(); true');
  await sleep(140);   // mid-animation, to confirm the travel and material
  r = await send('Page.captureScreenshot', { format: 'png' });
  if (r && r.data) { fs.writeFileSync(path.join(SHOTS, 'mobile-drawer.png'), Buffer.from(r.data, 'base64')); check('screenshot captured: mobile-drawer', true); }
  await send('Emulation.clearDeviceMetricsOverride');

  console.log('\n' + '='.repeat(50));
  console.log(`  ${pass} passed, ${fail} failed`);
  if (consoleErrors.length) console.log('  console errors: ' + consoleErrors.slice(0, 5).join(' | '));
  console.log('='.repeat(50) + '\n');

  ws.close();
  // Kill the whole browser tree, then wait for it to exit so the next run is clean.
  try { chrome.kill(); } catch (e) {}
  try { spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
  await sleep(700);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e.message); process.exit(2); });
