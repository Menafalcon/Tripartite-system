/* ── SHARED JS — Tripartite System ── */
const API = '/api';
const THEMES = [{id:'light',icon:'fa-sun'},{id:'dark',icon:'fa-moon'}];
const AI_HISTORY_KEY = 'tripartite_ai_history';
let currentUser = null;

// ── CHART PALETTE ─────────────────────────────────────────────────────────────
// Chart.js renders to a canvas, so it cannot read CSS custom properties. These
// mirror the tokens in shared.css; keeping them in one place means the charts
// stay in step with the palette instead of drifting into their own scheme.
const CHART = {
  accent:   '#0071e3',   // --accent  (actions, primary series)
  green:    '#187e43',   // --green   (paid, profit)
  red:      '#d70015',   // --red     (unpaid, costs)
  amber:    '#b25000',   // --amber   (partial, secondary series)
  purple:   '#5e5ce6',   // --purple
  teal:     '#0a6a7a',
  costs:    'rgba(215,0,21,.55)'
};

// ── THEME ─────────────────────────────────────────────────────────────────────
// Note: the initial theme is set by a tiny inline <script> in each page's <head>
// (before first paint) to avoid a light->dark flash. applyTheme handles changes.
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active-theme', b.dataset.theme === t));
  document.dispatchEvent(new CustomEvent('themechange', { detail: t }));
}

