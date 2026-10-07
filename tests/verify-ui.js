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

  console.log('\n1b. The stylesheet under test is the one actually loaded');
  // A cache-first service worker can quietly serve an older shared.css, which
  // would make every visual assertion below measure the wrong build.
  await load(BASE + '/rental.html' + AS);
  const servedCss = await evaluate(`fetch('/shared.css').then(r => r.text()).then(t => t.length)`);
  const liveCss = await evalJson(`(() => {
    const sheets = Array.from(document.styleSheets).filter(s => (s.href || '').includes('shared.css'));
    let accent = null, interactive = null;
    try {
      accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      interactive = getComputedStyle(document.documentElement).getPropertyValue('--interactive').trim();
    } catch (e) {}
    return JSON.stringify({ count: sheets.length, accent, interactive });
  })()`);
  check('exactly one shared.css is loaded', liveCss.count === 1, 'count=' + liveCss.count);
  check('loaded stylesheet is the current build (not a cached one)',
    liveCss.interactive === '#1d1d1f', 'interactive=' + liveCss.interactive + ' servedBytes=' + servedCss);

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
    // 30ms is too tight for a spring's first visible frame, so sample a little
    // further in — the question is whether it recovers at all, not how fast.
    await wait(140);
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
    const px = (el) => parseFloat(getComputedStyle(el).letterSpacing) || 0;

    // Large display/heading type should tighten; small labels should not.
    const large = ['.topbar h2', '.hub-body h2', '.login-logo h1', '.card-head', '.hub-summary-title']
      .map(s => document.querySelector(s)).filter(Boolean);
    const small = ['th', '.metric .label', '.form-row label', '.nav-section', '.metric .sub']
      .map(s => document.querySelector(s)).filter(Boolean);

    const bodyTrack = px(document.body);
    // Whichever display-scale heading this page actually has.
    const displayEl = ['.hub-body h2', '.login-logo h1', '.topbar h2', '.card-head']
      .map(s => document.querySelector(s)).filter(Boolean)[0];

    return JSON.stringify({
      topbarBackdrop: tc ? (tc.backdropFilter || tc.webkitBackdropFilter) : null,
      topbarBg: tc ? tc.backgroundColor : null,
      bodyFont: body.fontFamily,
      bodyColor: body.color,
      bodyTrack: bodyTrack,
      displayTrack: displayEl ? px(displayEl) : null,
      displayEl: displayEl ? displayEl.tagName + '.' + (displayEl.className || '') : null,
      largeTracked: large.filter(el => px(el) < 0).length,
      largeSamples: large.map(el => el.className + '=' + getComputedStyle(el).letterSpacing),
      smallCramped: small.filter(el => px(el) < 0).length,
      smallSamples: small.map(el => el.tagName + '.' + (el.className || '') + '=' + getComputedStyle(el).letterSpacing),
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      interactive: getComputedStyle(document.documentElement).getPropertyValue('--interactive').trim(),
      hasBlurVar: getComputedStyle(document.documentElement).getPropertyValue('--blur-chrome').trim()
    });
  })()`);
  check('translucent chrome uses backdrop-filter', /blur/.test(cs.topbarBackdrop || ''), 'backdrop=' + cs.topbarBackdrop);
  check('chrome background is translucent (not opaque)', /rgba\(/.test(cs.topbarBg || ''), 'bg=' + cs.topbarBg);
  check('blur token is defined', cs.hasBlurVar.length > 0, '--blur-chrome=' + cs.hasBlurVar);
  check('system font stack is used', /system-ui|-apple-system|Segoe/.test(cs.bodyFont), cs.bodyFont);
  // Tracking is size-specific by design: large type tightens, small type does
  // not. Assert both halves, otherwise "all text tightened" would pass while
  // the small labels became cramped and less legible.
  check('large type carries negative tracking', cs.largeTracked >= 2,
    'large tracked=' + cs.largeTracked + ' samples=' + JSON.stringify(cs.largeSamples));
  check('large tracking is tighter than body tracking',
    typeof cs.displayTrack === 'number' && cs.displayTrack < cs.bodyTrack,
    'display=' + cs.displayTrack + ' (' + cs.displayEl + ') body=' + cs.bodyTrack);
  check('small labels are not negatively tracked', cs.smallCramped === 0,
    'cramped=' + JSON.stringify(cs.smallSamples));

  // The "professional" part is restraint: neutral chrome, one action blue, and
  // text that is near-black rather than pure black.
  const rgb = (s) => (String(s).match(/\d+/g) || []).slice(0, 3).map(Number);
  const chromeRgb = rgb(cs.topbarBg);
  const chromeChroma = chromeRgb.length === 3 ? Math.max(...chromeRgb) - Math.min(...chromeRgb) : 999;
  check('chrome is essentially neutral (low chroma)',
    chromeChroma <= 6, 'bg=' + cs.topbarBg + ' chroma=' + chromeChroma);
  check('body text is near-black, not pure black',
    /^#1d1d1f$/i.test(cs.bodyColor) || rgb(cs.bodyColor)[0] <= 40, 'color=' + cs.bodyColor);
  // Action blue differs per theme by design: the light-mode blue carries white
  // text at 4.7:1, and the dark-mode blue is darkened to clear 4.5:1 too.
  check('light theme reserves one action blue',
    cs.accent === '#0071e3', '--accent=' + cs.accent);
  check('interaction colour is neutral, not the accent',
    cs.interactive === '#1d1d1f', '--interactive=' + cs.interactive);

  // Solid marks must stay legible: white-on-white in dark mode is the classic
  // failure when a token like --interactive flips with the theme.
  //
  // Measured from the resolved CSS custom properties rather than from computed
  // element styles: `body` animates its background on theme change, so reading
  // it immediately after flipping the attribute can catch a mid-transition
  // value and produce a bogus contrast number.
  console.log('\n7b. Contrast of text and solid surfaces (both themes)');
  const contrastCheck = async (theme) => evalJson(`(() => {
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme');
    root.setAttribute('data-theme', ${JSON.stringify(theme)});
    const tok = (name) => getComputedStyle(root).getPropertyValue(name).trim();

    // Custom properties resolve to hex (or a keyword), while computed styles
    // give rgb(). Parse both, normalising 3-digit hex.
    const toRgb = (c) => {
      c = String(c).trim();
      if (c === 'transparent') return null;
      if (c[0] === '#') {
        let h = c.slice(1);
        if (h.length === 3) h = h.split('').map(x => x + x).join('');
        return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
      }
      const m = c.match(/-?[\\d.]+/g);
      return m ? m.slice(0,3).map(Number) : null;
    };
    const lum = (c) => {
      const rgb = toRgb(c);
      if (!rgb) return null;
      const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => {
      const la = lum(a), lb = lum(b);
      if (la == null || lb == null) return null;
      const [hi, lo] = [la, lb].sort((x, y) => y - x);
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    };

    const pairs = [
      ['body text on page', tok('--text'), tok('--bg')],
      ['muted text on surface', tok('--muted'), tok('--surface')],
      ['metric number on surface', tok('--text'), tok('--surface')],
      ['solid mark', tok('--on-solid'), tok('--solid')],
      ['chat header label', tok('--on-solid'), tok('--solid')],
      ['primary button label', '#ffffff', tok('--accent')],
      ['paid badge', tok('--green'), tok('--green-bg')],
      ['unpaid badge', tok('--red'), tok('--red-bg')],
      ['partial badge', tok('--amber'), tok('--amber-bg')]
    ];
    const out = pairs.map(([label, fg, bg]) => ({ label, fg, bg, ratio: ratio(fg, bg) }));
    root.setAttribute('data-theme', prev || 'light');
    return JSON.stringify(out);
  })()`);

  for (const theme of ['light', 'dark']) {
    const results = await contrastCheck(theme);
    const failures = results.filter(r => r.ratio < 4.5);
    // 3:1 is the WCAG non-text/large-text floor; everything here is body-sized.
    check(`${theme} theme: all colour pairs meet 4.5:1`, failures.length === 0,
      failures.map(f => `${f.label} ${f.ratio} (${f.fg} on ${f.bg})`).join(' | ') ||
      'worst=' + Math.min(...results.map(r => r.ratio)));
  }
  await evaluate(`document.documentElement.setAttribute('data-theme','light'); true`);

  console.log('\n7c. Charts render with the design-system palette');
  // Chart.js paints to a canvas so it cannot read CSS variables; the palette is
  // mirrored in js as CHART. Verify it resolves (a mis-quoted template literal
  // would silently pass the string "${CHART.accent}" to Chart.js).
  await load(BASE + '/hub.html' + AS);
  const charts = await evalJson(`(async () => {
    await new Promise(r => setTimeout(r, 1200));
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const painted = canvases.filter(c => c.width > 0 && c.height > 0);
    return JSON.stringify({
      palette: typeof CHART === 'object' ? CHART : null,
      canvases: canvases.length,
      painted: painted.length,
      brokenStrings: canvases.filter(c => {
        const inst = (window.Chart && Chart.getChart) ? Chart.getChart(c) : null;
        if (!inst) return false;
        return JSON.stringify(inst.data.datasets).includes('CHART.');
      }).length
    });
  })()`);
  check('chart palette is exposed to the pages',
    charts.palette && charts.palette.accent === '#0071e3' && charts.palette.green === '#187e43',
    JSON.stringify(charts.palette));
  check('charts actually painted', charts.canvases > 0 && charts.painted === charts.canvases,
    charts.painted + '/' + charts.canvases + ' canvases painted');
  check('no unresolved palette placeholders reached Chart.js',
    charts.brokenStrings === 0, 'broken=' + charts.brokenStrings);

  console.log('\n8. Screenshots for visual review');
  fs.mkdirSync(SHOTS, { recursive: true });
  // The app registers a cache-first service worker. A reused browser profile
  // would serve a stale stylesheet, so unregister it and drop the caches before
  // capturing — otherwise review shots can show the previous design.
  await evaluate(`(async () => {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } catch (e) {}
    return true;
  })()`);
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

  // Dark theme, since the palette is defined separately and can drift.
  // Re-authenticate first: the cookie clear above killed the session, and a
  // screenshot of the login page would not tell us anything about the theme.
  await login('demo', 'demo123');
  await load(BASE + '/rental.html' + AS);
  await evaluate(`applyTheme('dark'); true`);
  await sleep(1000);
  const darkUrl = await evaluate(`location.pathname`);
  r = await send('Page.captureScreenshot', { format: 'png' });
  if (r && r.data) { fs.writeFileSync(path.join(SHOTS, 'dark-rental.png'), Buffer.from(r.data, 'base64')); check('screenshot captured: dark-rental', true); }
  check('dark screenshot is the rental page, not a redirect',
    darkUrl === '/rental.html', 'path=' + darkUrl);
  await evaluate(`applyTheme('light'); true`);
  await load(BASE + '/rental.html' + AS);

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
