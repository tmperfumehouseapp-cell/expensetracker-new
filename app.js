'use strict';
/* TripSplit — vanilla JS, no build step. */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

/* ---------- categories (icon auto-picked from the title) ---------- */
const CATS = {
  hotel:    ['🏨','Hotel',     /hotel|hostel|airbnb|resort|stay|room|villa|lodge|booking|night/i],
  flight:   ['✈️','Flights',   /flight|airline|plane|airport|egyptair|ticket to|boarding|baggage/i],
  food:     ['🍽️','Food',      /food|dinner|lunch|breakfast|restaurant|koshari|koshary|falafel|shawarma|pizza|burger|meal|kebab|brunch/i],
  drinks:   ['☕','Drinks',    /coffee|cafe|café|tea|shisha|sheesha|juice|beer|drink|bar\b|sahlab/i],
  groceries:['🛒','Groceries', /grocer|market|supermarket|snack|water|carrefour|shop food/i],
  tour:     ['🐪','Tours',     /camel|desert|safari|pyramid|sphinx|nile|felucca|cruise|tour|guide|luxor|aswan|siwa|dahab|snorkel|dive|diving|quad/i],
  transport:['🚕','Transport', /taxi|uber|careem|bus|metro|train|ride|transfer|car rental|rental|toll|ferry|tuk/i],
  fuel:     ['⛽','Fuel',      /fuel|petrol|gas\b|diesel/i],
  tickets:  ['🎟️','Tickets',   /museum|entry|entrance|ticket|admission|temple|show|park|visit/i],
  shopping: ['🛍️','Shopping',  /shop|souvenir|gift|bazaar|khan|clothes|papyrus|perfume|buy/i],
  sim:      ['📶','SIM / Data',/\bsim\b|data|internet|wifi|roaming|esim/i],
  tips:     ['💸','Tips',      /tip|baksheesh|bakshish|service charge/i],
  loan:     ['🤝','Loan',      /$^/],
  other:    ['🧾','Other',     /$^/]
};
const CAT_KEYS = Object.keys(CATS).filter(k => k !== 'loan');
const detectCat = t => Object.keys(CATS).find(k => k !== 'other' && k !== 'loan' && CATS[k][2].test(t)) || 'other';
const catI = k => (CATS[k] || CATS.other)[0];
const catN = k => (CATS[k] || CATS.other)[1];
const CUR = 'INR'; // everyone uses rupees

/* ---------- state ---------- */
let trips = store.get('ts_trips', {});            // code -> {token, memberId, name}
let S = { view: 'splash', code: null, tab: 'expenses', data: null, info: null, filter: null, stab: 'total', pid: null };
let timer = null;