function buildThemeButtons(containerId) {
  const c = document.getElementById(containerId); if (!c) return;
  c.innerHTML = THEMES.map(t => `<button class="theme-btn" data-theme="${t.id}" title="${t.id}" onclick="applyTheme('${t.id}')"><i class="fa-solid ${t.icon}"></i></button>`).join('');
  const cur = localStorage.getItem('theme') || 'light';
  c.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active-theme', b.dataset.theme === cur));
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
async function checkAuth(adminAllowed, nonAdminAllowed) {
  try {
    const r = await fetch(`${API}/me`, { credentials: 'include' });
    if (!r.ok) { window.location.href = '/'; return null; }
    const u = await r.json();
    currentUser = u;
    syncNimKey(u);
    if (u.is_superadmin && nonAdminAllowed === false) {
      window.location.href = '/hub.html'; return null;
    }
    if (!u.is_superadmin && adminAllowed === false) {
      window.location.href = '/hub.html'; return null;
    }
    return u;
  } catch(e) { window.location.href = '/'; return null; }
}

async function doLogout() {
  sessionStorage.removeItem(AI_HISTORY_KEY);
  await fetch(`${API}/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
  window.location.href = '/';
}

// ── NIM API KEY (tied to the account, server-side) ─────────────────────────────
function getNimApiKey() { return localStorage.getItem('nim_api_key') || ''; }

// Mirror the account's stored key into localStorage so all client code keeps
// working; if the device has a key but the account doesn't, migrate it up.
function syncNimKey(u) {
  try {
    if (u && u.nim_api_key) {
      localStorage.setItem('nim_api_key', u.nim_api_key);
    } else {
      const localKey = localStorage.getItem('nim_api_key');
      if (localKey) fetch(`${API}/nim-key`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: localKey })
      }).catch(() => {});
    }
  } catch(e) {}
}

// ── AI HISTORY ────────────────────────────────────────────────────────────────
const INITIAL_AI_MSG = { role: 'assistant', content: "Hello! I'm your AI assistant powered by NVIDIA NIM. I can help with your properties, store analysis, farming advice, or anything else. How can I help?" };

function getAiHistory() {
  const s = sessionStorage.getItem(AI_HISTORY_KEY);
  return s ? JSON.parse(s) : [INITIAL_AI_MSG];
}

function saveAiHistory(h) { sessionStorage.setItem(AI_HISTORY_KEY, JSON.stringify(h)); }

function clearAiHistory() {
  const h = [INITIAL_AI_MSG];
  sessionStorage.setItem(AI_HISTORY_KEY, JSON.stringify(h));
  return h;
}

// ── AI BUBBLE ─────────────────────────────────────────────────────────────────
function injectAiBubble() {
  const html = `
  <button class="ai-bubble-btn" id="ai-bubble-btn" onclick="toggleAiBubble()" title="AI Assistant">
    <i class="fa-solid fa-robot"></i>
  </button>
  <div class="ai-bubble-panel" id="ai-bubble-panel">
    <div class="ai-bubble-head">
      <span><i class="fa-solid fa-robot"></i> AI Assistant</span>
      <div class="ai-bubble-head-btns">
        <button onclick="clearAiBubbleHistory()" title="Clear history"><i class="fa-solid fa-trash"></i></button>
        <button onclick="window.location.href='/ai.html'" title="Open full view"><i class="fa-solid fa-expand"></i></button>
        <button onclick="toggleAiBubble()" title="Close"><i class="fa-solid fa-xmark"></i></button>
      </div>
    </div>
    <div id="ai-no-key-bubble" class="ai-no-key" style="display:none">
      <i class="fa-solid fa-key"></i> Set your NVIDIA NIM API key in <a href="/profile.html" style="color:inherit;font-weight:700">Profile</a>
    </div>
    <div class="ai-bubble-msgs" id="ai-bubble-msgs"></div>
    <div class="ai-bubble-input">
      <textarea id="ai-bubble-textarea" rows="1" placeholder="Ask anything… (Enter to send)" onkeydown="aiBubbleKeydown(event)"></textarea>
      <button onclick="sendAiBubbleMessage()"><i class="fa-solid fa-paper-plane"></i></button>
    </div>
  </div>`;
  const d = document.createElement('div');
  d.innerHTML = html;
  document.body.appendChild(d.firstElementChild);
  document.body.appendChild(d.lastElementChild);
  renderAiBubbleMsgs();
  if (typeof resumeAiBubbleIfPending === 'function') resumeAiBubbleIfPending();
}

function toggleAiBubble() {
  const p = document.getElementById('ai-bubble-panel');
  if (!p) return;
  const open = p.classList.toggle('open');
  clearTimeout(p.__hideTimer);

  if (window.Motion) {
    // §7 — anchored to its trigger (transform-origin is bottom-right in CSS), so
    // the panel visibly grows out of the button that opened it.
    if (open) {
      if (!p.__entryPose) {
        p.__entryPose = { opacity: 0, scale: 0.92, y: 12 };
        seedPose(p, p.__entryPose);
      }
      Motion.spring(p, { opacity: 1, scale: 1, y: 0 }, { damping: 1, response: 0.3 });
      renderAiBubbleMsgs();
      setTimeout(() => document.getElementById('ai-bubble-textarea')?.focus(), 120);
    } else {
      Motion.spring(p, { opacity: 0, scale: 0.96, y: 8 }, {
        damping: 1, response: 0.24,
        onComplete: () => { if (!p.classList.contains('open')) p.style.display = 'none'; }
      });
      p.__hideTimer = setTimeout(() => { if (!p.classList.contains('open')) p.style.display = 'none'; }, 600);
    }
  } else if (open) {
    renderAiBubbleMsgs();
    setTimeout(() => document.getElementById('ai-bubble-textarea')?.focus(), 100);
  }
}

function renderAiBubbleMsgs() {
  const box = document.getElementById('ai-bubble-msgs'); if (!box) return;
  const hist = getAiHistory();
  box.innerHTML = hist.map(m => `<div class="ai-bubble-msg ${m.role === 'user' ? 'user' : 'bot'}">${escHtml(m.content)}</div>`).join('');
  if (window._aiPending) {
    const t = document.createElement('div'); t.className = 'ai-bubble-msg bot';
    t.innerHTML = '<div class="ai-bubble-typing"><span></span><span></span><span></span></div>';
    box.appendChild(t);
  }
  box.scrollTop = box.scrollHeight;
  const noKey = document.getElementById('ai-no-key-bubble');
  if (noKey) noKey.style.display = getNimApiKey() ? 'none' : 'block';
}

function clearAiBubbleHistory() {
  clearAiHistory();
  renderAiBubbleMsgs();
  const fullPage = document.getElementById('ai-messages');
  if (fullPage) renderAiPageMsgs && renderAiPageMsgs();
}

function aiBubbleKeydown(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAiBubbleMessage(); } }

// Runs (or resumes) the AI request; pending payload kept in sessionStorage so a
// reply survives navigating to another page mid-answer.
function runAiBubbleRequest(messagesForApi, nimKey) {
  window._aiPending = true;
  sessionStorage.setItem('tri_ai_pending', JSON.stringify({ messages: messagesForApi, key: nimKey }));
  renderAiBubbleMsgs();
  fetch(`${API}/ai/chat`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: messagesForApi, api_key: nimKey })
  }).then(async r => {
    const d = await r.json();
    const rawReply = r.ok ? (d.reply || '(no response)') : ('⚠ ' + (d.error || `Error ${r.status}`));
    const { text: cleanText, action } = parseAiResponse(rawReply);
    const h2 = getAiHistory(); h2.push({ role: 'assistant', content: cleanText }); saveAiHistory(h2);
    window._aiPending = false; sessionStorage.removeItem('tri_ai_pending'); renderAiBubbleMsgs();
    if (action) { const box = document.getElementById('ai-bubble-msgs'); if (box) renderActionCard(action, box, 'xs'); }
  }).catch(() => {
    const h2 = getAiHistory(); h2.push({ role: 'assistant', content: '⚠ Could not reach AI. Check your connection.' }); saveAiHistory(h2);
    window._aiPending = false; sessionStorage.removeItem('tri_ai_pending'); renderAiBubbleMsgs();
  });
}

function resumeAiBubbleIfPending() {
  const p = sessionStorage.getItem('tri_ai_pending'); if (!p) return;
  let obj; try { obj = JSON.parse(p); } catch (e) { sessionStorage.removeItem('tri_ai_pending'); return; }
  const hist = getAiHistory(); const last = hist[hist.length - 1];
  if (obj && obj.messages && last && last.role === 'user') runAiBubbleRequest(obj.messages, obj.key);
  else sessionStorage.removeItem('tri_ai_pending');
}

async function sendAiBubbleMessage() {
  const ta = document.getElementById('ai-bubble-textarea');
  const text = ta.value.trim(); if (!text) return;
  const nimKey = getNimApiKey();
  const noKey = document.getElementById('ai-no-key-bubble');
  if (!nimKey) { if (noKey) noKey.style.display = 'block'; return; }
  if (noKey) noKey.style.display = 'none';
  ta.value = '';
  const hist = getAiHistory();
  hist.push({ role: 'user', content: text });
  saveAiHistory(hist);
  window._aiPending = true;
  renderAiBubbleMsgs();
  const ctx = await getAiContext();
  const messagesForApi = [
    { role: 'system', content: ctx },
    ...getAiHistory().filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }))
  ];
  runAiBubbleRequest(messagesForApi, nimKey);
}

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
function initNotifications() {
  if (!document.getElementById('toast-container')) {
    const tc = document.createElement('div');
    tc.id = 'toast-container'; tc.className = 'toast-container';
    document.body.appendChild(tc);
  }
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

/* ── MOTION HELPERS ─────────────────────────────────────────────────────────── */

// Put an element into its entry pose *before* springing it to rest. Setting the
// inline transform directly means Motion's live-value reader picks the pose up
// as the starting point, so the spring travels from it instead of snapping to 0.
function seedPose(el, pose) {
  var parts = [];
  if (pose.x) parts.push('translate3d(' + pose.x + 'px,0,0)');
  if (pose.y) parts.push('translate3d(0,' + pose.y + 'px,0)');
  if (pose.scale != null) parts.push('scale(' + pose.scale + ')');
  el.style.transform = parts.join(' ');
  if (pose.opacity != null) el.style.opacity = String(pose.opacity);
}

function showToast(title, body, type) {
  let tc = document.getElementById('toast-container');
  if (!tc) { tc = document.createElement('div'); tc.id='toast-container'; tc.className='toast-container'; document.body.appendChild(tc); }
  const t = document.createElement('div');
  t.className = `toast ${type||'info'}`;
  t.innerHTML = `<div class="toast-title">${escHtml(title)}</div>${body?`<div class="toast-body">${escHtml(body)}</div>`:''}<button class="toast-close" onclick="this.parentElement.remove()">×</button>`;
  tc.appendChild(t);

  // Arrive from the edge it lives on, with a little momentum: a toast that
  // slides in and settles reads as an object arriving, not a repaint (§4, §12).
  if (window.Motion) {
    seedPose(t, { x: 22, opacity: 0 });
    Motion.spring(t, { opacity: 1, x: 0, scale: 1 }, { damping: 1, response: 0.3 });
  } else {
    t.classList.add('show');
  }

  // Auto-dismiss. Exit along the same path, so it leaves where it came from.
  setTimeout(() => {
    if (window.Motion) {
      Motion.spring(t, { opacity: 0, x: 20, scale: 0.98 }, {
        damping: 1, response: 0.24, onComplete: () => t.remove()
      });
      setTimeout(() => t.remove(), 600);   // safety net
    } else {
      t.classList.remove('show'); setTimeout(() => t.remove(), 300);
    }
  }, 6000);
}

function showAppNotif(title, body, type) {
  const key = `notif_${title}_${body}`.replace(/\W+/g,'_').slice(0,90);
  if (Date.now() - (parseInt(localStorage.getItem(key))||0) < 24*3600*1000) return;
  localStorage.setItem(key, Date.now().toString());
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/icon-192.png' });
  } else {
    showToast(title, body, type||'info');
  }
}

function checkRentalNotifs(units) {
  if (!units) return;
  const unpaid = units.filter(u => !u.is_vacant && u.rent_status === 'unpaid');
  if (unpaid.length > 0) showAppNotif('Unpaid Rent', `${unpaid.length} unit${unpaid.length>1?'s':''}  ${unpaid.length>1?'have':'has'} unpaid rent.`, 'warn');
  units.filter(u => !u.is_vacant && u.rent_status === 'partial').forEach(u =>
    showAppNotif('Partial Payment', `${u.fname} ${u.lname} (${u.prop_id}) has only made a partial payment.`, 'warn')
  );
}

function checkStoreNotifs(items) {
  if (!items) return;
  items.filter(i => i.quantity === 1).forEach(i =>
    showAppNotif('Low Stock', `"${i.name}" has only 1 item left in stock.`, 'warn')
  );
  items.filter(i => i.quantity === 0).forEach(i =>
    showAppNotif('Out of Stock', `"${i.name}" is out of stock.`, 'error')
  );
}

function checkProfitNotifs(rentalNet, storeProfit, farmProfit) {
  const total = rentalNet + storeProfit + farmProfit;
  if (total < 0) showAppNotif('Negative Profit', `Overall profit is ${total.toFixed(1)} DT. Check your expenses.`, 'error');
}

// ── UTILITIES ─────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDT(n) { return (parseFloat(n) || 0).toFixed(1); }

function badgeHtml(s) {
  return `<span class="badge ${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</span>`;
}

function closeModal(id) { closeOverlay(document.getElementById(id)); }

/* ── OVERLAY / SHEET MOTION (§3 interruptibility, §7 symmetric paths) ──────────
   Pages open modals with `el.classList.add('open')`, which can't be interrupted
   and pops in with no relationship to where it came from. Rather than edit every
   call site, the class itself is routed through this motion layer, so all 15
   existing open/close calls gain sprung, interruptible motion for free.

   Movement is transform + opacity only (compositor-friendly, §11). A grab
   mid-flight re-targets from the element's *live* transform, so reversing a
   closing sheet continues from where it is instead of jumping. */
var OVERLAY_DUR = 260;

function patchClassMotion(el, onAdd, onRemove) {
  if (!el || el.__motionPatched) return;
  el.__motionPatched = true;
  var cl = el.classList;
  [['add', onAdd], ['remove', onRemove]].forEach(function (pair) {
    var method = pair[0], handler = pair[1];
    var original = cl[method].bind(cl);
    cl[method] = function () {
      var had = cl.contains('open');
      var args = Array.prototype.slice.call(arguments);
      original.apply(null, args);
      if (handler && args.indexOf('open') !== -1 && had !== cl.contains('open')) handler(el);
    };
  });
}

function sheetTarget(el) { return el.querySelector('.modal') || el.firstElementChild; }

function showOverlay(el) {
  if (!el) return;
  clearTimeout(el.__hideTimer);
  el.classList.add('open');
  el.style.display = 'flex';
  var sheet = sheetTarget(el);
  if (!sheet || !window.Motion) return;
  // Originate from near the trigger rather than the centre, so the spatial
  // relationship between what was tapped and what appeared is obvious (§7).
  sheet.style.transformOrigin = el.dataset.origin || 'center';

  // Seed the entry pose so the spring has somewhere to travel *from*; then
  // animate to rest. On a reopen this is skipped, so a sheet grabbed mid-exit
  // resumes from its live transform instead of jumping back to the pose (§3).
  var from = el.dataset.sheetFrom || 'up';
  if (!sheet.__entryPose) {
    sheet.__entryPose = { opacity: 0, scale: 0.96 };
    if (from === 'up') sheet.__entryPose.y = 26;
    else if (from === 'down') sheet.__entryPose.y = -26;
    else if (from === 'left') sheet.__entryPose.x = -26;
    else if (from === 'right') sheet.__entryPose.x = 26;
    seedPose(sheet, sheet.__entryPose);
    el.style.opacity = '0';
    // Animate from the pose to rest as one continuous motion. Passing the pose
    // as `initial` makes it the spring's authoritative starting value, so it is
    // never re-derived from a DOM read that lands before the first paint.
    Motion.spring(sheet, { opacity: 1, scale: 1, y: 0, x: 0 },
      { damping: 1, response: 0.32, initial: { x: 0, y: 0, scale: 0.96 } });
    Motion.spring(el, { opacity: 1 }, { damping: 1, response: 0.3 });
    return;
  }

  // Fade the scrim in alongside the material so they read as one arrival.
  Motion.spring(el, { opacity: 1 }, { damping: 1, response: 0.3 });
  // "Materialize, don't just fade" (§12): scale, offset and opacity travel
  // together, so the surface reads as a real material arriving.
  Motion.spring(sheet, { opacity: 1, scale: 1, y: 0, x: 0 }, { damping: 1, response: 0.32 });
}

function hideOverlay(el) {
  if (!el) return;
  var sheet = sheetTarget(el);
  if (!sheet || !window.Motion) { el.style.display = 'none'; return; }
  clearTimeout(el.__hideTimer);
  var from = el.dataset.sheetFrom || 'up';
  // Exit along the same path it entered (§7) — in from the right dismisses to
  // the right, a bottom sheet dismisses back down.
  var to = { opacity: 0, scale: 0.985 };
  if (from === 'up') to.y = 18;
  else if (from === 'down') to.y = -18;
  else if (from === 'left') to.x = -18;
  else if (from === 'right') to.x = 18;

  Motion.spring(el, { opacity: 0 }, { damping: 1, response: 0.25 });
  Motion.spring(sheet, to, {
    damping: 1, response: 0.26,
    onComplete: function () {
      if (el.classList.contains('open')) return;   // reopened mid-flight
      el.style.display = 'none';
    }
  });
  // Safety net if the spring callback never lands (e.g. element detached).
  el.__hideTimer = setTimeout(function () {
    if (!el.classList.contains('open')) el.style.display = 'none';
  }, OVERLAY_DUR + 240);
}

function openOverlay(el) { showOverlay(el); }
function closeOverlay(el) { if (el) el.classList.remove('open'); }

function refreshOverlays() {
  document.querySelectorAll('.overlay').forEach(function (el) {
    patchClassMotion(el, showOverlay, hideOverlay);
    var open = el.classList.contains('open');
    el.style.display = open ? 'flex' : 'none';
    if (!window.Motion) return;
    var sheet = sheetTarget(el);
    if (open) {
      Motion.stop(sheet);
      sheet.style.opacity = '1'; sheet.style.transform = 'none';
      el.style.opacity = '1';
    }
  });
}

/* Entry poses are applied on first open; nothing animates until then, so there
   is no flash of a half-positioned sheet on load. */
function setupOverlayClose() {
  refreshOverlays();
  document.querySelectorAll('.overlay').forEach(function (o) {
    o.addEventListener('click', function (e) {
      if (e.target === this) closeOverlay(this);
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var open = document.querySelector('.overlay.open');
    if (open) closeOverlay(open);
  });
  // Bootstrapped from here because every app page already calls this.
  setupSidebarSpring();
  setupScrollEdges();
  if (window.Motion) Motion.attachScrollEdges(document);
  // Keep the drawer honest across a resize/rotate.
  window.addEventListener('resize', function () {
    if (!window.Motion) return;
    var sb = document.getElementById('sidebar');
    if (!sb) return;
    if (!isMobileNav()) {
      Motion.stop(sb); sb.style.transform = 'none';
      var ov = document.getElementById('sb-overlay');
      if (ov) { ov.style.opacity = ''; Motion.stop(ov); }
    }
  });
}

// ── LOCAL-FIRST DATA (offline-capable) ──────────────────────────────────────────
// All three domains are mirrored in localStorage so reads work offline. Writes go
// to the server when online; when offline they apply locally + queue for sync.
const DOMAIN_PATH = { units: '/units', store: '/store/items', farms: '/farms' };
const SYNC_QUEUE_KEY = 'tri_sync_queue';
let _tmpSeq = -1;  // temp ids for offline-created records (negative => never clash)

function dataGet(domain) { try { return JSON.parse(localStorage.getItem('tri_data_' + domain) || '[]'); } catch(e) { return []; } }
function dataSet(domain, arr) { localStorage.setItem('tri_data_' + domain, JSON.stringify(arr || [])); }
function syncQueue() { try { return JSON.parse(localStorage.getItem(SYNC_QUEUE_KEY) || '[]'); } catch(e) { return []; } }
function setSyncQueue(q) { localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(q)); updateSyncUI(); }
function enqueueOp(op) { const q = syncQueue(); q.push(op); setSyncQueue(q); }

function updateSyncUI() {
  const off = document.getElementById('offline-badge');
  if (off) off.classList.toggle('show', !navigator.onLine);
  const sb = document.getElementById('sync-badge');
  if (sb) sb.classList.toggle('show', navigator.onLine && syncQueue().length > 0);
}

// Pull fresh data from the server into the local store (online only)
async function dataPull() {
  for (const d of Object.keys(DOMAIN_PATH)) {
    try { const r = await fetch(`${API}${DOMAIN_PATH[d]}`, { credentials: 'include' }); if (r.ok) dataSet(d, await r.json()); }
    catch(e) {}
  }
}

// Flush the offline queue, then refresh local data. Fires 'datachanged' on success.
async function dataSync() {
  if (!navigator.onLine) { updateSyncUI(); return false; }
  try {
    const q = syncQueue();
    if (q.length) {
      const r = await fetch(`${API}/sync`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops: q }) });
      if (!r.ok) return false;
      const d = await r.json();
      if (d.units)       dataSet('units', d.units);
      if (d.store_items) dataSet('store', d.store_items);
      if (d.farms)       dataSet('farms', d.farms);
      setSyncQueue([]);
    } else {
      await dataPull();
    }
    updateSyncUI();
    document.dispatchEvent(new CustomEvent('datachanged'));
    return true;
  } catch(e) { return false; }
}

async function dataCreate(domain, rec) {
  if (navigator.onLine) {
    try {
      const r = await fetch(`${API}${DOMAIN_PATH[domain]}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec) });
      if (r.ok) { const saved = await r.json(); const a = dataGet(domain); a.push(saved); dataSet(domain, a); return saved; }
    } catch(e) {}
  }
  const tmp = { ...rec, id: _tmpSeq-- };
  if (domain === 'store' && !tmp.sales) tmp.sales = [];
  if (domain === 'units' && !tmp.documents) tmp.documents = [];
  if (domain === 'farms') { tmp.workers = tmp.workers || []; tmp.harvest_projections = tmp.harvest_projections || []; }
  const a = dataGet(domain); a.push(tmp); dataSet(domain, a);
  enqueueOp({ domain, action: 'create', client_id: tmp.id, data: rec });
  return tmp;
}

async function dataUpdate(domain, id, rec) {
  if (navigator.onLine) {
    try {
      const r = await fetch(`${API}${DOMAIN_PATH[domain]}/${id}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec) });
      if (r.ok) { const saved = await r.json(); dataSet(domain, dataGet(domain).map(x => x.id === id ? saved : x)); return saved; }
    } catch(e) {}
  }
  dataSet(domain, dataGet(domain).map(x => x.id === id ? { ...x, ...rec, id } : x));
  enqueueOp({ domain, action: 'update', id, data: rec });
  return { ...rec, id };
}