/* ---------- helpers ---------- */
const COLORS = ['#fbbf24','#34d399','#60a5fa','#f472b6','#a78bfa','#fb923c','#2dd4bf','#f87171','#a3e635','#38bdf8'];
const colorOf = n => COLORS[[...String(n)].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const GEM = { m: '👨', f: '👩' };
const av = (n, s = '', g = '') => `<div class="av ${s}" style="background:${colorOf(n)}">${GEM[g] || esc((n || '?').trim()[0]?.toUpperCase())}</div>`;
const gOf = id => S.data?.members.find(m => m.id === id)?.gender || '';
const genderPick = (cur, fn) => `<div class="seg" id="gp"><button class="${cur === 'm' ? 'on' : ''}" onclick="${fn}('m')">👨 Male</button><button class="${cur === 'f' ? 'on' : ''}" onclick="${fn}('f')">👩 Female</button></div>`;
let G = store.get('ts_gender', '');
function pickG(g) { G = g; store.set('ts_gender', g); document.querySelectorAll('#gp button').forEach((b, i) => b.classList.toggle('on', (i ? 'f' : 'm') === g)); }
const money = (c, cur = CUR) => {
  const v = c / 100;
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur, maximumFractionDigits: v % 1 ? 2 : 0 }).format(v); }
  catch { return cur + ' ' + v.toFixed(2); }
};
const fmtE = c => 'E£' + (c / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const toCents = v => Math.round(parseFloat(String(v).replace(',', '.')) * 100) || 0;
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const nice = d => new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const mname = id => S.data.members.find(m => m.id === id)?.name || '?';
const link = c => location.origin + location.pathname.replace(/index\.html$/, '') + '?t=' + c;
function toast(m) { const t = $('#toast'); t.textContent = m; t.className = 'on'; clearTimeout(toast.t); toast.t = setTimeout(() => t.className = '', 2200); }
async function api(action, body = {}) {
  let r, j;
  try { r = await fetch('api/index.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...body }) }); j = await r.json(); }
  catch { throw new Error('No connection — try again'); }
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}
const auth = () => ({ code: S.code, token: trips[S.code].token });
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

/* ---------- maths ---------- */
function calc(d) {
  const m = {}; d.members.forEach(x => m[x.id] = { ...x, paid: 0, share: 0, lent: 0, borrowed: 0, net: 0, cats: {} });
  let total = 0, loans = 0; const cats = {}, catsAll = {};
  d.expenses.filter(e => !e.personal).forEach(e => {
    catsAll[e.category] = (catsAll[e.category] || 0) + e.amount;
    if (e.category === 'loan') { loans += e.amount; if (m[e.paid_by]) m[e.paid_by].lent += e.amount; e.splits.forEach(s => { if (m[s.member_id]) m[s.member_id].borrowed += s.amount; }); return; }
    total += e.amount; cats[e.category] = (cats[e.category] || 0) + e.amount;
    if (m[e.paid_by]) m[e.paid_by].paid += e.amount;
    e.splits.forEach(s => { const p = m[s.member_id]; if (p) { p.share += s.amount; p.cats[e.category] = (p.cats[e.category] || 0) + s.amount; } });
  });
  d.settlements.forEach(s => { if (m[s.from_id]) m[s.from_id].net += s.amount; if (m[s.to_id]) m[s.to_id].net -= s.amount; });
  const list = Object.values(m); list.forEach(p => p.net += p.paid - p.share + p.lent - p.borrowed);
  const cr = list.filter(p => p.net > 0).map(p => ({ ...p })).sort((a, b) => b.net - a.net);
  const db = list.filter(p => p.net < 0).map(p => ({ ...p, net: -p.net })).sort((a, b) => b.net - a.net);
  const plan = []; let i = 0, j = 0;
  while (i < db.length && j < cr.length) {
    const a = Math.min(db[i].net, cr[j].net);
    if (a > 0) plan.push({ from: db[i].id, to: cr[j].id, amount: a });
    db[i].net -= a; cr[j].net -= a;
    if (db[i].net <= 0) i++; if (cr[j].net <= 0) j++;
  }
  const personal = d.expenses.filter(e => e.personal);
  return { m, list, total, loans, cats, catsAll, plan, personal, personalTotal: personal.reduce((a, e) => a + e.amount, 0) };
}

/* ---------- Egyptian scene for the hero card ---------- */
const SCENE = `<svg class="scene" viewBox="0 0 320 170" preserveAspectRatio="xMaxYMax slice" aria-hidden="true">
<circle cx="268" cy="52" r="26" fill="#fbbf24" opacity=".9"/><circle cx="268" cy="52" r="40" fill="#fbbf24" opacity=".15"/>
<path d="M150 170 L228 78 L306 170Z" fill="#c2893a" opacity=".55"/><path d="M228 78 L306 170 L262 170Z" fill="#8a5a1f" opacity=".45"/>
<path d="M232 170 L276 112 L320 170Z" fill="#d9a04d" opacity=".5"/><path d="M276 112 L320 170 L296 170Z" fill="#8a5a1f" opacity=".4"/>
<path d="M0 158 Q40 146 80 158 T160 158 T240 158 T320 158 V170 H0Z" fill="#22d3ee" opacity=".25"/></svg>`;

/* ================= VIEWS ================= */
function render() {
  clearInterval(timer);
  const a = $('#app');
  if (S.view === 'splash') a.innerHTML = '<div class="splash">☥</div>';
  else if (S.view === 'home') home(a);
  else if (S.view === 'join') join(a);
  else if (S.view === 'trip') { tripView(a); timer = setInterval(refresh, 8000); }
  // fab only inside trip expenses/other tabs
  document.querySelector('.fab')?.remove();
  if (S.view === 'trip' && S.tab === 'expenses') document.body.insertAdjacentHTML('beforeend', '<button class="fab" onclick="openExpense()" aria-label="Add expense">+</button>');
}
const hdr = (right = '') => `<div class="top"><div class="logo">Trip<b>Split</b> ☥</div>${right}</div><div class="orn"></div>`;

function home(a) {
  const codes = Object.keys(trips);
  a.innerHTML = hdr() + `<div id="inst">${installCard()}</div>` + (codes.length ? `<div class="tabtitle">Your trips</div>` + codes.map(c =>
    `<div class="card tripcard" onclick="openTrip('${c}')"><div class="ico">🏺</div><div style="flex:1;min-width:0"><b>${esc(trips[c].tripName || 'Trip')}</b><div class="muted small">You're ${esc(trips[c].name)} · code ${c}</div></div>${trips[c].owner ? `<button class="ib" style="width:30px;height:30px;font-size:13px" onclick="event.stopPropagation();deleteTrip('${c}')" aria-label="Delete trip">🗑</button>` : '<span class="muted">›</span>'}</div>`).join('')
    : `<div class="welcome"><div class="pyr"><svg width="46" height="42" viewBox="0 0 46 42" style="vertical-align:-4px;margin-right:6px" aria-hidden="true"><path d="M23 2 44 40H2Z" fill="#16a34a"/><path d="M23 2 44 40H27Z" fill="#15803d"/></svg>🐪</div><h2>Split trips, not friendships</h2><p class="muted small">Add your crew, log who paid what, and settle up in one tap. No passwords — just names.</p></div>`) +
    `<div style="margin-top:16px"><button class="btn" onclick="newTripForm()">＋ New trip</button><button class="btn sec" onclick="joinCodeForm()">Join with a code</button></div>`;
}

function newTripForm() {
  modal(`<div class="hd"><h2>New trip 🧳</h2><button class="ib" onclick="closeModal()">✕</button></div>
  <div class="field"><label>Trip name</label><input id="tn" placeholder="Egypt 2026 🇪🇬" maxlength="60"></div>
  <div class="field"><label>Your name</label><input id="yn" placeholder="e.g. Jaimin" maxlength="40" value="${esc(store.get('ts_name', ''))}"></div>
  ${genderPick(G, 'pickG')}
  <button class="btn" onclick="createTrip()">Create trip</button>`);
}
const createTrip = guard(async () => {
  const r = await api('create_trip', { name: $('#tn').value, currency: CUR, your_name: $('#yn').value, gender: G });
  store.set('ts_name', $('#yn').value); saveTrip(r, $('#yn').value, true); closeModal(); openTrip(r.code); toast('Trip created — share the link!');
});
function joinCodeForm() {
  modal(`<div class="hd"><h2>Join a trip</h2><button class="ib" onclick="closeModal()">✕</button></div>
  <div class="field"><label>Trip code</label><input id="jc" placeholder="ABC123" maxlength="6" style="text-transform:uppercase;text-align:center;letter-spacing:.3em;font-size:22px"></div>
  <button class="btn" onclick="goJoin($('#jc').value)">Continue</button>`);
}
const goJoin = guard(async code => { closeModal(); await showJoin(String(code).trim().toUpperCase()); });
function saveTrip(r, name, owner = false) { trips[r.code] = { token: r.token, memberId: r.member_id, name, tripName: r.name, owner }; store.set('ts_trips', trips); }

async function showJoin(code) {
  S.info = await api('trip_info', { code }); S.code = code; S.view = 'join'; render();
}
function join(a) {
  const i = S.info;
  a.innerHTML = hdr() + `<div id="inst">${installCard()}</div><div class="card hero" style="min-height:150px">${SCENE}<div class="tiny" style="color:#ffffffaa">You're invited to</div><div class="big" style="font-size:22px;margin:4px 0 2px">${esc(i.name)}</div><div class="small" style="color:#ffffffcc">${i.members.length} ${i.members.length === 1 ? 'person' : 'people'} already in</div></div>
  <div class="card"><div class="field"><label>What's your name?</label><input id="jn" placeholder="Type your name" maxlength="40" value="${esc(store.get('ts_name', ''))}" autofocus></div>
  ${genderPick(G, 'pickG')}
  <button class="btn" onclick="doJoin()">Join trip →</button></div>` +
  (i.members.length ? `<div class="card"><div class="tiny" style="margin-bottom:6px">Already joined before? Tap your name</div>${i.members.map(m =>
    `<div class="item" onclick="doClaim(${m.id})">${av(m.name, '', m.gender)}<div class="mid"><b>${esc(m.name)}</b></div><span class="muted">That's me ›</span></div>`).join('')}</div>` : '') +
  `<button class="link" onclick="go('home')">← Back</button>`;
}
const doJoin = guard(async () => {
  const n = $('#jn').value.trim(); if (!n) throw new Error('Please type your name');
  const r = await api('join', { code: S.code, name: n, gender: G }); store.set('ts_name', n); saveTrip(r, n); openTrip(r.code);
});
const doClaim = guard(async id => {
  const r = await api('claim', { code: S.code, member_id: id }); saveTrip(r, S.info.members.find(m => m.id === id).name); openTrip(r.code);
});
function go(v) { S.view = v; history.replaceState(null, '', location.pathname); render(); }

const openTrip = guard(async code => {
  S.code = code; S.tab = 'expenses'; S.view = 'splash'; render();
  try { await refresh(true); } catch (e) { if (/signed in|not found/i.test(e.message)) { delete trips[code]; store.set('ts_trips', trips); go('home'); } throw e; }
  S.view = 'trip'; history.replaceState(null, '', '?t=' + code); render();
});
async function refresh(first) {
  const d = await api('state', auth());
  const changed = JSON.stringify(d) !== JSON.stringify(S.data); S.data = d;
  trips[S.code].tripName = d.trip.name; store.set('ts_trips', trips);
  if (!first && changed && S.view === 'trip' && !$('#modal').innerHTML) render();
}
function setTab(t) { S.tab = t; render(); window.scrollTo(0, 0); }

/* ---------- trip screen ---------- */
function tripView(a) {
  const d = S.data, c = calc(d), me = c.m[d.me];
  const net = me.net;
  const owe = net >= 0 ? "You're owed" : 'You owe', col = net >= 0 ? 'pos' : 'neg';
  const summary = S.tab === 'expenses'
    ? `<div class="card hero">${SCENE}<div class="tiny">Trip total</div><div class="big">${money(c.total)}</div>
    <div class="row"><div class="pill"><span class="tiny">You paid</span><b>${money(me.paid)}</b></div>
    <div class="pill"><span class="tiny">${owe}</span><b style="color:${net >= 0 ? '#a7f3d0' : '#fecdd3'}">${money(Math.abs(net))}</b></div></div></div>`
    : `<div class="mini"><span>Total<b>${money(c.total)}</b></span><span>You paid<b>${money(me.paid)}</b></span><span>${owe}<b class="${col}">${money(Math.abs(net))}</b></span></div>`;
  a.innerHTML = `<div class="top"><button class="ib" onclick="go('home')" aria-label="Back">‹</button><h1>${esc(d.trip.name)}</h1><button class="ib" onclick="shareSummary()" aria-label="Share summary">📋</button><button class="ib" onclick="shareTrip()" aria-label="Invite">📤</button></div><div class="orn"></div>
  ${summary}` +
    ({ expenses: tabExpenses, balances: tabBalances, stats: tabStats, people: tabPeople }[S.tab])(c) +
    `<div class="nav"><div>${[['expenses','🧾','Expenses'],['balances','⚖️','Settle'],['stats','📊','Stats'],['people','👥','People']].map(([k, i, l]) =>
      `<button class="${S.tab === k ? 'on' : ''}" onclick="setTab('${k}')"><span>${i}</span>${l}</button>`).join('')}</div></div>`;
}

function expRow(e) {
  const d = S.data, mine = e.splits.find(s => s.member_id === d.me), loan = e.category === 'loan';
  const sub = e.personal ? 'Personal' : loan ? `${esc(mname(e.paid_by))} → ${e.splits.map(s => esc(mname(s.member_id))).join(', ')}` : esc(mname(e.paid_by)) + ' paid';
  const side = e.personal ? '' : e.paid_by === d.me ? `<span class="small pos">you lent ${money(e.amount - (mine?.amount || 0))}</span>`
    : mine ? `<span class="small ${loan ? 'neg' : 'muted'}">${loan ? 'you owe ' : 'your share '}${money(mine.amount)}</span>` : '<span class="small muted">not involved</span>';
  return `<div class="item" onclick="openExpense(${e.id})"><div class="ico">${catI(e.category)}</div>
  <div class="mid"><b>${esc(e.title)}${e.personal ? '<span class="tag">🔒 mine</span>' : ''}</b><span class="muted small">${sub}</span></div>
  <div class="end"><b>${money(e.amount)}</b>${e.orig_cur === 'EGP' ? `<span class="small muted">${fmtE(e.orig_amount)}</span>` : ''}${side}</div></div>`;
}
function tabExpenses(c) {
  const ex = S.data.expenses;
  const nudge = S.data.members.length < 2 ? `<div class="card nudge" onclick="shareTrip()">👋 <b>You're the only one here.</b> Tap to invite friends on WhatsApp →</div>` : ''; if (!ex.length) return nudge + deletedSection() + `<div class="empty"><div class="e">🐪</div><b>No expenses yet</b><p class="small">Tap + to add the first one — "Hotel", "Taxi", "Koshari"… the icon picks itself.</p></div>`;
  const d = S.data, me = c.m[d.me];
  const today_ = `<div class="tabtitle" style="margin-top:2px">Whole trip so far</div><div class="row3"><div class="card tile"><div class="tiny">Trip spend</div><b>${money(c.total)}</b></div><div class="card tile"><div class="tiny">My spend</div><b>${money(me.share + c.personalTotal)}</b></div><div class="card tile"><div class="tiny">🔒 Personal</div><b>${money(c.personalTotal)}</b></div></div>`
    + (me.lent || me.borrowed ? `<div class="loanline" onclick="setTab('balances')">🤝 You lent <b class="pos">${money(me.lent)}</b> · You borrowed <b class="neg">${money(me.borrowed)}</b> <span class="muted">›</span></div>` : '');
  const keys = Object.keys(c.catsAll).sort((a, b) => c.catsAll[b] - c.catsAll[a]);
  const strip = `<div class="strip"><span class="chip ${!S.filter ? 'on' : ''}" onclick="setFilter(null)">All</span>${keys.map(k => `<span class="chip ${S.filter === k ? 'on' : ''}" onclick="setFilter('${k}')">${catI(k)} ${money(c.catsAll[k])}</span>`).join('')}</div>`;
  const list = ex.filter(e => !S.filter || e.category === S.filter);
  const g = {}; list.forEach(e => (g[e.date] ||= []).push(e));
  return nudge + today_ + strip + Object.keys(g).sort().reverse().map(dt => `<div class="day">${nice(dt)}</div><div class="card" style="padding:0 12px">${g[dt].map(expRow).join('')}</div>`).join('') + deletedSection();
}

function deletedSection() {
  const del = S.data.deleted || []; if (!del.length) return '';
  const tot = del.filter(e => !e.personal && e.category !== 'loan').reduce((a, e) => a + e.amount, 0);
  const rows = S.showDel ? `<div class="card" style="padding:0 12px">${del.map(e => `<div class="item" style="cursor:default"><div class="ico" style="opacity:.55">${catI(e.category)}</div>
    <div class="mid"><b style="text-decoration:line-through;color:var(--mut)">${esc(e.title)}</b><span class="muted small">Deleted by ${esc(mname(e.deleted_by))} · ${new Date(e.deleted_at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span></div>
    <div class="end"><b style="color:var(--mut)">${money(e.amount)}</b></div><button class="btn sm sec" onclick="restoreExpense(${e.id})">Restore</button><button class="ib" onclick="purgeExpense(${e.id})" aria-label="Delete forever">✕</button></div>`).join('')}</div>` : '';
  return `<button class="delbar" onclick="S.showDel=!S.showDel;render()">🗑 Deleted (${del.length}) · ${money(tot)} <span>${S.showDel ? '▴' : '▾'}</span></button>` + rows;
}
const restoreExpense = guard(async id => { await api('restore_expense', { ...auth(), id }); await refresh(); render(); toast('Restored ✓'); });
const purgeExpense = guard(async id => { if (!confirm('Delete this forever? It cannot be restored.')) return; await api('purge_expense', { ...auth(), id }); await refresh(); render(); });
function setFilter(k) { S.filter = k; render(); }

function tabBalances(c) {
  const d = S.data, mx = Math.max(1, ...c.list.map(p => Math.abs(p.net)));
  return `<div class="tabtitle">Who owes who</div><div class="card">${c.list.map(p => `<div class="sp">${av(p.name, 's', p.gender)}<div class="nm"><b>${esc(p.name)}${p.id === d.me ? ' (you)' : ''}</b>
    <div class="bar ${p.net < 0 ? 'n' : 'p'}"><i style="width:${Math.abs(p.net) / mx * 100}%"></i></div></div><b class="${p.net >= 0 ? 'pos' : 'neg'}">${p.net >= 0 ? '+' : '−'}${money(Math.abs(p.net))}</b></div>`).join('')}</div>
  <div class="tabtitle">Suggested payments</div>` + (c.plan.length ? `<div class="card">${c.plan.map((p, i) => `<div class="item" style="cursor:default">${av(mname(p.from), 's', gOf(p.from))}<div class="mid"><b>${esc(mname(p.from))} → ${esc(mname(p.to))}</b><span class="muted small">${money(p.amount)}</span></div><button class="ib" onclick="remind(${i})" aria-label="Remind on WhatsApp">💬</button><button class="btn sm" onclick="settle(${i})">Mark paid</button></div>`).join('')}</div>`
    : `<div class="empty"><div class="e">🎉</div><b>All settled up!</b></div>`) +
  `<button class="btn sec" style="margin-top:8px" onclick="openExpense(0,'lend')">🤝 Lend money to someone</button>` +
  (d.expenses.some(e => e.category === 'loan' && !e.personal) ? `<div class="tabtitle">Loans</div><div class="card" style="padding:0 12px">${d.expenses.filter(e => e.category === 'loan').map(expRow).join('')}</div>` : '') +
  (d.settlements.length ? `<div class="tabtitle">Payments made</div><div class="card" style="padding:2px 14px">${d.settlements.map(s => `<div class="item" style="cursor:default"><div class="ico">💸</div><div class="mid"><b>${esc(mname(s.from_id))} paid ${esc(mname(s.to_id))}</b><span class="muted small">${nice(s.date)}</span></div><b>${money(s.amount)}</b><button class="link" onclick="undoSettle(${s.id})">Undo</button></div>`).join('')}</div>` : '');
}
const settle = guard(async i => { const p = calc(S.data).plan[i]; await api('add_settlement', { ...auth(), from_id: p.from, to_id: p.to, amount: p.amount }); await refresh(); render(); toast('Marked as paid ✓'); });
const undoSettle = guard(async id => { await api('delete_settlement', { ...auth(), id }); await refresh(); render(); });

const bars = (rows, tot) => rows.length ? rows.map(([k, v]) => `<div class="sp"><div class="ico" style="width:30px;height:30px;font-size:15px">${catI(k)}</div><div class="nm"><div style="display:flex;justify-content:space-between"><b>${catN(k)} <span class="muted small">${tot ? Math.round(v / tot * 100) : 0}%</span></b><b>${money(v)}</b></div><div class="bar"><i style="width:${v / rows[0][1] * 100}%"></i></div></div></div>`).join('') : '<span class="muted small">Nothing yet</span>';
function tabStats(c) {
  const d = S.data, n = c.list.length || 1;
  const sub = `<div class="seg"><button class="${S.stab === 'total' ? 'on' : ''}" onclick="S.stab='total';render()">👥 Total</button><button class="${S.stab === 'person' ? 'on' : ''}" onclick="S.stab='person';render()">👤 Per person</button></div>`;
  if (S.stab === 'total') {
    const rows = Object.entries(c.cats).sort((a, b) => b[1] - a[1]);
    return sub + `<div class="row2" style="margin-bottom:8px"><div class="card tile"><div class="tiny">Trip total</div><b>${money(c.total)}</b></div><div class="card tile"><div class="tiny">Per person</div><b>${money(Math.round(c.total / n))}</b></div><div class="card tile"><div class="tiny">Loans</div><b>${money(c.loans)}</b></div></div>
    <div class="tabtitle">Where the money went</div><div class="card">${bars(rows, c.total)}</div>
    <div class="tabtitle">By person</div><div class="card"><table class="tbl"><tr><th>Person</th><th>Paid</th><th>Spent</th><th>Balance</th></tr>${c.list.map(p => `<tr><td>${esc(p.name)}</td><td>${money(p.paid)}</td><td><b>${money(p.share)}</b></td><td class="${p.net >= 0 ? 'pos' : 'neg'}">${p.net >= 0 ? '+' : '−'}${money(Math.abs(p.net))}</td></tr>`).join('')}</table></div>
    <button class="btn sec" onclick="exportCsv()">⬇ Export to CSV</button>`;
  }
  const pid = c.m[S.pid] ? S.pid : d.me, p = c.m[pid], isMe = pid === d.me;
  const rows = Object.entries(p.cats).sort((a, b) => b[1] - a[1]);
  const mine = d.expenses.filter(e => e.category !== 'loan' && !e.personal && e.splits.some(s => s.member_id === pid));
  const priv = isMe ? c.personalTotal : 0;
  return sub + `<div class="strip">${c.list.map(x => `<span class="chip ${x.id === pid ? 'on' : ''}" onclick="S.pid=${x.id};render()">${GEM[x.gender] || ''} ${esc(x.name)}</span>`).join('')}</div>
  <div class="row2" style="margin-bottom:8px"><div class="card tile"><div class="tiny">Spent</div><b>${money(p.share + priv)}</b></div><div class="card tile"><div class="tiny">Paid</div><b>${money(p.paid)}</b></div><div class="card tile"><div class="tiny">Balance</div><b class="${p.net >= 0 ? 'pos' : 'neg'}">${p.net >= 0 ? '+' : '−'}${money(Math.abs(p.net))}</b></div></div>
  ${priv ? `<div class="muted small" style="margin:-2px 4px 8px">Includes ${money(priv)} personal 🔒 (only you see this)</div>` : ''}
  ${p.lent || p.borrowed ? `<div class="muted small" style="margin:0 4px 8px">🤝 Lent ${money(p.lent)} · Borrowed ${money(p.borrowed)}</div>` : ''}
  <div class="tabtitle">${esc(p.name)} spent on</div><div class="card">${bars(rows, p.share)}</div>
  <div class="tabtitle">Their share of each expense</div><div class="card" style="padding:0 12px">${mine.length ? mine.map(e => `<div class="item" style="cursor:default"><div class="ico">${catI(e.category)}</div><div class="mid"><b>${esc(e.title)}</b><span class="muted small">${nice(e.date)}</span></div><b>${money(e.splits.find(s => s.member_id === pid).amount)}</b></div>`).join('') : '<div class="muted small" style="padding:10px 0">Nothing yet</div>'}</div>`;
}
function exportCsv() {
  const d = S.data, q = v => '"' + String(v).replace(/"/g, '""') + '"';
  const rows = [['Date', 'Title', 'Category', 'Amount', 'Paid by', 'Personal'], ...d.expenses.map(e => [e.date, e.title, catN(e.category), (e.amount / 100).toFixed(2), mname(e.paid_by), e.personal ? 'yes' : 'no'])];
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' }));
  a.download = d.trip.name.replace(/\W+/g, '_') + '.csv'; a.click();
}

function tabPeople() {
  const d = S.data;
  return `<div class="card" style="text-align:center"><div class="tiny">Trip code</div><div class="code">${d.trip.code}</div><p class="muted small" style="margin:0 0 12px">Send the link on WhatsApp — friends just type their name.</p>
  <div class="share"><button class="btn" onclick="shareTrip()">Share link</button><button class="btn sec" onclick="copyLink()">Copy</button></div></div>
  <div class="card" style="display:flex;align-items:center;gap:10px"><div class="ico">💱</div><div style="flex:1"><b>1 E£ = ₹${d.trip.egp_rate}</b><div class="muted small">Group exchange rate · applies to new expenses</div></div><button class="btn sm" onclick="setRate()">Change</button></div>
  <div class="tabtitle">${d.members.length} travellers</div><div class="card" style="padding:2px 14px">${d.members.map(m => `<div class="item" onclick="renameMember(${m.id})">${av(m.name, '', m.gender)}<div class="mid"><b>${esc(m.name)}${m.id === d.me ? ' <span class="tag">you</span>' : ''}</b></div><span class="muted small">edit</span></div>`).join('')}</div>
  <div class="card"><div class="field"><label>Add a friend without the app</label><input id="am" placeholder="Their name" maxlength="40"></div>${genderPick('', 'pickG2')}<button class="btn sec" onclick="addMember()">＋ Add person</button></div>
  ${d.members[0]?.id === d.me ? `<button class="btn danger" onclick="deleteTrip('${d.trip.code}')">🗑 Delete trip for everyone</button>` : ''}
  <button class="btn sec" onclick="leaveTrip()">Remove trip from this phone only</button>`;
}
let G2 = '';
function pickG2(g) { G2 = g; document.querySelectorAll('#gp button').forEach((b, i) => b.classList.toggle('on', (i ? 'f' : 'm') === g)); }
const setRate = guard(async inForm => {
  const v = prompt('How many rupees is 1 Egyptian pound?', S.data.trip.egp_rate); if (v === null) return;
  const r = parseFloat(String(v).replace(',', '.')); if (!(r > 0)) throw new Error('Enter a valid rate');
  await api('set_rate', { ...auth(), rate: r }); await refresh();
  if (inForm === true && F) { F.rate = S.data.trip.egp_rate; drawExpense(); } else render(); toast('Rate saved');
});
const addMember = guard(async () => { const n = $('#am').value.trim(); if (!n) throw new Error('Type a name'); await api('add_member', { ...auth(), name: n, gender: G2 });G2=''; await refresh(); render(); toast(n + ' added — shared expenses now include them'); });
const renameMember = guard(async id => { const n = prompt('Name', mname(id)); if (n && n.trim()) { await api('rename_member', { ...auth(), member_id: id, name: n }); await refresh(); render(); } });
const deleteTrip = guard(async code => {
  if (!confirm('Delete this trip for EVERYONE?\nAll expenses and balances will be lost. This cannot be undone.')) return;
  try { await api('delete_trip', { code, token: trips[code].token }); } catch (e) { if (!/not found/i.test(e.message)) throw e; }
  delete trips[code]; store.set('ts_trips', trips); go('home'); toast('Trip deleted');
});
function leaveTrip() { if (confirm('Remove this trip from your phone? You can re-join with the link anytime.')) { delete trips[S.code]; store.set('ts_trips', trips); go('home'); } }
function sendText(t) { if (navigator.share) navigator.share({ text: t }).catch(() => {}); else location.href = 'https://wa.me/?text=' + encodeURIComponent(t); }
function remind(i) { const p = calc(S.data).plan[i]; sendText(`Hi ${mname(p.from)} 👋 friendly reminder from TripSplit: please pay ${mname(p.to)} ${money(p.amount)} for "${S.data.trip.name}". Thanks! 🙏`); }
function shareSummary() {
  const c = calc(S.data), n = c.list.length || 1;
  const cats = Object.entries(c.cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${catI(k)} ${catN(k)}: ${money(v)}`).join('\n');
  const plan = c.plan.map(p => `• ${mname(p.from)} → ${mname(p.to)}: ${money(p.amount)}`).join('\n') || 'All settled up 🎉';
  sendText(`🧳 ${S.data.trip.name}\nTotal: ${money(c.total)} (${money(Math.round(c.total / n))} each)\n\n${cats}\n\nWho pays whom:\n${plan}`);
}
function shareTrip() {
  const u = link(S.code), t = `Join our trip "${S.data.trip.name}" on TripSplit 🧳 — just type your name:\n${u}`;
  if (navigator.share) navigator.share({ title: 'TripSplit', text: t }).catch(() => {}); else location.href = 'https://wa.me/?text=' + encodeURIComponent(t);
}
function copyLink() { navigator.clipboard?.writeText(link(S.code)).then(() => toast('Link copied')).catch(() => toast(link(S.code))); }

/* ---------- add / edit expense ---------- */
let F = null;
function openExpense(id, kind) {
  const d = S.data, e = id ? d.expenses.find(x => x.id === id) : null;
  const all = d.members.map(m => m.id);
  const amts = e ? e.splits.map(s => s.amount) : [];
  const exact = e && Math.max(...amts) - Math.min(...amts) > 1;
  const egp = e && e.orig_cur === 'EGP' && !exact, rate = d.trip.egp_rate;
  const lend = e ? e.category === 'loan' : kind === 'lend';
  F = e ? { id: e.id, title: e.title, amount: egp ? e.orig_amount : e.amount, cur: egp ? 'EGP' : 'INR', rate: egp ? e.rate : rate, category: e.category, auto: false, paid_by: e.paid_by, date: e.date, note: e.note || '', personal: !!e.personal,
            lend, mode: exact ? 'exact' : 'equal', sel: new Set(e.splits.map(s => s.member_id)), ex: Object.fromEntries(e.splits.map(s => [s.member_id, (s.amount / 100).toString()])) }
    : { id: 0, title: '', amount: 0, cur: 'INR', rate, category: 'other', auto: true, paid_by: d.me, date: today(), note: '', personal: false, lend, mode: 'equal', sel: new Set(lend ? [] : all), ex: {} };
  if (lend && !e) { F.title = 'Loan'; F.category = 'loan'; F.auto = false; }
  drawExpense();
}
const totalINR = () => F.cur === 'EGP' ? Math.round(F.amount * F.rate) : F.amount;
function distribute(total, w) { // split `total` cents by weights, no cent lost
  const s = w.reduce((a, b) => a + b, 0); if (!s) return w.map(() => 0);
  const raw = w.map(x => total * x / s), base = raw.map(Math.floor);
  let r = total - base.reduce((a, b) => a + b, 0);
  raw.map((v, i) => [v - base[i], i]).sort((a, b) => b[0] - a[0]).slice(0, r).forEach(([, i]) => base[i]++);
  return base;
}
function shares() {
  const ids = [...F.sel]; if (F.personal || !ids.length) return {};
  const w = F.mode === 'exact' ? ids.map(i => toCents(F.ex[i] || 0)) : ids.map(() => 1);
  const out = distribute(totalINR(), w); return Object.fromEntries(ids.map((id, i) => [id, out[i]]));
}
const enteredSum = () => [...F.sel].reduce((a, i) => a + toCents(F.ex[i] || 0), 0);
function preview() {
  const cv = $('#conv'); if (cv) cv.innerHTML = F.cur === 'EGP' && F.amount ? `≈ <b>${money(totalINR())}</b> at 1 E£ = ₹${F.rate}` : '';
  const el = $('#prev'); if (!el) return;
  const sh = shares();
  S.data.members.forEach(m => { const x = $('#sh' + m.id); if (x) x.textContent = F.sel.has(m.id) ? money(sh[m.id] || 0) : '—'; });
  const sum = enteredSum(), cf = F.cur === 'EGP' ? fmtE : money;
  el.innerHTML = F.mode === 'exact' && !F.personal ? (sum === F.amount ? '<span class="pos">✓ adds up</span>' : `<span class="neg">${cf(Math.abs(F.amount - sum))} ${sum < F.amount ? 'left to assign' : 'too much'}</span>`) : '';
}
function drawExpense() {
  const d = S.data, f = F;
  const L = f.lend;
  modal(`<div class="hd"><h2>${f.id ? (L ? 'Edit loan' : 'Edit expense') : L ? 'Lend money' : 'New expense'}</h2><button class="ib" onclick="closeModal()">✕</button></div>
  ${f.id ? '' : `<div class="seg"><button class="${L ? '' : 'on'}" onclick="switchKind(false)">🧾 Expense</button><button class="${L ? 'on' : ''}" onclick="switchKind(true)">🤝 Lend</button></div>`}
  <div class="seg" style="margin-bottom:8px"><button class="${f.cur === 'INR' ? 'on' : ''}" onclick="F.cur='INR';drawExpense()">₹ Rupees</button><button class="${f.cur === 'EGP' ? 'on' : ''}" onclick="F.cur='EGP';F.rate=S.data.trip.egp_rate;drawExpense()">E£ Egyptian pound</button></div>
  <div class="field" style="margin-bottom:4px"><input class="amt" id="fa" inputmode="decimal" placeholder="0.00" value="${f.amount ? f.amount / 100 : ''}" oninput="F.amount=toCents(this.value);preview()"></div>
  ${f.cur === 'EGP' ? `<div class="small muted" style="text-align:center;margin-bottom:10px"><span id="conv"></span> · <button class="link" onclick="setRate(true)">change rate</button></div>` : ''}
  <div class="field"><label>${L ? 'Note' : 'What for?'}</label><input id="ft" placeholder="Hotel, taxi, koshari…" maxlength="80" value="${esc(f.title)}" oninput="onTitle(this.value)"></div>
  ${L ? '' : `<div class="field"><label>Category <span id="ci" style="font-size:16px">${catI(f.category)}</span></label><div class="cats">${CAT_KEYS.map(k => `<span class="chip ${f.category === k ? 'on' : ''}" onclick="F.category='${k}';F.auto=false;drawExpense()">${CATS[k][0]} ${CATS[k][1]}</span>`).join('')}</div></div>`}
  ${L ? '' : `<div class="tog ${f.personal ? 'on' : ''}" onclick="F.personal=!F.personal;drawExpense()"><span style="font-size:22px">🔒</span><div style="flex:1"><b>Just for me</b><div class="muted small">Private — not split, only you see it</div></div><input type="checkbox" ${f.personal ? 'checked' : ''} style="width:22px;height:22px;pointer-events:none"></div>`}
  ${f.personal ? '' : `<div class="field"><label>${L ? 'Lent by' : 'Paid by'}</label><select onchange="F.paid_by=+this.value;F.sel.delete(F.paid_by);${L ? 'drawExpense()' : ''}">${d.members.map(m => `<option value="${m.id}" ${m.id === f.paid_by ? 'selected' : ''}>${esc(m.name)}${m.id === d.me ? ' (you)' : ''}</option>`).join('')}</select></div>
  <div class="field"><label style="display:flex;justify-content:space-between">${L ? 'Lent to' : 'Split'}<button class="link" style="padding:0;font-size:12px" onclick="selAll()">Select everyone</button></label><div class="seg"><button class="${f.mode === 'equal' ? 'on' : ''}" onclick="F.mode='equal';drawExpense()">${L ? 'Split equally' : 'Equally'}</button><button class="${f.mode === 'exact' ? 'on' : ''}" onclick="F.mode='exact';drawExpense()">By amount${f.cur === 'EGP' ? ' (E£)' : ''}</button></div>
  ${d.members.filter(m => !(L && m.id === f.paid_by)).map(m => `<div class="sp">${av(m.name, 's', m.gender)}<span class="nm">${esc(m.name)}</span>
    ${f.mode === 'exact' ? `<input class="ex" inputmode="decimal" placeholder="0" value="${esc(f.ex[m.id] || '')}" oninput="F.ex[${m.id}]=this.value;F.sel[this.value?'add':'delete'](${m.id});preview()">` : `<span id="sh${m.id}" class="muted small"></span><input type="checkbox" ${f.sel.has(m.id) ? 'checked' : ''} onchange="this.checked?F.sel.add(${m.id}):F.sel.delete(${m.id});preview()">`}</div>`).join('')}
  <div id="prev" class="small" style="text-align:right;min-height:18px"></div></div>`}
  <div class="row2"><div class="field"><label>Date</label><input type="date" value="${f.date}" onchange="F.date=this.value"></div></div>
  <div class="field"><label>Note (optional)</label><input value="${esc(f.note)}" maxlength="200" oninput="F.note=this.value"></div>
  <button class="btn" onclick="saveExpense()">${f.id ? 'Save changes' : 'Add expense'}</button>
  ${f.id ? '<button class="btn danger" onclick="delExpense()">Delete</button>' : ''}`);
  preview();
}
function selAll() { F.sel = new Set(S.data.members.filter(m => !(F.lend && m.id === F.paid_by)).map(m => m.id)); drawExpense(); }
function switchKind(lend) {
  const t = F.title; F.lend = lend; F.sel = new Set(lend ? [] : S.data.members.map(m => m.id));
  if (lend) { F.category = 'loan'; F.auto = false; F.personal = false; if (!t || t === 'Loan') F.title = 'Loan'; }
  else { F.category = detectCat(t === 'Loan' ? '' : t); F.auto = true; if (t === 'Loan') F.title = ''; }
  drawExpense();
}
function onTitle(v) { F.title = v; if (F.auto) { F.category = detectCat(v); const ci = $('#ci'); if (ci) ci.textContent = catI(F.category); document.querySelectorAll('#modal .cats .chip').forEach((c, i) => c.classList.toggle('on', CAT_KEYS[i] === F.category)); } }
const saveExpense = guard(async () => {
  if (F.lend && !F.title.trim()) F.title = 'Loan'; if (!F.title.trim()) throw new Error('What was it for?'); if (F.amount <= 0) throw new Error('Enter an amount');
  const sh = shares(); let splits = Object.entries(sh).map(([id, amount]) => ({ member_id: +id, amount }));
  if (!F.personal) { if (!splits.length) throw new Error(F.lend ? 'Pick who you lent to' : 'Pick who shares it'); if (F.mode === 'exact' && enteredSum() !== F.amount) throw new Error('Split must add up to the total'); }
  await api('save_expense', { ...auth(), expense: { id: F.id, title: F.title, amount: totalINR(), orig_amount: F.cur === 'EGP' ? F.amount : 0, orig_cur: F.cur, rate: F.rate, category: F.category, paid_by: F.paid_by, date: F.date, note: F.note, personal: F.personal, split_all: !F.personal && !F.lend && F.mode === 'equal' && F.sel.size === S.data.members.length, splits } });
  navigator.vibrate?.(15); closeModal(); await refresh(); render(); toast(F.id ? 'Saved ✓' : F.lend ? 'Loan added 🤝' : 'Added ' + catI(F.category));
});
const delExpense = guard(async () => { if (!confirm('Delete this expense?\nIt moves to the Deleted section — you can restore it.')) return; await api('delete_expense', { ...auth(), id: F.id }); closeModal(); await refresh(); render(); toast('Moved to Deleted 🗑'); });

function modal(h) {
  document.body.style.overflow = 'hidden'; $('#modal').innerHTML = `<div class="back" onclick="if(event.target===this)closeModal()"><div class="sheet">${h}</div></div>`; }
function closeModal() { $('#modal').innerHTML = ''; document.body.style.overflow = ''; }

/* ---------- one-tap install ---------- */
let installEv = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
function installCard() {
  if (standalone()) return '';
  if (installEv) return `<button class="btn" style="margin-bottom:10px" onclick="doInstall()">📲 Install app on this phone</button>`;
  if (isIOS) return `<div class="card nudge">📲 <b>Install:</b> tap <b>Share</b> <span style="font-size:16px">⬆︎</span> then <b>Add to Home Screen</b></div>`;
  return '';
}
const paintInstall = () => { const e = $('#inst'); if (e) e.innerHTML = installCard(); };
async function doInstall() { if (!installEv) return; installEv.prompt(); await installEv.userChoice.catch(() => {}); installEv = null; paintInstall(); }
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEv = e; paintInstall(); });
addEventListener('appinstalled', () => { installEv = null; paintInstall(); toast('Installed ✓'); });

/* ---------- boot ---------- */
(async function () {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
  const t = (new URLSearchParams(location.search).get('t') || '').toUpperCase();
  try {
    if (t && trips[t]) await openTrip(t);
    else if (t) await showJoin(t);
    else if (Object.keys(trips).length === 1) await openTrip(Object.keys(trips)[0]);
    else go('home');
  } catch (e) { toast(e.message); go('home'); }
})();