async function dataDelete(domain, id) {
  if (navigator.onLine) {
    try { const r = await fetch(`${API}${DOMAIN_PATH[domain]}/${id}`, { method: 'DELETE', credentials: 'include' }); if (r.ok) { dataSet(domain, dataGet(domain).filter(x => x.id !== id)); return true; } } catch(e) {}
  }
  dataSet(domain, dataGet(domain).filter(x => x.id !== id));
  enqueueOp({ domain, action: 'delete', id });
  return true;
}

async function dataSell(itemId, saleData) {
  if (navigator.onLine) {
    try {
      const r = await fetch(`${API}/store/items/${itemId}/sell`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(saleData) });
      if (r.ok) { const res = await r.json(); if (res.item) dataSet('store', dataGet('store').map(x => x.id === itemId ? res.item : x)); return { ok: true }; }
      const e = await r.json().catch(() => ({})); return { ok: false, error: e.error || 'Error' };
    } catch(e) {}
  }
  const arr = dataGet('store'); const item = arr.find(x => x.id === itemId);
  if (!item) return { ok: false, error: 'Item not found' };
  const qty = parseInt(saleData.quantity) || 1;
  if ((item.quantity || 0) < qty) return { ok: false, error: 'Not enough stock' };
  const disc = Math.max(0, Math.min(100, parseFloat(saleData.discount_pct) || 0));
  const total = +(item.sell_price * qty * (1 - disc / 100)).toFixed(2);
  const paid = parseFloat(saleData.amount_paid) || 0;
  item.quantity -= qty;
  item.sales = item.sales || [];
  item.sales.push({ id: 'tmp' + Date.now(), quantity: qty, total_price: total, discount_pct: disc, amount_paid: paid,
    remaining: Math.max(0, total - paid), status: paid >= total ? 'sold' : 'installments',
    buyer_fname: saleData.buyer_fname || '', buyer_lname: saleData.buyer_lname || '',
    buyer_cin: saleData.buyer_cin || '', buyer_phone: saleData.buyer_phone || '',
    date: new Date().toISOString(), receipt: null,
    payments: paid > 0 ? [{ amount: paid, date: new Date().toISOString() }] : [] });
  dataSet('store', arr);
  enqueueOp({ domain: 'store', action: 'sell', id: itemId, data: saleData });
  return { ok: true };
}

function setupOfflineSync() {
  updateSyncUI();
  window.addEventListener('offline', updateSyncUI);
  window.addEventListener('online', () => { updateSyncUI(); dataSync(); });
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data && e.data.type === 'TRIGGER_SYNC') dataSync();
    });
  }
}

// ── PWA / OFFLINE ─────────────────────────────────────────────────────────────
function setupPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      // When a new SW is waiting, tell it to activate immediately
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller)
            sw.postMessage({ type: 'SKIP_WAITING' });
        });
      });
    }).catch(() => {});
    // When reconnecting, ask the SW to wake clients to flush the queue
    window.addEventListener('online', () => {
      navigator.serviceWorker.ready.then(reg =>
        reg.sync?.register('flush-offline-queue').catch(() => {})
      );
    });
  }
  setupOfflineSync();
  initNotifications();
  // Capture the install prompt so the Profile → Install App button can trigger it.
  // (No floating button — install lives only in Profile settings.)
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    window.pwaInstallPrompt = e;
    localStorage.removeItem('pwa_installed');  // installable => not currently installed
    document.dispatchEvent(new CustomEvent('pwa-installable'));
  });
  window.addEventListener('appinstalled', () => {
    window.pwaInstallPrompt = null;
    localStorage.setItem('pwa_installed', '1');
    document.dispatchEvent(new CustomEvent('pwa-installed'));
  });
}

// ── MOBILE SIDEBAR (§2 1:1 tracking · §5 velocity handoff · §6 momentum) ──────
// The drawer is driven by a spring rather than a CSS transition so it can be
// grabbed and reversed mid-flight, and so a flick carries its momentum.
var _sbDrag = null;

// 800px matches the stylesheet breakpoint — one source of truth for "drawer mode".
function isMobileNav() { return window.innerWidth <= 800; }

function sidebarTravel() {
  var sb = document.getElementById('sidebar');
  return (sb && sb.offsetWidth) || 285;
}

function sidebarOffset() {
  var sb = document.getElementById('sidebar');
  if (!sb) return 0;
  if (!window.Motion) return sb.classList.contains('open') ? 0 : -sidebarTravel();
  // "open" is the source of truth for intent; the live value comes from the
  // record so an interrupted drag resumes exactly where it was left.
  return sb.classList.contains('open') ? 0 : -sidebarTravel();
}

function setScrim(visible, opacity) {
  var ov = document.getElementById('sb-overlay');
  if (!ov) return;
  if (visible) ov.classList.add('show');
  if (!window.Motion) { ov.style.opacity = opacity; return; }
  Motion.spring(ov, { opacity: opacity }, { damping: 1, response: 0.3 });
  if (!visible) {
    clearTimeout(ov.__scrimTimer);
    ov.__scrimTimer = setTimeout(function () {
      if (sidebarOffset() < -sidebarTravel() + 1) ov.classList.remove('show');
    }, 320);
  }
}

// Animate the drawer, optionally continuing at the finger's release velocity so
// there is no seam between dragging and animating (§5).
var _sbDriving = false, _sbDragging = false;

function applySidebar(open, momentum, velocity) {
  var sb = document.getElementById('sidebar');
  if (!sb) return;
  var travel = sidebarTravel();
  // Mark that this change is ours, so the class observer doesn't re-enter.
  _sbDriving = true;
  if (open) sb.classList.add('open'); else sb.classList.remove('open');
  setTimeout(function () { _sbDriving = false; }, 0);

  if (!window.Motion) {
    setScrim(open, open ? 1 : 0);
    return;
  }

  if (isMobileNav()) {
    var opts = { damping: 1, response: 0.32 };
    // Only a gesture that actually carried momentum earns overshoot (§4).
    if (momentum) { opts.damping = 0.8; opts.response = 0.3; }
    if (velocity) opts.velocity = { x: velocity };
    Motion.spring(sb, { x: open ? 0 : -travel }, opts);
    setScrim(open, open ? 1 : 0);
  } else {
    // Desktop: no transform at all — the sidebar is in normal flow.
    Motion.stop(sb);
    sb.style.transform = 'none';
    setScrim(false, 0);
  }
}

function openSidebar() { applySidebar(true, false, 0); }
function closeSidebar() {
  // While a drag owns the drawer, let its release handler settle it — animating
  // underneath an active gesture would fight the finger (§3).
  if (_sbDrag && _sbDrag.active) return;
  applySidebar(false, false, 0);
}

function setupSidebarSpring() {
  var sb = document.getElementById('sidebar');
  if (!sb || !window.Motion) return;
  var travel = sidebarTravel();

  // Park the drawer off-screen explicitly and tell the engine that this is the
  // current value, so the first open travels from -width instead of jumping.
  if (isMobileNav() && !sb.classList.contains('open')) {
    sb.style.transform = 'translate3d(' + (-travel) + 'px,0,0)';
    Motion.spring(sb, { x: -travel }, { damping: 1, response: 0.001, initial: { x: -travel } });
  }

  // Keep the drawer in sync with its `open` class however that class is set
  // (inline handler, page code, or openSidebar), so intent and motion can't
  // drift apart. applySidebar toggles that same class, so guard re-entrancy.
  var lastOpen = sb.classList.contains('open');
  new MutationObserver(function () {
    var now = sb.classList.contains('open');
    if (now === lastOpen || _sbDriving) { lastOpen = now; return; }
    lastOpen = now;
    if (_sbDragging) return;           // a live drag owns the drawer
    applySidebar(now, false, 0);
  }).observe(sb, { attributes: true, attributeFilter: ['class'] });

  var scrim = document.getElementById('sb-overlay');
  if (scrim && !scrim.__motionPatched) {
    scrim.addEventListener('click', closeSidebar);
    // Let the scrim be dragged away too: press anywhere on it and pull. The
    // drawer intent lives in the `open` class, so no extra bookkeeping is needed.
    Motion.gesture(scrim, {
      axis: 'x',
      dimension: travel,
      bounds: [-travel, 0],
      onDrag: function (x) {
        Motion.stop(sb);
        sb.style.transform = 'translate3d(' + x + 'px,0,0)';
        scrim.style.opacity = String(Math.max(0, 1 + x / travel));
      },
      onEnd: function (g) {
        var v = g.velocity, x = g.offset;
        // §6 — project where the flick is *going*, then snap to the nearest edge.
        var projected = x + Motion.project(v);
        var open = projected > -travel / 2;
        // §10 — decide direction from the velocity's sign, not just position.
        if (Math.abs(v) > 300) open = v > 0;
        applySidebar(open, true, v);
      }
    });
  }

  // Drag the drawer itself: 1:1 from the grab point, resisting past the edges.
  _sbDrag = Motion.gesture(sb, {
    axis: 'x',
    dimension: travel,
    bounds: [-travel, 0],
    canStart: isMobileNav,
    onCommit: function () { _sbDragging = true; Motion.stop(sb); },
    onDrag: function (x) {
      sb.style.transform = 'translate3d(' + x + 'px,0,0)';
      setScrim(true, Math.max(0, Math.min(1, 1 + x / travel)));
    },
    onEnd: function (g) {
      var v = g.velocity, x = g.offset;
      // §6 — momentum projection picks the target, so a small flick throws it.
      var projected = x + Motion.project(v);
      var open = projected > -travel / 2;
      // §10/§3 — at release, the velocity's *sign* decides reverse vs. commit.
      if (Math.abs(v) > 300) open = v > 0;
      applySidebar(open, true, v);
      _sbDragging = false;
    }
  });
}

// ── SCROLL EDGE EFFECTS (§12) ─────────────────────────────────────────────────
// Instead of a hard 1px divider under sticky chrome, mark when content is
// actually scrolled beneath it; CSS then fades a soft mask only where the
// floating layer really overlaps content.
function setupScrollEdges() {
  if (!window.Motion) return;
  var SEL = '.content, .ai-messages, .modal-body, .ai-bubble-msgs, [data-scroll-edge]';
  document.querySelectorAll(SEL).forEach(function (el) {
    var target = el.closest('.main') || el.closest('.hub-page') || el.parentElement || document.body;
    Motion.scrollEdge(el, target);
  });
}

// ── USER UI UPDATE ────────────────────────────────────────────────────────────
function updateUserUI(u) {
  if (!u) return;
  const name = u.full_name || u.id;
  const picUrl = u.profile_pic ? `${API}/profile/picture/${u.profile_pic}` : null;
  const avatarHtml = picUrl ? `<img src="${picUrl}" alt="avatar">` : `<span>${name.charAt(0).toUpperCase()}</span>`;
  ['hub-avatar', 'user-avatar'].forEach(id => {
    const el = document.getElementById(id); if (el) el.innerHTML = avatarHtml;
  });
  ['hub-uname', 'hub-greeting', 'user-name'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = name;
  });
}

// ── AI DATA CONTEXT ────────────────────────────────────────────────────────────
let _ctxCache = null, _ctxTs = 0;

function _aiModule() {
  const p = location.pathname;
  if (p.indexOf('rental') !== -1) return 'rental';
  if (p.indexOf('store') !== -1) return 'store';
  if (p.indexOf('agriculture') !== -1) return 'farms';
  return 'general';
}
const _AI_RULES = [
  '',
  '=== HOW TO CHANGE DATA ===',
  'When the user clearly asks to add, edit, delete, sell, restock, or mark something, end your reply with EXACTLY ONE action block on its own line:',
  '<action>{...valid JSON...}</action>',
  'A confirm button is shown before anything happens. Rules: output an action ONLY for a clear change; reference records by [ID]; numbers as numbers (no quotes/units); keep chat text short and BEFORE the action; if a required detail is missing, ASK instead of guessing (no action then).'
];
function _aiStoreCtx(items) {
  const rows = items.slice(0,80).map(i => { const sold=(i.sales||[]).reduce((a,s)=>a+(s.quantity||0),0); const rev=(i.sales||[]).reduce((a,s)=>a+(s.amount_paid||0),0); const m=(i.sell_price||0)-(i.buy_price||0); return `  [ID:${i.id}] ${i.name} | stock ${i.quantity} | buy ${(i.buy_price||0)} | sell ${(i.sell_price||0)} | margin ${m.toFixed(2)}/unit | sold ${sold} | revenue ${rev.toFixed(2)} DT`; }).join('\n');
  return ['You are the assistant for the STORE module of Tripartite. Be hyper-specific and practical: pricing, profit margins, restock advice, which items sell or sit, debts. Use the live data; never invent. Prices in DT.','',`=== STORE PRODUCTS (${items.length}) ===`,rows||'  (none yet)','','ACTIONS (store):','<action>{"type":"add_product","name":"...","quantity":N,"buy_price":N,"sell_price":N,"description":"..."}</action>','<action>{"type":"update_product","id":N,"name":"...","quantity":N,"buy_price":N,"sell_price":N}</action>','<action>{"type":"restock","id":N,"add":N}</action>','<action>{"type":"sell_product","id":N,"quantity":N,"amount_paid":N,"discount_pct":N,"buyer_fname":"...","buyer_lname":"..."}</action>','<action>{"type":"delete_product","id":N}</action>'].concat(_AI_RULES).join('\n');
}
function _aiRentalCtx(units) {
  const rows = units.slice(0,60).map(u => { const t=u.is_vacant?'VACANT':(((u.fname||'')+' '+(u.lname||'')).trim()||'—'); const net=u.is_vacant?0:((u.rent||0)-(u.water_landlord?(u.water||0):0)-(u.electric_landlord?(u.electric||0):0)-(u.tax||0)); return `  [ID:${u.id}] ${u.prop_id||''}/${u.unit_num||''} | ${t} | rent ${u.rent||0} | status ${u.is_vacant?'vacant':(u.rent_status||'unpaid')} | net ${net.toFixed(1)} DT`; }).join('\n');
  return ['You are the assistant for the APARTMENTS/RENTAL module of Tripartite. Be hyper-specific: who owes rent, paid vs unpaid totals, vacancy, net income after landlord-paid costs (tax is always 10% of rent, paid by landlord). Use the live data; never invent. Prices in DT.','',`=== RENTAL UNITS (${units.length}) ===`,rows||'  (none yet)','','ACTIONS (rental):','<action>{"type":"add_unit","prop_id":"...","unit_num":"...","fname":"...","lname":"...","rent":N,"rent_status":"unpaid"}</action>','<action>{"type":"update_unit","id":N,"rent":N,"fname":"...","lname":"...","unit_num":"...","prop_id":"..."}</action>','<action>{"type":"set_rent_status","id":N,"status":"paid|unpaid|partial"}</action>','<action>{"type":"delete_unit","id":N}</action>'].concat(_AI_RULES).join('\n');
}
function _aiFarmsCtx(farms) {
  const rows = farms.slice(0,40).map(f => { const wc=(f.workers||[]).length; const wcost=(f.workers||[]).reduce((a,w)=>a+(w.daily_cost||0)*(w.days||0),0); const rev=(f.harvest_projections||[]).reduce((a,p)=>a+(p.expected_kg||0)*(p.price_per_kg||0),0); return `  [ID:${f.id}] ${f.name} | ${f.location||'—'} | ${f.size_hectares||0} ha | workers ${wc} (cost ${wcost.toFixed(0)} DT) | projected harvest ${rev.toFixed(0)} DT`; }).join('\n');
  return ['You are the assistant for the AGRICULTURE/FARMS module of Tripartite. Be hyper-specific: harvest projections, worker costs vs expected revenue, profitability per farm. Use the live data; never invent. Prices in DT.','',`=== FARMS (${farms.length}) ===`,rows||'  (none yet)','','ACTIONS (farms):','<action>{"type":"add_farm","name":"...","location":"...","size_hectares":N}</action>','<action>{"type":"update_farm","id":N,"name":"...","location":"...","size_hectares":N}</action>','<action>{"type":"delete_farm","id":N}</action>'].concat(_AI_RULES).join('\n');
}

async function getAiContext() {
  const now = Date.now();
  if (_ctxCache && (now - _ctxTs) < 20000) return _ctxCache;
  const mod = _aiModule();
  const getJson = async (url) => { try { const r = await fetch(`${API}${url}`, { credentials: 'include' }); return r.ok ? await r.json() : []; } catch(e) { return []; } };
  let ctx;
  try {
    if (mod === 'store')       ctx = _aiStoreCtx(await getJson('/store/items'));
    else if (mod === 'rental') ctx = _aiRentalCtx(await getJson('/units'));
    else if (mod === 'farms')  ctx = _aiFarmsCtx(await getJson('/farms'));
    else {
      const [u, s, f] = await Promise.all([getJson('/units'), getJson('/store/items'), getJson('/farms')]);
      ctx = ['You are the assistant for Tripartite (apartments, store, farms). The user is on the overview screen — give a brief summary and suggest opening a section for detailed help.', `Counts — units: ${u.length}, products: ${s.length}, farms: ${f.length}.`, '', 'ACTION (navigate): <action>{"type":"navigate","page":"rental|store|agriculture|hub"}</action> — only if asked.'].join('\n');
    }
  } catch(e) { ctx = 'You are the AI assistant for Tripartite business management system.'; }
  _ctxCache = ctx; _ctxTs = now;
  return ctx;
}

function invalidateAiContext() { _ctxCache = null; _ctxTs = 0; }

// ── AI RESPONSE PARSING ────────────────────────────────────────────────────────
function parseAiResponse(text) {
  const m = text.match(/<action>([\s\S]*?)<\/action>/);
  const clean = text.replace(/<action>[\s\S]*?<\/action>/g, '').trim();
  let action = null;
  if (m) { try { action = JSON.parse(m[1].trim()); } catch(e) {} }
  return { text: clean, action };
}

function describeAction(a) {
  switch(a.type) {
    case 'add_product':    return `Add product "${a.name}" — stock ${a.quantity||0}, buy ${a.buy_price||0}, sell ${a.sell_price||0} DT`;
    case 'update_product': return `Update product ID ${a.id} (${['name','quantity','buy_price','sell_price'].filter(k=>a[k]!=null).map(k=>k+'='+a[k]).join(', ')})`;
    case 'update_stock':   return `Set stock of ID ${a.id} to ${a.quantity} units`;
    case 'restock':        return `Add ${a.add} to stock of product ID ${a.id}`;
    case 'sell_product':   return `Sell ${a.quantity||1} of product ID ${a.id}${a.amount_paid!=null?' (paid '+a.amount_paid+' DT)':''}`;
    case 'delete_product': return `Delete product "${a.name||'ID '+a.id}" from store`;
    case 'add_unit':       return `Add unit ${a.prop_id||''}/${a.unit_num||''}${a.fname?(' for '+a.fname+' '+(a.lname||'')):''} — rent ${a.rent||0} DT`;
    case 'update_unit':    return `Update unit ID ${a.id} (${['rent','fname','lname','unit_num','prop_id'].filter(k=>a[k]!=null).map(k=>k+'='+a[k]).join(', ')})`;
    case 'update_unit_rent': return `Set rent for unit ID ${a.id} to ${a.rent} DT`;
    case 'set_rent_status':return `Set unit ID ${a.id} rent status to "${a.status}"`;
    case 'delete_unit':    return `Delete rental unit "${a.name||'ID '+a.id}"`;
    case 'add_farm':       return `Add farm "${a.name}"${a.location?(' in '+a.location):''}${a.size_hectares?(' — '+a.size_hectares+' ha'):''}`;
    case 'update_farm':    return `Update farm ID ${a.id} (${['name','location','size_hectares'].filter(k=>a[k]!=null).map(k=>k+'='+a[k]).join(', ')})`;
    case 'delete_farm':    return `Delete farm ID ${a.id}`;
    case 'navigate':       return `Open the ${a.page} page`;
    default: return JSON.stringify(a);
  }
}

function renderActionCard(action, container, size) {
  size = size || 'sm';
  const card = document.createElement('div');
  card.className = 'ai-action-card';
  card.dataset.action = JSON.stringify(action);
  card.innerHTML = `
    <div class="ai-action-label"><i class="fa-solid fa-bolt-lightning"></i> Action ready — confirm to execute</div>
    <div class="ai-action-desc">${escHtml(describeAction(action))}</div>
    <div class="ai-action-btns">
      <button class="btn ${size} primary" onclick="confirmAiAction(this)"><i class="fa-solid fa-check"></i> Do it</button>
      <button class="btn ${size}" onclick="this.closest('.ai-action-card').remove()"><i class="fa-solid fa-xmark"></i> Cancel</button>
    </div>`;
  container.appendChild(card);
  container.scrollTop = container.scrollHeight;
}

async function confirmAiAction(btn) {
  const card = btn.closest('.ai-action-card');
  const a = JSON.parse(card.dataset.action);
  card.querySelector('.ai-action-btns').innerHTML = '<span style="color:var(--muted);font-size:11px"><i class="fa-solid fa-spinner fa-spin"></i> Working…</span>';
  const getList = async (u) => { const r = await fetch(`${API}${u}`, { credentials:'include' }); return r.ok ? await r.json() : []; };
  const send = async (u, method, body) => { const r = await fetch(`${API}${u}`, { method, credentials:'include', headers: body?{'Content-Type':'application/json'}:undefined, body: body?JSON.stringify(body):undefined }); if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || (method+' failed')); return r; };
  const num = v => (v == null ? null : (parseFloat(v) || 0));
  try {
    let msg = '';
    switch (a.type) {
      // STORE
      case 'add_product':
        await send('/store/items', 'POST', { name:a.name||'New item', description:a.description||'', quantity:parseInt(a.quantity)||0, buy_price:num(a.buy_price)||0, sell_price:num(a.sell_price)||0 });
        msg = `Added "${a.name}".`; if (typeof loadStoreItems==='function') await loadStoreItems(); break;
      case 'update_product': case 'update_stock': case 'restock': {
        const it = (await getList('/store/items')).find(x => x.id === a.id); if (!it) throw new Error('Product not found');
        if (a.name != null) it.name = a.name; if (a.description != null) it.description = a.description;
        if (a.type === 'restock') it.quantity = (it.quantity||0) + (parseInt(a.add)||0);
        else if (a.quantity != null) it.quantity = parseInt(a.quantity) || 0;
        if (a.buy_price != null) it.buy_price = num(a.buy_price); if (a.sell_price != null) it.sell_price = num(a.sell_price);
        await send(`/store/items/${a.id}`, 'PUT', it); msg = `Updated "${it.name}".`; if (typeof loadStoreItems==='function') await loadStoreItems(); break;
      }
      case 'sell_product':
        await send(`/store/items/${a.id}/sell`, 'POST', { quantity:parseInt(a.quantity)||1, amount_paid:num(a.amount_paid)||0, discount_pct:num(a.discount_pct)||0, buyer_fname:a.buyer_fname||'', buyer_lname:a.buyer_lname||'', quick:!(a.buyer_fname||a.buyer_lname) });
        msg = 'Sale recorded.'; if (typeof loadStoreItems==='function') await loadStoreItems(); break;
      case 'delete_product':
        await send(`/store/items/${a.id}`, 'DELETE'); msg = `Deleted "${a.name||'product '+a.id}".`; if (typeof loadStoreItems==='function') await loadStoreItems(); break;
      // RENTAL
      case 'add_unit': {
        const rent = num(a.rent)||0;
        await send('/units', 'POST', { prop_id:a.prop_id||'NEW', unit_num:a.unit_num||'', is_vacant:!!a.is_vacant, fname:a.fname||'', lname:a.lname||'', rent, rent_status:a.rent_status||'unpaid', tax:rent*0.1, tax_landlord:true });
        msg = 'Unit added.'; if (typeof loadUnits==='function') await loadUnits(); break;
      }
      case 'update_unit': case 'update_unit_rent': case 'set_rent_status': {
        const u = (await getList('/units')).find(x => x.id === a.id); if (!u) throw new Error('Unit not found');
        if (a.rent != null) { u.rent = num(a.rent); u.tax = u.rent * 0.1; }
        ['fname','lname','unit_num','prop_id'].forEach(k => { if (a[k] != null) u[k] = a[k]; });
        if (a.type === 'set_rent_status' && a.status) u.rent_status = a.status;
        await send(`/units/${a.id}`, 'PUT', u); msg = 'Unit updated.'; if (typeof loadUnits==='function') await loadUnits(); break;
      }
      case 'delete_unit':
        await send(`/units/${a.id}`, 'DELETE'); msg = `Deleted unit "${a.name||'ID '+a.id}".`; if (typeof loadUnits==='function') await loadUnits(); break;
      // FARMS
      case 'add_farm':
        await send('/farms', 'POST', { name:a.name||'New farm', location:a.location||'', size_hectares:num(a.size_hectares)||0 });
        msg = `Added farm "${a.name}".`; if (typeof loadFarms==='function') await loadFarms(); break;
      case 'update_farm': {
        const f = (await getList('/farms')).find(x => x.id === a.id); if (!f) throw new Error('Farm not found');
        ['name','location'].forEach(k => { if (a[k] != null) f[k] = a[k]; }); if (a.size_hectares != null) f.size_hectares = num(a.size_hectares);
        await send(`/farms/${a.id}`, 'PUT', f); msg = 'Farm updated.'; if (typeof loadFarms==='function') await loadFarms(); break;
      }
      case 'delete_farm':
        await send(`/farms/${a.id}`, 'DELETE'); msg = 'Farm deleted.'; if (typeof loadFarms==='function') await loadFarms(); break;
      // NAV
      case 'navigate':
        msg = `Opening ${a.page}…`; setTimeout(() => { window.location.href = `/${a.page}.html`; }, 600); break;
      default: throw new Error('Unknown action');
    }
    card.innerHTML = `<div style="color:var(--green);font-size:13px;padding:4px 0"><i class="fa-solid fa-circle-check"></i> ${escHtml(msg)}</div>`;
    invalidateAiContext();
  } catch(e) {
    card.innerHTML = `<div style="color:var(--red);font-size:12px;padding:4px 0"><i class="fa-solid fa-circle-xmark"></i> ${escHtml(e.message||e)}</div>`;
  }
}

// ── PRINT BARCODE ─────────────────────────────────────────────────────────────
function printBarcode(itemId, itemName, sellPrice) {
  const code = String(itemId).padStart(8, '0');
  const win = window.open('', '_blank', 'width=420,height=480');
  win.document.write(`<!DOCTYPE html><html><head><title>Barcode - ${itemName}</title>
  <style>body{font-family:sans-serif;text-align:center;padding:24px;background:#fff;color:#000}
  h2{font-size:17px;margin:12px 0 3px;font-weight:700}
  .price{font-size:24px;font-weight:900;color:#2563eb;margin:4px 0 10px}
  #bc{display:flex;justify-content:center;margin-bottom:8px}
  .footer{font-size:10px;color:#aaa;margin-top:14px}
  @media print{button{display:none}}</style>
  <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
  </head><body>
  <div id="bc"><svg id="barcode"></svg></div>
  <h2>${itemName}</h2>
  <div class="price">${parseFloat(sellPrice).toFixed(2)} DT</div>
  <div class="footer">Tripartite System · ID ${itemId}</div>
  <br><button onclick="window.print()" style="padding:10px 24px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer">Print Barcode</button>
  <script>
    JsBarcode('#barcode','${code}',{format:'CODE128',width:2.2,height:90,displayValue:true,background:'#ffffff',lineColor:'#000000',margin:10});
    setTimeout(()=>window.focus(),200);
  <\/script>
  </body></html>`);
  win.document.close();
}
