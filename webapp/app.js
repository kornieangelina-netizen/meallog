/* MealLog PWA: vanilla JS, talks to /api/* on the same origin. Charts are hand-built SVG (no libraries,
   works offline). Data colors are fixed by meaning: kcal green, protein blue, fat pink, carbs orange. */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const qty = (n) => String(Math.round(Number(n || 0) * 100) / 100).replace('.', ',');
  const fmt = (n, d = 0) => (n == null || isNaN(n) ? '–' : Number(n).toFixed(d).replace(/\.0$/, ''));
  const MACROS = ['kcal', 'protein', 'fat', 'carbs'];
  const MACRO_LABELS = { kcal: 'Калории', protein: 'Белки', fat: 'Жиры', carbs: 'Углеводы' };
  const MACRO_SHORT = { kcal: 'ккал', protein: 'Б', fat: 'Ж', carbs: 'У' };
  const UNIT = { kcal: 'ккал', protein: 'г', fat: 'г', carbs: 'г' };
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
  const WEEKDAYS_LONG = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
  // Fred's own norms (stronger than the goal fields): protein anywhere in 110–150 g is fine;
  // fat is bad only above 50 g (the goal says 45, 45–50 is still fine)
  const PROTEIN_OK = [110, 150];
  const FAT_MAX = 50;
  const proteinOk = (v) => v >= PROTEIN_OK[0] && v <= PROTEIN_OK[1];
  // body measurements in the order they sit on the chart, top to bottom
  const MEAS = [['hips', 'ОБ', '#ee5fae'], ['chest', 'ОГ', '#3dbbf5'], ['waist', 'ОТ', '#c9d2ff']];
  const css = getComputedStyle(document.documentElement);
  const COLOR = Object.fromEntries(MACROS.map((m) => [m, css.getPropertyValue(`--${m}`).trim()]));

  const state = {
    tab: 'journal',
    prodView: 'fridge',
    shelf: 'all',        // fridge filter: all | home | delivery | ready | cook
    sort: 'default',     // product order: default | protein | carbs | fat | kcal
    sortOpen: false,     // sort chips shown under the search row
    closedShelves: [],   // fridge shelves folded by their header
    leftFocus: null,     // remainder card: null = auto (the least covered of protein / carbs)
    leftAll: false,      // remainder card: whole catalogue, not only the fridge
    leftOpen: false,     // remainder card starts collapsed: only the totals line
    date: null,          // selected day, 'YYYY-MM-DD'
    today: null,         // local today, refreshed on wake
    firstDate: null,     // earliest diary day (calendar range start)
    dayTotals: {},       // date -> {kcal, protein, fat, carbs, n}
    goals: null,
    products: [],
    frequent: [],
    period: '30',        // 7 | 30 | 90 | all
    nutrient: 'kcal',
    analytics: null,     // last /api/analytics payload
    bju: 'all',          // Б/Ж/У chart: all (stacked) | protein | fat | carbs
    recipes: [],
    day: null,           // last /api/day payload
    showTable: false,
    weightAsked: false,
    pickerMonth: null,   // 'YYYY-MM' shown in the month picker
  };

  // ---------- helpers ----------
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const localToday = () => iso(new Date());
  const weekdayIdx = (s) => (parse(s).getDay() + 6) % 7; // 0 = Monday
  const weekStart = (s) => addDays(s, -weekdayIdx(s));
  const FUTURE_DAYS = 60; // the journal can be filled ahead, for planning
  const maxDate = () => addDays(state.today, FUTURE_DAYS);

  function dateTitle(s) {
    if (s === state.today) return 'Сегодня';
    if (s === addDays(state.today, -1)) return 'Вчера';
    if (s === addDays(state.today, 1)) return 'Завтра';
    const d = parse(s);
    return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }
  const shortDate = (s) => { const d = parse(s); return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`; };
  const timeOf = (isoStr) => {
    const d = new Date(isoStr);
    return isNaN(d) ? '' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  };
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const flags = (p) => (p.lactose ? ' 🥛' : '') + (p.sugar ? ' 🍬' : '') + (p.urgent ? ' ⏰' : '');
  const plural = (n, one, few, many) => {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  };

  // ring: an SVG progress ring with a soft glow; pct may exceed 1 (drawn full, flagged by caller)
  let gid = 0;
  function ring(size, stroke, pct, color, opts = {}) {
    const r = (size - stroke) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, pct || 0));
    const id = `g${++gid}`;
    const glow = opts.glow === false ? '' : `filter="url(#${id}f)"`;
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <defs>
        <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${color}" stop-opacity=".55"/><stop offset="1" stop-color="${color}"/>
        </linearGradient>
        <filter id="${id}f" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${stroke / 2.2}" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="${stroke}"/>
      ${p > 0 ? `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="url(#${id})" stroke-width="${stroke}"
        stroke-linecap="round" stroke-dasharray="${c * p} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})" ${glow}/>` : ''}
    </svg>`;
  }

  // share of a product's calories that comes from one macro (works for per-portion and per-100 g alike)
  const kcalShare = (p, m) => {
    const t = p.protein * 4 + p.fat * 9 + p.carbs * 4;
    return t > 0 ? (p[m] * (m === 'fat' ? 9 : 4)) / t : 0;
  };
  const SORTS = { default: 'Обычно', protein: 'Больше белка', carbs: 'Больше углеводов', fat: 'Меньше жира', kcal: 'Меньше ккал' };
  // per-100 g values when the weight is known, so portion and 100 g items compare fairly
  const per100 = (p) => (p.basis === '100g' ? p : p.grams ? Object.fromEntries(MACROS.map((m) => [m, (p[m] * 100) / p.grams])) : null);
  function sortProducts(items, how) {
    if (how === 'default' || !how) return items;
    const key = {
      protein: (p) => -kcalShare(p, 'protein'),
      carbs: (p) => -kcalShare(p, 'carbs'),
      fat: (p) => kcalShare(p, 'fat'),
      kcal: (p) => { const h = per100(p); return h ? h.kcal : p.kcal; },
    }[how];
    return [...items].sort((a, b) => key(a) - key(b));
  }
  // small badge for the active sort, e.g. «Б 46%» of calories
  function sortBadge(p, how) {
    if (how === 'protein' || how === 'carbs' || how === 'fat') {
      return `<span class="badge ${how}">${MACRO_SHORT[how]} ${Math.round(kcalShare(p, how) * 100)}%</span>`;
    }
    if (how === 'kcal') { const h = per100(p); return h ? `<span class="badge kcal">${fmt(h.kcal)} / 100 г</span>` : ''; }
    return '';
  }
  const sortChips = (id, cur) => `<div class="sort-chips" id="${id}">${Object.entries(SORTS).map(([k, t]) => `<button type="button" data-s="${k}" class="${k === cur ? 'on' : ''}">${t}</button>`).join('')}</div>`;

  // ---------- modal ----------
  const modal = $('#modal');
  function openModal(html, onMount) {
    $('#modal-body').innerHTML = html;
    modal.hidden = false;
    onMount && onMount($('#modal-body'));
  }
  function closeModal() { modal.hidden = true; $('#modal-body').innerHTML = ''; }
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  // ---------- tabs ----------
  const TITLES = { journal: 'Журнал', products: 'Продукты', analytics: 'Аналитика', goals: 'Цели' };
  function showTab(tab) {
    state.tab = tab;
    $$('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${tab}`));
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    const dated = tab === 'journal';
    $('#title').textContent = TITLES[tab];
    $('#week-wrap').hidden = !dated;
    $('#month-btn').hidden = !dated;
    try { localStorage.setItem('tab', tab); } catch (_) { /* private mode */ }
    refresh();
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  function refresh() {
    const dated = state.tab === 'journal';
    $('#date-title').textContent = dated ? dateTitle(state.date) : TITLES[state.tab];
    $('#title').textContent = dated ? `${TITLES[state.tab]} · ${WEEKDAYS_LONG[weekdayIdx(state.date)]}` : ({ analytics: 'Питание в цифрах', products: 'Справочник и холодильник', goals: 'Настройки' }[state.tab]);
    if (dated) renderWeeks();
    const r = { journal: loadJournal, products: loadProducts, analytics: loadAnalytics, goals: loadGoals }[state.tab];
    r && r().catch((e) => toast(e.message));
  }

  function setDate(s) {
    if (s > maxDate()) s = maxDate();
    state.date = s;
    refresh();
  }

  // ---------- calendar: week strip + month picker ----------
  async function loadDayTotals(force = false) {
    if (state.goals && !force) return;
    const end = maxDate();
    const start = addDays(end, -400);
    const d = await api(`/api/days?start=${start}&end=${end}`);
    state.dayTotals = Object.fromEntries(d.days.map((x) => [x.date, x]));
    state.goals = d.goals;
    if (d.days.length) state.firstDate = d.days[0].date;
  }

  function dayRing(s, size, stroke) {
    const t = state.dayTotals[s];
    const goal = (state.goals && state.goals.kcal) || 1;
    const pct = t ? t.kcal / goal : 0;
    const over = pct > 1.1;
    return ring(size, stroke, pct, over ? COLOR.carbs : COLOR.kcal, { glow: false });
  }

  let weeksBuilt = null; // [startDate, endDate] currently rendered
  function renderWeeks() {
    const box = $('#weeks');
    const end = weekStart(maxDate());
    let start = weekStart(state.firstDate || addDays(state.today, -56));
    if (start > addDays(end, -56)) start = addDays(end, -56);
    const key = `${start}:${end}`;
    if (weeksBuilt !== key) {
      weeksBuilt = key;
      let html = '';
      for (let w = start; w <= end; w = addDays(w, 7)) {
        html += `<div class="week" data-week="${w}">`;
        for (let i = 0; i < 7; i++) {
          const d = addDays(w, i);
          const cls = ['day', d === state.today ? 'today' : '', d > maxDate() ? 'future' : ''].join(' ');
          html += `<button class="${cls}" data-date="${d}" ${d > maxDate() ? 'disabled' : ''}>
            <span class="wd">${WEEKDAYS[i]}</span>
            <span class="ring">${dayRing(d, 34, 3)}<b>${parse(d).getDate()}</b></span></button>`;
        }
        html += '</div>';
      }
      box.innerHTML = html;
      $$('.day', box).forEach((b) => b.addEventListener('click', () => setDate(b.dataset.date)));
    } else {
      // refresh rings in place (totals may have changed)
      $$('.day', box).forEach((b) => { b.querySelector('.ring svg').outerHTML = dayRing(b.dataset.date, 34, 3); });
    }
    $$('.day', box).forEach((b) => b.classList.toggle('on', b.dataset.date === state.date));
    const d = parse(state.date);
    $('#month-label').textContent = `${MONTHS_NOM[d.getMonth()]} ${d.getFullYear()}`;
    scrollToWeek(weekStart(state.date));
  }

  function scrollToWeek(w, smooth = false) {
    const box = $('#weeks');
    const el = box.querySelector(`[data-week="${w}"]`);
    if (!el) return;
    box.scrollTo({ left: el.offsetLeft - box.offsetLeft, behavior: smooth ? 'smooth' : 'auto' });
  }
  $('#wk-prev').addEventListener('click', () => setDate(addDays(state.date, -7)));
  $('#wk-next').addEventListener('click', () => setDate(addDays(state.date, 7)));
  // swiping the strip to another week moves the selection to the same weekday there
  let scrollTimer;
  $('#weeks').addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const box = $('#weeks');
      const i = Math.round(box.scrollLeft / box.clientWidth);
      const w = box.children[i] && box.children[i].dataset.week;
      if (w && w !== weekStart(state.date)) setDate(addDays(w, weekdayIdx(state.date)));
    }, 120);
  });

  function openMonthPicker() {
    state.pickerMonth = state.date.slice(0, 7);
    openModal('<div id="cal"></div>', () => renderMonth());
  }
  function renderMonth() {
    const [y, m] = state.pickerMonth.split('-').map(Number);
    const first = `${y}-${pad2(m)}-01`;
    const daysIn = new Date(y, m, 0).getDate();
    const lead = weekdayIdx(first);
    let cells = WEEKDAYS.map((w) => `<div class="wd">${w}</div>`).join('');
    for (let i = 0; i < lead; i++) cells += '<button class="d pad"></button>';
    for (let d = 1; d <= daysIn; d++) {
      const s = `${y}-${pad2(m)}-${pad2(d)}`;
      const future = s > maxDate();
      const cls = ['d', s === state.date ? 'on' : '', s === state.today ? 'today' : '', future ? 'future' : ''].join(' ');
      const t = state.dayTotals[s];
      const pdot = t && s < state.today && proteinOk(t.protein) ? '<i class="pdot"></i>' : '';
      cells += `<button class="${cls}" data-date="${s}" ${future ? 'disabled' : ''}>${future ? '' : dayRing(s, 40, 2.5)}<span>${d}</span>${pdot}</button>`;
    }
    const monthTotals = Object.values(state.dayTotals).filter((t) => t.date.startsWith(state.pickerMonth));
    const avg = monthTotals.length ? Math.round(monthTotals.reduce((a, t) => a + t.kcal, 0) / monthTotals.length) : null;
    $('#cal').innerHTML = `
      <div class="cal-head"><button id="cal-prev">‹</button><b>${MONTHS_NOM[m - 1]} ${y}</b><button id="cal-next">›</button></div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-legend"><span><i style="background:${COLOR.kcal}"></i>кольцо = калории от нормы</span>
        <span><i style="background:${COLOR.carbs}"></i>выше нормы</span>
        <span><i style="background:${COLOR.protein}"></i>белок ${PROTEIN_OK[0]}–${PROTEIN_OK[1]} г</span></div>
      <p class="muted" style="margin:10px 0 0">${monthTotals.length ? `${monthTotals.length} ${plural(monthTotals.length, 'день', 'дня', 'дней')} с записями, в среднем ${avg} ккал` : 'В этом месяце записей нет'}</p>`;
    $('#cal-prev').addEventListener('click', () => { state.pickerMonth = shiftMonth(state.pickerMonth, -1); renderMonth(); });
    $('#cal-next').addEventListener('click', () => { state.pickerMonth = shiftMonth(state.pickerMonth, 1); renderMonth(); });
    $$('.cal-grid .d[data-date]').forEach((b) => b.addEventListener('click', () => { closeModal(); setDate(b.dataset.date); }));
  }
  const shiftMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };
  $('#month-btn').addEventListener('click', openMonthPicker);

  // swipe left/right on the journal body to change the day
  (() => {
    let x0 = null, y0 = null;
    const m = $('main');
    m.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    m.addEventListener('touchend', (e) => {
      if (x0 == null || state.tab !== 'journal' || !modal.hidden || !$('#page').hidden) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) > 70 && Math.abs(dy) < 40 && !e.target.closest('.item')) setDate(addDays(state.date, dx < 0 ? 1 : -1));
      x0 = y0 = null;
    }, { passive: true });
  })();

  // ---------- journal ----------
  const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];
  const SLOT_TITLES = { breakfast: 'Завтрак', lunch: 'Обед', dinner: 'Ужин', snack: 'Перекусы' };
  const SLOT_ONE = { breakfast: 'Завтрак', lunch: 'Обед', dinner: 'Ужин', snack: 'Перекус' };
  const slotForHour = (h) => (h < 11 ? 'breakfast' : h < 15 ? 'lunch' : h >= 17 && h < 22 ? 'dinner' : 'snack');
  const nowHM = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const hmOf = (isoStr) => { const d = new Date(isoStr); return isNaN(d) ? '12:00' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

  // what to show as the row title: imported history has the meal name in `name` and the food in `description`
  function mealTitle(m) {
    const generic = Object.values(SLOT_ONE).concat(['Перекус 1', 'Перекус 2', 'Перекус/Другое']).includes(m.name);
    if (generic && (m.description || '').startsWith('Из FatSecret: ')) {
      return { title: m.description.slice('Из FatSecret: '.length), sub: '' };
    }
    // no clock time here: it is when the entry was typed in, not when it was eaten
    const imported = (m.description || '').endsWith('Из FatSecret'); // description already carries the amount
    return { title: m.name, sub: [m.grams && !imported ? `${fmt(m.grams)} г` : '', m.description].filter(Boolean).join(' · ') };
  }

  async function loadProductsCache(force = false) {
    if (state.products.length && !force) return;
    const d = await api('/api/products');
    state.products = d.products; state.frequent = d.frequent;
  }

  async function loadJournal() {
    await loadDayTotals();
    const [d] = await Promise.all([api(`/api/day?date=${state.date}`), loadProductsCache()]);
    state.goals = d.goals;
    state.day = d;
    if (d.count) state.dayTotals[state.date] = { date: state.date, ...d.totals, n: d.count }; else delete state.dayTotals[state.date];
    renderWeeks();
    renderHero(d);
    renderLeft(d);
    const box = $('#meals');
    box.innerHTML = '';
    $('#meals-empty').hidden = d.meals.length > 0;
    const bySlot = {};
    for (const m of d.meals) (bySlot[m.slot || 'snack'] = bySlot[m.slot || 'snack'] || []).push(m);
    for (const slot of SLOTS) {
      const items = bySlot[slot] || [];
      const sum = Object.fromEntries(MACROS.map((k) => [k, items.reduce((a, m) => a + m[k], 0)]));
      const sec = document.createElement('section');
      sec.className = `slot-sec ${items.length ? '' : 'empty'}`;
      // per-meal Б/Ж/У and share of the day's calories, as in FatSecret
      sec.innerHTML = `<div class="slot-head"><span class="slot-title">${SLOT_TITLES[slot]}</span>
          <span class="slot-sum">${items.length ? `<b>${fmt(sum.kcal)}</b> ккал${d.goals.kcal ? ` · ${Math.round((100 * sum.kcal) / d.goals.kcal)}%` : ''}` : ''}</span>
          <button class="slot-add" data-slot="${slot}" aria-label="Добавить">+</button></div>
        ${items.length ? `<div class="slot-macros"><span><i class="dot protein"></i>Б ${fmt(sum.protein)}</span><span><i class="dot fat"></i>Ж ${fmt(sum.fat)}</span><span><i class="dot carbs"></i>У ${fmt(sum.carbs)}</span></div>` : ''}
        <ul class="list"></ul>`;
      sec.querySelector('.slot-add').addEventListener('click', () => openAddSheet(slot));
      const list = sec.querySelector('ul');
      for (const m of items) list.appendChild(mealRow(m));
      box.appendChild(sec);
    }
  }

  function mealRow(m) {
    const { title, sub } = mealTitle(m);
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `
      <div class="row">
        <div class="grow"><div class="name">${esc(title)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>
        <div class="macros"><b>${fmt(m.kcal)}</b> <span class="k">ккал</span>
          <div class="mrow"><span><i class="dot protein"></i>${fmt(m.protein)}</span><span><i class="dot fat"></i>${fmt(m.fat)}</span><span><i class="dot carbs"></i>${fmt(m.carbs)}</span></div>
        </div>
        <span class="chev">›</span>
      </div>`;
    li.querySelector('.row').addEventListener('click', () => openEditSheet(m));
    return li;
  }

  // "what is left" card: the day's remainder and the foods that best fill the macro covered least so far
  // (protein or carbs, whichever has the bigger share of its goal still open). Plain arithmetic, no AI.
  const SHELF_EAT = (p) => p.shelf !== 'cook'; // raw ingredients are not suggested as a snack
  function suggestAmount(p, m, left) {
    const isPortion = p.basis === 'portion';
    if (!(p.kcal > 0) || !(p[m] > 0)) return null;
    if (isPortion) {
      let n = Math.min(2, Math.floor((left.kcal / p.kcal) * 2) / 2);
      if (p.fridge_qty > 0) n = Math.min(n, p.fridge_qty);
      if (n < 0.5) return null;
      return { portions: n, kcal: p.kcal * n, gain: p[m] * n, label: n === 1 ? '1 порция' : `${qty(n)} порц.` };
    }
    let g = Math.min((left[m] / p[m]) * 100, (left.kcal / p.kcal) * 100, 400);
    if (p.fridge_qty > 0) g = Math.min(g, p.fridge_qty);
    g = Math.floor(g / 10) * 10;
    if (g < 20) return null;
    return { grams: g, kcal: (p.kcal * g) / 100, gain: (p[m] * g) / 100, label: `${g} г` };
  }
  function renderLeft(d) {
    const box = $('#left-card');
    const left = Object.fromEntries(MACROS.map((m) => [m, Math.max(0, d.left[m])]));
    if (state.date < state.today || !d.goals.kcal) { box.innerHTML = ''; return; }
    const onDay = state.date === state.today ? 'на сегодня' : `на ${dateTitle(state.date).toLowerCase()}`;
    if (left.kcal < 60) {
      box.innerHTML = `<div class="card left-card done"><b>Норма ${onDay} закрыта</b><span>${d.totals.kcal > d.goals.kcal ? `сверх нормы ${fmt(d.totals.kcal - d.goals.kcal)} ккал` : 'осталось меньше 60 ккал'}</span></div>`;
      return;
    }
    const open = (m) => (d.goals[m] ? left[m] / d.goals[m] : 0);
    const auto = open('protein') >= open('carbs') ? 'protein' : 'carbs';
    const m = state.leftFocus || auto;
    const pool = state.products.filter((p) => SHELF_EAT(p) && (state.leftAll || p.fridge_qty > 0));
    const picks = pool.map((p) => ({ p, a: suggestAmount(p, m, left) })).filter((x) => x.a)
      .sort((a, b) => kcalShare(b.p, m) - kcalShare(a.p, m)).slice(0, 5);
    const word = { protein: 'белка', carbs: 'углеводов', fat: 'жиров' };
    box.innerHTML = `<div class="card left-card ${state.leftOpen ? 'open' : ''}">
        <button type="button" class="lc-toggle" aria-expanded="${state.leftOpen}">
          <span class="lc-head"><b>Осталось ${onDay}</b><span><b>${fmt(left.kcal)}</b> ккал</span></span>
          <span class="lc-macros">${['protein', 'fat', 'carbs'].map((k) => `<span class="${k === m ? 'on' : ''}"><i class="dot ${k}"></i>${MACRO_SHORT[k]} ${fmt(left[k])} г</span>`).join('')}
            <em>${state.leftOpen ? 'свернуть' : 'что съесть'}<i class="lc-chev">›</i></em></span>
        </button>
        ${state.leftOpen ? `<div class="lc-note">${state.leftFocus ? 'Показываю' : 'Меньше всего добрано'} ${word[m]}, вот что ${state.leftFocus ? 'богаче всего им' : 'поможет'}:</div>
        <div class="lc-focus">${['protein', 'carbs', 'fat'].map((k) => `<button type="button" data-f="${k}" class="${k === m ? 'on' : ''}"><i class="dot ${k}"></i>${MACRO_LABELS[k]}</button>`).join('')}</div>
        <div class="lc-list">${picks.map((x, i) => `<button type="button" class="lc-item" data-i="${i}">
            <span class="grow"><span class="name">${esc(x.p.name)}</span><span class="sub">${x.a.label} · ${fmt(x.a.kcal)} ккал</span></span>
            <span class="gain ${m}">+${fmt(x.a.gain)} г ${MACRO_SHORT[m]}</span></button>`).join('')
          || `<p class="muted">${state.leftAll ? 'Ничего не влезает в остаток.' : 'В холодильнике нет подходящего.'}</p>`}</div>
        <button type="button" data-all class="lc-src">${state.leftAll ? 'Показать только то, что в холодильнике' : 'Искать по всему справочнику'}</button>` : ''}
      </div>`;
    $('.lc-toggle', box).addEventListener('click', () => { state.leftOpen = !state.leftOpen; renderLeft(d); });
    if (!state.leftOpen) return;
    $$('[data-f]', box).forEach((b) => b.addEventListener('click', () => { state.leftFocus = b.dataset.f === auto ? null : b.dataset.f; renderLeft(d); }));
    $('[data-all]', box).addEventListener('click', () => { state.leftAll = !state.leftAll; renderLeft(d); });
    $$('.lc-item', box).forEach((b) => b.addEventListener('click', () => { const x = picks[Number(b.dataset.i)]; quickLog(x.p, null, x.a); }));
  }

  function renderHero(d) {
    const goal = d.goals.kcal || 1;
    const pct = d.totals.kcal / goal;
    const over = d.totals.kcal > goal;
    // one quiet status word under protein and fat, by Fred's own norms
    const status = {
      protein: proteinOk(d.totals.protein) ? '<em class="ok">в норме</em>' : d.totals.protein > PROTEIN_OK[1] ? `<em class="warn">больше ${PROTEIN_OK[1]} г</em>` : '',
      fat: d.totals.fat > FAT_MAX ? `<em class="warn">больше ${FAT_MAX} г</em>` : '',
      carbs: '',
    };
    const minis = ['protein', 'fat', 'carbs'].map((m) => {
      const g = d.goals[m] || 1, p = d.totals[m] / g;
      return `<div class="mini"><div class="r">${ring(44, 5, p, COLOR[m])}<span>${Math.round(p * 100)}%</span></div>
        <div class="t"><b>${fmt(d.totals[m])} <small>/ ${fmt(g)} г</small></b>${MACRO_LABELS[m]}${status[m]}</div></div>`;
    }).join('');
    $('#hero').innerHTML = `
      <div class="ring-big">${ring(150, 12, pct, over ? COLOR.carbs : COLOR.kcal)}
        <div style="text-align:center;position:relative"><div class="val">${fmt(d.totals.kcal)}</div>
          <div class="of">${over ? `+${fmt(d.totals.kcal - goal)} сверх нормы` : `из ${fmt(goal)} ккал`}</div>
          <div class="cap">${over ? 'перебор' : `осталось ${fmt(d.left.kcal)}`}</div></div>
      </div>
      <div class="minis">${minis}</div>`;
  }

  // add sheet: tick several foods from the fridge / catalogue or from recent entries, set each amount and
  // log them all at once; or type a meal by hand
  function defaultAmount(p) {
    if (p.basis === 'portion') return { portions: 1 };
    return { grams: p.grams ? Number(p.grams) : 100 };
  }
  const amountMacros = (p, a) => {
    const k = p.basis === 'portion' ? (a.portions != null ? a.portions : (a.grams || 0) / (p.grams || 1)) : (a.grams || 0) / 100;
    return Object.fromEntries(MACROS.map((m) => [m, p[m] * k]));
  };

  function openAddSheet(slot) {
    slot = slot || slotForHour(new Date().getHours());
    const dayNote = state.date === state.today ? '' : ` · ${dateTitle(state.date).toLowerCase()}`;
    const picked = new Map();   // product id -> {grams} | {portions}
    const pickedRecent = new Set();
    let sort = 'default', recent = null;
    openModal(`
      <h3>${SLOT_ONE[slot]}${dayNote}</h3>
      <div class="seg small" id="add-tabs"><button data-t="pick" class="on">Продукты</button><button data-t="recent">Недавнее</button><button data-t="manual">Вручную</button></div>
      <div id="add-pick">
        <input type="search" id="add-search" placeholder="Поиск по справочнику" autocomplete="off">
        ${sortChips('add-sort', sort)}
        <p class="hint">Отметь всё, что съела, и поправь количество. Запишется одним нажатием.</p>
        <div class="pick-list" id="add-list"></div>
      </div>
      <div id="add-recent" hidden><div id="copy-slot"></div><div class="pick-list" id="recent-list"><p class="muted">Загружаю…</p></div></div>
      <form class="form" id="add-manual" hidden>
        <label>Название <input name="name" required></label>
        <div class="row2"><label>Время <input name="time" type="time" value="${state.date === state.today ? nowHM() : '12:00'}"></label>
          <label>Приём <select name="slot">${SLOTS.map((s) => `<option value="${s}" ${s === slot ? 'selected' : ''}>${SLOT_ONE[s]}</option>`).join('')}</select></label></div>
        <div class="row2"><label>Ккал <input name="kcal" type="number" inputmode="decimal" step="any" required></label>
          <label>Вес, г <input name="grams" type="number" inputmode="decimal" step="any"></label></div>
        <div class="row3"><label>Белки <input name="protein" type="number" inputmode="decimal" step="any" value="0"></label>
          <label>Жиры <input name="fat" type="number" inputmode="decimal" step="any" value="0"></label>
          <label>Углев. <input name="carbs" type="number" inputmode="decimal" step="any" value="0"></label></div>
        <label>Состав <input name="description"></label>
        <button class="btn" type="submit">Записать</button>
      </form>
      <div class="pick-bar" id="pick-bar" hidden><span id="pick-sum"></span><button class="btn" id="pick-save" type="button">Записать</button></div>`, (el) => {
      let tab = 'pick';
      $$('#add-tabs button', el).forEach((b) => b.addEventListener('click', () => {
        tab = b.dataset.t;
        $$('#add-tabs button', el).forEach((x) => x.classList.toggle('on', x === b));
        $('#add-pick', el).hidden = tab !== 'pick';
        $('#add-recent', el).hidden = tab !== 'recent';
        $('#add-manual', el).hidden = tab !== 'manual';
        if (tab === 'recent') renderRecent();
        renderBar();
      }));
      const whenOf = () => `${state.date}T${state.date === state.today ? nowHM() : '12:00'}:00`;
      const done = (n) => { closeModal(); toast(n > 1 ? `Записано: ${n} ${plural(n, 'позиция', 'позиции', 'позиций')}` : 'Записано'); state.goals = null; state.products = []; loadJournal(); };

      // bottom bar: how many are ticked and their total
      const renderBar = () => {
        const bar = $('#pick-bar', el);
        let n = 0; const tot = { kcal: 0, protein: 0, fat: 0, carbs: 0 };
        if (tab === 'pick') {
          for (const [id, a] of picked) { const p = state.products.find((x) => x.id === id); if (!p) continue; n++; const mm = amountMacros(p, a); for (const k of MACROS) tot[k] += mm[k]; }
        } else if (tab === 'recent' && recent) {
          for (const i of pickedRecent) { n++; for (const k of MACROS) tot[k] += recent[i][k]; }
        }
        bar.hidden = !n;
        $('#pick-sum', el).innerHTML = `<b>${n} ${plural(n, 'позиция', 'позиции', 'позиций')}</b> · ${fmt(tot.kcal)} ккал<br><small>Б ${fmt(tot.protein)} · Ж ${fmt(tot.fat)} · У ${fmt(tot.carbs)}</small>`;
      };
      $('#pick-save', el).addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.disabled = true;
        try {
          let n = 0;
          if (tab === 'pick') {
            for (const [id, a] of picked) {
              const p = state.products.find((x) => x.id === id);
              const body = { product_id: id, slot, when: whenOf() };
              if (p.basis === 'portion') body.portions = a.portions != null ? a.portions : a.grams / p.grams; else body.grams = a.grams;
              if (!(body.portions > 0 || body.grams > 0)) continue;
              await api('/api/meals', { method: 'POST', body }); n++;
            }
          } else {
            for (const i of pickedRecent) {
              const m = recent[i];
              await api('/api/meals', { method: 'POST', body: { name: m.name, description: m.description, grams: m.grams, kcal: m.kcal, protein: m.protein, fat: m.fat, carbs: m.carbs, slot, when: whenOf() } });
              n++;
            }
          }
          done(n);
        } catch (err) { btn.disabled = false; toast(err.message); }
      });

      // "repeat": the same dishes as lately, copied with their macros (no fridge deduction)
      const renderRecent = async () => {
        const list = $('#recent-list', el);
        if (!recent) recent = (await api('/api/meals/recent')).meals;
        list.innerHTML = recent.map((m, i) => { const t = mealTitle({ ...m, logged_at: m.last }); return `<button class="pick ${pickedRecent.has(i) ? 'on' : ''}" data-i="${i}">
            <span class="tick"></span>
            <span class="grow"><span class="name">${esc(t.title)}</span><span class="sub">${fmt(m.kcal)} ккал · Б ${fmt(m.protein)} · Ж ${fmt(m.fat)} · У ${fmt(m.carbs)}${m.grams ? ` · ${fmt(m.grams)} г` : ''} · ${shortDate(m.last.slice(0, 10))}${m.n > 1 ? `, ×${m.n}` : ''}</span></span></button>`; }).join('') || '<p class="muted">За три недели записей нет.</p>';
        $$('.pick', list).forEach((b) => b.addEventListener('click', () => {
          const i = Number(b.dataset.i);
          if (pickedRecent.has(i)) pickedRecent.delete(i); else pickedRecent.add(i);
          b.classList.toggle('on', pickedRecent.has(i)); renderBar();
        }));
        renderCopy();
      };
      // FatSecret-style "copy meal": the same meal of the previous day with entries, one tap
      const renderCopy = async () => {
        const boxC = $('#copy-slot', el);
        const prev = Object.keys(state.dayTotals).filter((dt) => dt < state.date).sort().pop();
        if (!prev) return;
        const pd = await api(`/api/day?date=${prev}`);
        const items = pd.meals.filter((m) => (m.slot || 'snack') === slot);
        if (!items.length) return;
        const kc = items.reduce((a, m) => a + m.kcal, 0);
        boxC.innerHTML = `<button class="copy-btn" type="button"><span class="grow"><b>${SLOT_ONE[slot]} как ${dateTitle(prev).toLowerCase() === 'вчера' ? 'вчера' : shortDate(prev)}</b>
          <small>${items.length} ${plural(items.length, 'позиция', 'позиции', 'позиций')} · ${fmt(kc)} ккал</small></span><span class="chev">+</span></button>`;
        $('.copy-btn', boxC).addEventListener('click', async (e) => {
          e.currentTarget.disabled = true;
          for (const m of items) {
            await api('/api/meals', { method: 'POST', body: { name: m.name, description: m.description, grams: m.grams, kcal: m.kcal, protein: m.protein, fat: m.fat, carbs: m.carbs, slot, when: `${state.date}T${hmOf(m.logged_at)}:00` } });
          }
          done(items.length);
        });
      };

      const list = $('#add-list', el), search = $('#add-search', el);
      const render = () => {
        const q = search.value.trim().toLowerCase();
        let items = state.products;
        if (q) items = items.filter((p) => (p.name + ' ' + (p.aliases || '')).toLowerCase().includes(q));
        else items = [...items].sort((a, b) => (b.fridge_qty > 0) - (a.fridge_qty > 0) || (state.frequent.indexOf(a.id) + 1 || 99) - (state.frequent.indexOf(b.id) + 1 || 99));
        items = sortProducts(items, sort);
        // ticked ones stay on top so they can be adjusted
        items = [...items.filter((p) => picked.has(p.id)), ...items.filter((p) => !picked.has(p.id))];
        list.innerHTML = items.slice(0, 60).map((p) => {
          const a = picked.get(p.id);
          return `<div class="pick ${a ? 'on' : ''}" data-id="${p.id}">
            <span class="tick"></span>
            <span class="grow"><span class="name">${esc(p.name)} ${sortBadge(p, sort)}</span><span class="sub">${fmt(p.kcal)} ккал · Б ${fmt(p.protein)} · Ж ${fmt(p.fat)} · У ${fmt(p.carbs)} на ${p.basis === 'portion' ? 'порцию' : '100 г'}${p.fridge_qty > 0 ? ` · <i>${qty(p.fridge_qty)} ${p.basis === 'portion' ? 'шт' : 'г'} есть</i>` : ''}</span></span>
            ${a ? `<span class="amt"><input type="number" inputmode="decimal" step="any" min="0" value="${p.basis === 'portion' ? a.portions : a.grams}" aria-label="количество"><small>${p.basis === 'portion' ? 'порц.' : 'г'}</small></span>` : ''}
          </div>`;
        }).join('') || '<p class="muted">Ничего не нашлось. Добавь вручную.</p>';
        $$('.pick', list).forEach((row) => {
          const id = Number(row.dataset.id);
          row.addEventListener('click', (e) => {
            if (e.target.closest('.amt')) return;
            const p = state.products.find((x) => x.id === id);
            if (picked.has(id)) picked.delete(id); else picked.set(id, defaultAmount(p));
            render(); renderBar();
          });
          const inp = row.querySelector('.amt input');
          if (inp) inp.addEventListener('input', () => {
            const p = state.products.find((x) => x.id === id), v = Number(inp.value) || 0;
            picked.set(id, p.basis === 'portion' ? { portions: v } : { grams: v });
            renderBar();
          });
        });
      };
      search.addEventListener('input', render);
      $$('#add-sort button', el).forEach((b) => b.addEventListener('click', () => {
        sort = b.dataset.s; $$('#add-sort button', el).forEach((x) => x.classList.toggle('on', x === b)); render();
      }));
      render();
      $('#add-manual', el).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const body = { name: f.name.value, kcal: f.kcal.value, grams: f.grams.value || null, protein: f.protein.value, fat: f.fat.value,
          carbs: f.carbs.value, description: f.description.value, slot: f.slot.value, when: `${state.date}T${f.time.value || '12:00'}:00` };
        await api('/api/meals', { method: 'POST', body });
        done(1);
      });
    });
  }

  // edit sheet: the same food at another weight rescales macros, unless macros were typed by hand
  function openEditSheet(m) {
    const orig = { grams: Number(m.grams) || 0, kcal: m.kcal, protein: m.protein, fat: m.fat, carbs: m.carbs };
    openModal(`
      <h3>Правка записи</h3>
      <form class="form" id="edit-form">
        <label>Название <input name="name" value="${esc(m.name)}" required></label>
        <div class="row2"><label>Время <input name="time" type="time" value="${hmOf(m.logged_at)}"></label>
          <label>Приём <select name="slot">${SLOTS.map((s) => `<option value="${s}" ${s === m.slot ? 'selected' : ''}>${SLOT_ONE[s]}</option>`).join('')}</select></label></div>
        <div class="row2"><label>Вес, г <input name="grams" type="number" inputmode="decimal" step="any" value="${m.grams ?? ''}"></label>
          <label>Ккал <input name="kcal" type="number" inputmode="decimal" step="any" value="${m.kcal}" required></label></div>
        <div class="row3"><label>Белки <input name="protein" type="number" inputmode="decimal" step="any" value="${m.protein}"></label>
          <label>Жиры <input name="fat" type="number" inputmode="decimal" step="any" value="${m.fat}"></label>
          <label>Углев. <input name="carbs" type="number" inputmode="decimal" step="any" value="${m.carbs}"></label></div>
        <p class="muted" id="edit-hint" style="margin:2px 2px 0">${orig.grams ? 'Поменяешь вес, и КБЖУ пересчитаются сами.' : ''}</p>
        <label>Состав <input name="description" value="${esc(m.description || '')}"></label>
        <button class="btn" type="submit">Сохранить</button>
        <button class="btn ghost danger" type="button" id="edit-del">Удалить запись</button>
      </form>`, (el) => {
      const f = el.querySelector('form');
      let manual = false;
      ['kcal', 'protein', 'fat', 'carbs'].forEach((k) => f[k].addEventListener('input', () => { manual = true; }));
      f.grams.addEventListener('input', () => {
        const g = Number(f.grams.value);
        if (manual || !orig.grams || !g) return;
        const k = g / orig.grams;
        for (const m2 of ['kcal', 'protein', 'fat', 'carbs']) f[m2].value = fmt(orig[m2] * k, 1);
      });
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = { name: f.name.value, slot: f.slot.value, grams: f.grams.value || null, kcal: f.kcal.value, protein: f.protein.value,
          fat: f.fat.value, carbs: f.carbs.value, description: f.description.value, when: `${m.meal_date}T${f.time.value || '12:00'}:00` };
        await api(`/api/meals/${m.id}`, { method: 'PUT', body });
        closeModal(); toast('Сохранено'); state.goals = null; loadJournal();
      });
      $('#edit-del', el).addEventListener('click', async () => {
        if (!confirm('Удалить запись?')) return;
        await api(`/api/meals/${m.id}`, { method: 'DELETE' });
        closeModal(); toast('Удалено'); state.goals = null; state.products = []; loadJournal();
      });
    });
  }

  // ---------- products + recipes ----------
  // Products tab: «В холодильнике» split by shelves (my cooking, delivery, ready to eat, for cooking) and
  // «Съедено» (finished or never stocked, newest eaten first). Nothing is deleted when it runs out:
  // "+ в холодильник" on an eaten item puts it back. Recipes open as a separate full-screen page.
  const SHELF_TITLES = { home: 'Моя готовка', delivery: 'Доставка', ready: 'Готовые продукты', cook: 'Для готовки' };
  const SHELF_HINTS = { home: 'что приготовила сама', delivery: 'готовая еда из доставки', ready: 'можно съесть сразу', cook: 'продукты для готовки' };
  const shelfOf = (p) => p.shelf || 'ready';

  async function loadProducts() {
    const q = $('#product-search').value.trim();
    const [d, rr] = await Promise.all([api(`/api/products${q ? `?q=${encodeURIComponent(q)}` : ''}`), api('/api/recipes')]);
    if (!q) { state.products = d.products; state.frequent = d.frequent; }
    state.recipes = rr.recipes;
    const items = d.products;
    const box = $('#products'), chips = $('#shelf-chips');
    box.innerHTML = '';
    const fridge = items.filter((p) => p.fridge_qty > 0);
    const eaten = items.filter((p) => !(p.fridge_qty > 0));
    const seg = $('#prod-seg');
    seg.hidden = !!q;
    seg.querySelector('[data-v=fridge] small').textContent = q ? '' : fridge.length;
    seg.querySelector('[data-v=eaten] small').textContent = q ? '' : eaten.length;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.prodView));
    const rb = $('#open-recipes');
    const nDish = state.recipes.filter((r) => r.kind !== 'base').length, nBase = state.recipes.length - nDish;
    rb.hidden = !!q;
    rb.innerHTML = `<span class="rb-ico">📖</span><span class="grow"><b>Рецепты</b><small>${state.recipes.length ? `${nDish} ${plural(nDish, 'блюдо', 'блюда', 'блюд')}${nBase ? ` · ${nBase} ${plural(nBase, 'заготовка', 'заготовки', 'заготовок')}` : ''}` : 'пока пусто'}</small></span><span class="chev">›</span>`;
    const fridgeView = !q && state.prodView === 'fridge';
    // sort chips everywhere; shelf chips only for the fridge
    const shelves = Object.keys(SHELF_TITLES).map((k) => [k, fridge.filter((p) => shelfOf(p) === k).length]);
    // the sort row stays hidden behind the arrows button until it is opened or a sort is active
    const sortShown = state.sortOpen || state.sort !== 'default';
    $('#sort-btn').classList.toggle('on', sortShown);
    chips.innerHTML = `${fridgeView ? `<div class="shelf-chips">${[['all', fridge.length], ...shelves].map(([k, n]) => `<button type="button" data-sh="${k}" class="${k === state.shelf ? 'on' : ''}">${k === 'all' ? 'Всё' : SHELF_TITLES[k]} <small>${n}</small></button>`).join('')}</div>` : ''}
      ${sortShown ? sortChips('prod-sort', state.sort) : ''}`;
    $$('[data-sh]', chips).forEach((b) => b.addEventListener('click', () => { state.shelf = b.dataset.sh; loadProducts(); }));
    $$('#prod-sort button', chips).forEach((b) => b.addEventListener('click', () => {
      state.sort = b.dataset.s;
      try { localStorage.setItem('sort', state.sort); } catch (_) { /* private mode */ }
      loadProducts();
    }));
    const sorted = (arr) => sortProducts(arr, state.sort);
    const kcalOf = (arr) => arr.reduce((a, p) => a + (p.basis === 'portion' ? p.kcal * p.fridge_qty : p.kcal * p.fridge_qty / 100), 0);

    if (q) {
      if (!items.length) { box.innerHTML = '<p class="empty">Ничего не нашлось.</p>'; return; }
      box.appendChild(plist(sorted([...fridge, ...eaten])));
      return;
    }
    if (fridgeView) {
      if (!fridge.length) {
        box.innerHTML = '<p class="empty">Холодильник пуст. Всё съеденное лежит во вкладке «Съедено», оттуда можно вернуть продукт кнопкой «+ в холодильник».</p>';
        return;
      }
      const keys = state.shelf === 'all' ? Object.keys(SHELF_TITLES) : [state.shelf];
      for (const k of keys) {
        const list = fridge.filter((p) => shelfOf(p) === k);
        if (!list.length) {
          if (state.shelf !== 'all') box.insertAdjacentHTML('beforeend', `<p class="empty">На полке «${SHELF_TITLES[k]}» пусто${k === 'cook' ? '. Пришли Claude фото заказа продуктов, и он разложит их сюда.' : '.'}</p>`);
          continue;
        }
        // a shelf header folds its list away; the choice is remembered on this phone
        const closed = state.shelf === 'all' && state.closedShelves.includes(k);
        box.insertAdjacentHTML('beforeend', `<button type="button" class="cat cat-fold ${closed ? 'closed' : ''}" data-fold="${k}">${SHELF_TITLES[k]} <small>· ${list.length} · ${fmt(kcalOf(list))} ккал</small><i class="fold-chev">›</i></button>`);
        if (closed) continue;
        const group = document.createElement('div');
        group.className = 'plist';
        sorted(list).forEach((p) => group.appendChild(productItem(p)));
        box.appendChild(group);
      }
      $$('[data-fold]', box).forEach((b) => b.addEventListener('click', () => {
        const k = b.dataset.fold;
        state.closedShelves = state.closedShelves.includes(k) ? state.closedShelves.filter((x) => x !== k) : [...state.closedShelves, k];
        try { localStorage.setItem('closedShelves', JSON.stringify(state.closedShelves)); } catch (_) { /* private mode */ }
        loadProducts();
      }));
      return;
    }
    // eaten: grouped by the last day it was logged, newest first; never logged go last by category
    if (!eaten.length) { box.innerHTML = '<p class="empty">Здесь появится то, что закончилось в холодильнике.</p>'; return; }
    if (state.sort !== 'default') { box.appendChild(plist(sorted(eaten))); return; }
    const byDay = {};
    const never = [];
    for (const p of eaten) (p.last_eaten ? (byDay[p.last_eaten] = byDay[p.last_eaten] || []) : never).push(p);
    const dayLabel = (dt) => (dt === state.today ? 'Сегодня' : dt === addDays(state.today, -1) ? 'Вчера' : shortDate(dt));
    for (const dt of Object.keys(byDay).sort().reverse()) {
      box.insertAdjacentHTML('beforeend', `<div class="cat">${dayLabel(dt)}</div>`);
      box.appendChild(plist(byDay[dt]));
    }
    const cats = {};
    for (const p of never) (cats[p.category || 'Прочее'] = cats[p.category || 'Прочее'] || []).push(p);
    for (const c of Object.keys(cats).sort()) {
      box.insertAdjacentHTML('beforeend', `<div class="cat">${esc(c)} <small>· из справочника</small></div>`);
      box.appendChild(plist(cats[c]));
    }
  }
  $$('#prod-seg button').forEach((b) => b.addEventListener('click', () => {
    state.prodView = b.dataset.v;
    try { localStorage.setItem('prodView', state.prodView); } catch (_) { /* private mode */ }
    loadProducts();
  }));
  $('#open-recipes').addEventListener('click', () => openRecipes());
  $('#sort-btn').addEventListener('click', () => {
    if (state.sort !== 'default') { state.sort = 'default'; state.sortOpen = false; try { localStorage.setItem('sort', 'default'); } catch (_) { /* private mode */ } }
    else state.sortOpen = !state.sortOpen;
    loadProducts();
  });
  // one card per group, products inside separated by thin lines
  function plist(items) {
    const group = document.createElement('div');
    group.className = 'plist';
    items.forEach((p) => group.appendChild(productItem(p)));
    return group;
  }

  function productItem(p) {
    const unit = p.basis === 'portion' ? 'шт' : 'г';
    const step = p.basis === 'portion' ? 1 : 100;
    const per = p.basis === 'portion' ? `порцию${p.grams ? ` ${fmt(p.grams)} г` : ''}` : '100 г';
    const el = document.createElement('div');
    el.className = `item prod ${p.urgent ? 'urgent' : ''}`;
    el.innerHTML = `
      <div class="row">
        <div class="pmain">
          <div class="name">${esc(p.name)}<span class="flags">${flags(p)}</span></div>
          <div class="pmac"><span class="pk"><b>${fmt(p.kcal)}</b> ккал</span><span><i class="dot protein"></i>${fmt(p.protein)}</span><span><i class="dot fat"></i>${fmt(p.fat)}</span><span><i class="dot carbs"></i>${fmt(p.carbs)}</span></div>
          <div class="pper">на ${per}${sortBadge(p, state.sort)}</div>
        </div>
        <div class="pside">
          ${p.fridge_qty > 0 ? `<div class="qty"><button data-d="-${step}" aria-label="меньше">−</button><span>${qty(p.fridge_qty)} ${unit}</span><button data-d="${step}" aria-label="больше">+</button></div>`
            : `<button class="back" data-act="back">+ в холодильник</button>`}
          ${shelfOf(p) === 'cook' ? '' : '<button class="eat" data-act="eat">Съела</button>'}
        </div>
      </div>`;
    $$('.qty button', el).forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const r = await api(`/api/products/${p.id}/fridge`, { method: 'POST', body: { delta: Number(b.dataset.d) } });
      p.fridge_qty = r.product.fridge_qty;
      el.querySelector('.qty span').textContent = `${qty(p.fridge_qty)} ${unit}`;
    }));
    const back = el.querySelector('[data-act=back]');
    if (back) back.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/products/${p.id}/fridge`, { method: 'POST', body: { delta: step } });
      toast(`«${p.name}» снова в холодильнике`); loadProducts();
    });
    const eat = el.querySelector('[data-act=eat]');
    if (eat) eat.addEventListener('click', (e) => { e.stopPropagation(); quickLog(p); });
    el.querySelector('.row').addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (p.recipe_id) { const r = (state.recipes || []).find((x) => x.id === p.recipe_id); if (r) return openRecipes(r); }
      editProduct(p);
    });
    return el;
  }

  // log a catalogue product in any amount: grams or portions, linked both ways when the portion weight is known
  function quickLog(p, slot, preset) {
    if (!p) return;
    const isPortion = p.basis === 'portion';
    const pg = Number(p.grams) || 0;           // weight of one portion (may be unknown)
    const both = pg > 0;                        // can convert grams <-> portions
    slot = slot || slotForHour(new Date().getHours());
    const chips = (isPortion || both)
      ? [['¼', 0.25], ['½', 0.5], ['¾', 0.75], ['1', 1], ['1½', 1.5], ['2', 2]].map(([t, v]) => `<button type="button" data-portions="${v}">${t} порц.</button>`)
      : [50, 100, 150, 200, 250, 300].map((g) => `<button type="button" data-grams="${g}">${g} г</button>`);
    openModal(`
      <h3>${esc(p.name)}</h3>
      <p class="muted" style="margin:-6px 0 10px">${fmt(p.kcal)} ккал · Б ${fmt(p.protein)} · Ж ${fmt(p.fat)} · У ${fmt(p.carbs)} на ${isPortion ? `порцию${pg ? ` ${fmt(pg)} г` : ''}` : '100 г'}${p.fridge_qty > 0 ? ` · в холодильнике ${qty(p.fridge_qty)} ${isPortion ? 'шт' : 'г'}` : ''}</p>
      <div class="quick" id="amount-chips">${chips.join('')}</div>
      <form class="form" id="log-form">
        <div class="row2">
          ${isPortion || both ? `<label>Порций <input name="portions" type="number" inputmode="decimal" step="any" min="0" value="${preset && preset.portions ? preset.portions : preset && preset.grams && both ? fmt(preset.grams / pg, 2) : isPortion ? 1 : ''}"></label>` : ''}
          ${!isPortion || both ? `<label>Граммов <input name="grams" type="number" inputmode="decimal" step="any" min="0" value="${preset && preset.grams ? preset.grams : preset && preset.portions && both ? fmt(preset.portions * pg) : isPortion ? (pg || '') : (pg || 100)}"></label>` : ''}
        </div>
        <div class="row2"><label>Время <input name="time" type="time" value="${state.date === state.today ? nowHM() : '12:00'}"></label>
          <label>Приём <select name="slot">${SLOTS.map((s) => `<option value="${s}" ${s === slot ? 'selected' : ''}>${SLOT_ONE[s]}</option>`).join('')}</select></label></div>
        <div class="preview" id="amount-preview"></div>
        <button class="btn" type="submit">Записать в журнал</button>
      </form>`, (el) => {
      const f = el.querySelector('form');
      const pIn = f.portions, gIn = f.grams;
      const amount = () => {
        const portions = pIn ? Number(pIn.value) : 0, grams = gIn ? Number(gIn.value) : 0;
        if (isPortion) return { portions: portions || (both && grams ? grams / pg : 0), grams: grams || (portions * pg) };
        return { grams: grams || (both ? portions * pg : 0), portions: both ? (grams || portions * pg) / pg : null };
      };
      const preview = () => {
        const a = amount();
        const factor = isPortion ? a.portions : a.grams / 100;
        const v = (k) => fmt(p[k] * factor);
        // as in FatSecret: share of the daily norm, and what stays open after this entry (today only)
        const g = state.goals || (state.day && state.day.goals) || {};
        const day = state.day && state.day.date === state.date ? state.day : null;
        const after = day ? Object.fromEntries(MACROS.map((k) => [k, (day.left[k] || 0) - p[k] * factor])) : null;
        el.querySelector('#amount-preview').innerHTML = factor > 0
          ? `<div>Будет записано: <b>${v('kcal')} ккал</b> · Б ${v('protein')} · Ж ${v('fat')} · У ${v('carbs')}${a.grams ? ` · ${fmt(a.grams)} г` : ''}</div>
             ${g.kcal ? `<div class="pv-bars">${MACROS.map((k) => `<span><i class="${k}" style="width:${Math.min(100, (100 * p[k] * factor) / (g[k] || 1)).toFixed(0)}%"></i></span><em>${Math.round((100 * p[k] * factor) / (g[k] || 1))}%</em>`).join('')}</div>
             <small>доля дневной нормы: ккал · Б · Ж · У</small>` : ''}
             ${after ? `<div class="pv-after">После останется: <b>${fmt(after.kcal)} ккал</b> · Б ${fmt(after.protein)} · Ж ${fmt(after.fat)} · У ${fmt(after.carbs)}</div>` : ''}`
          : 'Укажи количество';
      };
      // typing in one field recalculates the other
      pIn && pIn.addEventListener('input', () => { if (both && gIn) gIn.value = pIn.value ? fmt(Number(pIn.value) * pg) : ''; preview(); });
      gIn && gIn.addEventListener('input', () => { if (both && pIn) pIn.value = gIn.value ? fmt(Number(gIn.value) / pg, 2) : ''; preview(); });
      $$('#amount-chips button', el).forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.portions) { pIn.value = b.dataset.portions; if (both && gIn) gIn.value = fmt(Number(b.dataset.portions) * pg); }
        else { gIn.value = b.dataset.grams; if (both && pIn) pIn.value = fmt(Number(b.dataset.grams) / pg, 2); }
        preview();
      }));
      preview();
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const a = amount();
        const body = { product_id: p.id, slot: f.slot.value, when: `${state.date}T${f.time.value || '12:00'}:00` };
        if (isPortion) { if (!a.portions) return toast('Укажи количество'); body.portions = a.portions; }
        else { if (!a.grams) return toast('Укажи количество'); body.grams = a.grams; }
        const r = await api('/api/meals', { method: 'POST', body });
        closeModal(); toast(`Записано: ${fmt(r.meal.kcal)} ккал`);
        state.goals = null; state.products = []; // totals and fridge changed
        if (state.tab === 'products') loadProducts(); else loadJournal();
      });
    });
  }

  function editProduct(p) {
    const isNew = !p;
    p = p || { basis: 'portion', kcal: 0, protein: 0, fat: 0, carbs: 0, shelf: state.shelf !== 'all' ? state.shelf : 'ready' };
    openModal(`
      <h3>${isNew ? 'Новый продукт' : 'Продукт'}</h3>
      <form class="form" id="product-form">
        <label>Название <input name="name" value="${esc(p.name || '')}" required autocomplete="off"></label>
        ${isNew ? '<div class="similar" id="np-similar" hidden></div>' : ''}
        <label>Полка в холодильнике
          <select name="shelf">${Object.entries(SHELF_TITLES).map(([k, t]) => `<option value="${k}" ${shelfOf(p) === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Значения указаны
          <select name="basis"><option value="portion" ${p.basis === 'portion' ? 'selected' : ''}>на порцию</option>
            <option value="100g" ${p.basis === '100g' ? 'selected' : ''}>на 100 г</option></select></label>
        <div class="row2"><label>Ккал <input name="kcal" type="number" inputmode="decimal" step="any" value="${p.kcal}"></label>
          <label>Вес порции, г <input name="grams" type="number" inputmode="decimal" step="any" value="${p.grams ?? ''}"></label></div>
        <div class="row3"><label>Белки <input name="protein" type="number" inputmode="decimal" step="any" value="${p.protein}"></label>
          <label>Жиры <input name="fat" type="number" inputmode="decimal" step="any" value="${p.fat}"></label>
          <label>Углев. <input name="carbs" type="number" inputmode="decimal" step="any" value="${p.carbs}"></label></div>
        <div class="row2"><label>Категория <input name="category" value="${esc(p.category || '')}"></label>
          <label>Синонимы <input name="aliases" value="${esc(p.aliases || '')}"></label></div>
        <div class="checks"><label class="chk"><input type="checkbox" name="lactose" ${p.lactose ? 'checked' : ''}> 🥛 лактоза</label>
          <label class="chk"><input type="checkbox" name="sugar" ${p.sugar ? 'checked' : ''}> 🍬 сахар</label>
          ${isNew ? '' : `<label class="chk"><input type="checkbox" name="urgent" ${p.urgent ? 'checked' : ''}> ⏰ съесть срочно</label>`}</div>
        ${isNew ? '<label>Сразу в холодильник (шт или г) <input name="fridge_add" type="number" inputmode="decimal" value="0"></label>' : ''}
        <button class="btn" type="submit">Сохранить</button>
        ${isNew ? '' : '<button class="btn ghost danger" type="button" id="p-del">Удалить из справочника</button>'}
      </form>`, (el) => {
      // a new product that looks like one already in the catalogue: offer the existing one instead of a twin
      const sim = $('#np-similar', el);
      if (sim) {
        const words = (t) => new Set(t.toLowerCase().replace(/ё/g, 'е').replace(/(\d)\.(\d)/g, '$1,$2').split(/[^\p{L}\d%,]+/u).filter((w) => w.length >= 3 || /\d/.test(w)));
        el.querySelector('[name=name]').addEventListener('input', (e) => {
          const w = words(e.target.value);
          const hits = w.size < 2 ? [] : state.products.map((x) => { const xw = words(x.name); let n = 0; w.forEach((k) => { if (xw.has(k)) n += 1; }); return { x, n }; })
            .filter((h) => h.n >= Math.min(2, w.size)).sort((a, b) => b.n - a.n).slice(0, 3);
          sim.hidden = !hits.length;
          sim.innerHTML = hits.length ? `<span>Похоже, уже есть в справочнике:</span>${hits.map((h, k) => `<button type="button" data-k="${k}">${esc(h.x.name)}</button>`).join('')}` : '';
          $$('button', sim).forEach((b) => b.addEventListener('click', () => editProduct(hits[Number(b.dataset.k)].x)));
        });
      }
      el.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const body = {
          name: f.name.value, basis: f.basis.value, kcal: f.kcal.value, grams: f.grams.value || null,
          protein: f.protein.value, fat: f.fat.value, carbs: f.carbs.value, category: f.category.value,
          aliases: f.aliases.value, lactose: f.lactose.checked, sugar: f.sugar.checked, shelf: f.shelf.value,
          fridge_add: f.fridge_add ? f.fridge_add.value : 0,
        };
        await api('/api/products', { method: 'POST', body });
        if (f.urgent && f.urgent.checked !== !!p.urgent) await api(`/api/products/${p.id}/flags`, { method: 'POST', body: { urgent: f.urgent.checked } });
        closeModal(); toast('Сохранено'); state.products = []; loadProducts();
      });
      const del = $('#p-del', el);
      if (del) del.addEventListener('click', async () => {
        if (!confirm(`Удалить «${p.name}» из справочника?`)) return;
        await api(`/api/products/${p.id}`, { method: 'DELETE' });
        closeModal(); toast('Удалено'); state.products = []; loadProducts();
      });
    });
  }
  $('#add-product').addEventListener('click', () => openModal(`
    <h3>Что добавить?</h3>
    <button class="btn" id="np-product">Продукт или готовое блюдо</button>
    <button class="btn ghost" id="np-recipe">Рецепт (блюдо из ингредиентов)</button>`, (el) => {
    $('#np-product', el).addEventListener('click', () => editProduct(null));
    $('#np-recipe', el).addEventListener('click', () => openRecipeEditor(null));
  }));
  let searchTimer;
  $('#product-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadProducts, 250); });

  // ----- recipes: a separate full-screen page with the list and each recipe's card -----
  const page = $('#page');
  let pageBack = null;
  function openPage(title, html, onMount, back) {
    $('#page-title').textContent = title;
    $('#page-body').innerHTML = html;
    $('#page-act').innerHTML = '';
    pageBack = back || null;
    page.hidden = false;
    document.body.classList.add('page-open');
    page.scrollTop = 0;
    onMount && onMount($('#page-body'));
  }
  function closePage() { page.hidden = true; document.body.classList.remove('page-open'); $('#page-body').innerHTML = ''; }
  $('#page-back').addEventListener('click', () => (pageBack ? pageBack() : closePage()));

  let recipeKind = 'dish', recipeQuery = '';
  async function openRecipes(r) {
    if (!state.products.length) await loadProductsCache(true);
    if (!state.recipes || !state.recipes.length) state.recipes = (await api('/api/recipes')).recipes;
    if (r) return openRecipeCard(r, true);
    const rs = state.recipes;
    openPage('Рецепты', `
      <input type="search" id="rcp-search" placeholder="Найти рецепт или ингредиент" autocomplete="off" value="${esc(recipeQuery)}">
      <div class="seg small" id="rcp-kind"><button data-k="dish">Блюда <small>${rs.filter((x) => x.kind !== 'base').length}</small></button><button data-k="base">Заготовки <small>${rs.filter((x) => x.kind === 'base').length}</small></button></div>
      <p class="hint" id="rcp-hint"></p>
      <div id="rcp-list"></div>`, (el) => {
      $('#page-act').innerHTML = '<button class="page-new" id="rcp-new">+ новый</button>';
      $('#rcp-new').addEventListener('click', () => openRecipeEditor(null));
      const render = () => {
        $$('#rcp-kind button', el).forEach((b) => b.classList.toggle('on', b.dataset.k === recipeKind));
        $('#rcp-hint', el).textContent = recipeKind === 'base'
          ? 'Заготовки — то, что готовится партией и идёт в блюда: блины, курица, отварная крупа. КБЖУ на 100 г готового.'
          : 'Блюда — готовые порции. Нажми на блюдо, чтобы увидеть состав и записать его.';
        const q = recipeQuery.trim().toLowerCase();
        const list = rs.filter((x) => (x.kind === 'base') === (recipeKind === 'base'))
          .filter((x) => !q || (x.name + ' ' + x.items.map((i) => i.name).join(' ')).toLowerCase().includes(q))
          .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        const box = $('#rcp-list', el);
        box.innerHTML = list.map((x) => {
          const p = state.products.find((pp) => pp.id === x.product_id);
          const portion = p && p.basis === 'portion';
          const t = x.totals;
          const share = (k) => { const tt = t.protein * 4 + t.fat * 9 + t.carbs * 4 || 1; return (t[k] * (k === 'fat' ? 9 : 4) * 100) / tt; };
          return `<button class="rcp card" data-id="${x.id}">
            <span class="rcp-top"><b>${esc(x.name)}</b>${p && p.fridge_qty > 0 ? `<i class="in">в холодильнике</i>` : ''}</span>
            <span class="rcp-sub">${portion || x.kind !== 'base'
              ? `<b>${fmt(t.kcal)}</b> ккал · Б ${fmt(t.protein)} · Ж ${fmt(t.fat)} · У ${fmt(t.carbs)} · ${fmt(x.cooked_grams)} г`
              : `<b>${fmt(x.per100.kcal)}</b> ккал · Б ${fmt(x.per100.protein, 1)} · Ж ${fmt(x.per100.fat, 1)} · У ${fmt(x.per100.carbs, 1)} на 100 г`}</span>
            <span class="share">${['protein', 'fat', 'carbs'].map((k) => `<i class="${k}" style="width:${share(k).toFixed(1)}%"></i>`).join('')}</span>
            <span class="rcp-ing">${esc(x.items.map((i) => i.name.replace(/\s*\(.*?\)\s*/g, ' ').trim()).join(', '))}</span>
          </button>`;
        }).join('') || `<p class="empty">${q ? 'Ничего не нашлось.' : 'Пока пусто. Нажми «+ новый» или пришли Claude фото готовки.'}</p>`;
        $$('.rcp', box).forEach((b) => b.addEventListener('click', () => openRecipeCard(rs.find((x) => x.id === Number(b.dataset.id)))));
      };
      $$('#rcp-kind button', el).forEach((b) => b.addEventListener('click', () => { recipeKind = b.dataset.k; render(); }));
      $('#rcp-search', el).addEventListener('input', (e) => { recipeQuery = e.target.value; render(); });
      render();
    });
  }

  function openRecipeCard(r, direct) {
    const p = state.products.find((x) => x.id === r.product_id);
    const portion = p && p.basis === 'portion';
    const t = r.totals, h = r.per100;
    const g300 = h.kcal ? (300 * 100) / h.kcal : 0, g400 = h.kcal ? (400 * 100) / h.kcal : 0;
    openPage(r.kind === 'base' ? 'Заготовка' : 'Блюдо', `
      <h2 class="rc-title">${esc(r.name)}</h2>
      <div class="card rc-tot">
        <div class="rc-k"><b>${fmt(t.kcal)}</b><span>ккал всё блюдо</span></div>
        <div class="rc-m">${['protein', 'fat', 'carbs'].map((k) => `<span><i class="dot ${k}"></i><b>${fmt(t[k])}</b> г<small>${MACRO_LABELS[k].toLowerCase()}</small></span>`).join('')}</div>
        <div class="rc-foot">Готовое ${fmt(r.cooked_grams)} г${r.raw_grams && Math.abs(r.raw_grams - r.cooked_grams) > 1 ? ` · сырые ингредиенты ${fmt(r.raw_grams)} г` : ''}</div>
      </div>
      <div class="rc-facts">
        <div><span>На 100 г готового</span><b>${fmt(h.kcal)} ккал</b> · Б ${fmt(h.protein, 1)} · Ж ${fmt(h.fat, 1)} · У ${fmt(h.carbs, 1)}</div>
        ${h.kcal ? `<div><span>Сколько съесть</span>на 300 ккал <b>${fmt(g300)} г</b> · на 400 ккал <b>${fmt(g400)} г</b></div>` : ''}
        ${p && p.fridge_qty > 0 ? `<div><span>В холодильнике</span><b>${qty(p.fridge_qty)} ${portion ? 'шт' : 'г'}</b></div>` : ''}
      </div>
      <div class="cat">Состав</div>
      <ul class="card rc-items">${r.items.map((i) => `<li><span class="grow"><span class="name">${esc(i.name)}</span>${i.note ? `<span class="note">${esc(i.note)}</span>` : ''}
          <span class="sub">${fmt(i.kcal)} ккал · Б ${fmt(i.protein, 1)} · Ж ${fmt(i.fat, 1)} · У ${fmt(i.carbs, 1)}</span></span><b>${fmt(i.grams)} г</b></li>`).join('')}</ul>
      ${r.note ? `<p class="muted">${esc(r.note)}</p>` : ''}
      <div class="rc-actions">
        ${p ? '<button class="btn" id="rc-eat">Съела</button>' : ''}
        ${p && !/ильнур/i.test(r.name) ? `<button class="btn ghost" id="rc-fridge">+ в холодильник</button>` : ''}
        <button class="btn ghost" id="rc-edit">Изменить рецепт</button>
      </div>`, (el) => {
      const eat = $('#rc-eat', el);
      if (eat) eat.addEventListener('click', () => quickLog(p));
      const fr = $('#rc-fridge', el);
      if (fr) fr.addEventListener('click', async () => {
        await api(`/api/products/${p.id}/fridge`, { method: 'POST', body: { delta: portion ? 1 : r.cooked_grams } });
        state.products = []; await loadProductsCache(true);
        toast(`«${r.name}» в холодильнике`); openRecipeCard(r, direct);
      });
      $('#rc-edit', el).addEventListener('click', () => openRecipeEditor(r));
    }, direct ? null : () => openRecipes());
  }

  async function afterRecipeChange(saved) {
    await loadProductsCache(true);
    state.recipes = (await api('/api/recipes')).recipes;
    if (!page.hidden) { if (saved) openRecipeCard(saved); else openRecipes(); }
    if (state.tab === 'products') loadProducts();
  }

  // ingredient line -> absolute macros for its grams
  function lineMacros(line) {
    if (line.product) {
      const p = line.product, g = Number(line.grams) || 0;
      const k = p.basis === 'portion' ? (p.grams ? g / p.grams : 0) : g / 100;
      return { kcal: p.kcal * k, protein: p.protein * k, fat: p.fat * k, carbs: p.carbs * k };
    }
    const g = Number(line.grams) || 0, k = g / 100;
    return { kcal: (line.per.kcal || 0) * k, protein: (line.per.protein || 0) * k, fat: (line.per.fat || 0) * k, carbs: (line.per.carbs || 0) * k };
  }

  function openRecipeEditor(r) {
    const lines = (r ? r.items : []).map((it) => {
      const p = it.product_id ? state.products.find((x) => x.id === it.product_id) : null;
      return p ? { product: p, name: p.name, grams: it.grams, note: it.note } : { name: it.name, note: it.note, grams: it.grams, per: { kcal: it.grams ? it.kcal * 100 / it.grams : 0, protein: it.grams ? it.protein * 100 / it.grams : 0, fat: it.grams ? it.fat * 100 / it.grams : 0, carbs: it.grams ? it.carbs * 100 / it.grams : 0 } };
    });
    openModal(`
      <h3>${r ? 'Рецепт' : 'Новый рецепт'}</h3>
      <form class="form" id="recipe-form">
        <label>Название <input name="name" value="${esc(r ? r.name : '')}" required placeholder="например: Плов с курицей"></label>
        <label>Что это <select name="kind"><option value="dish">Блюдо: готовая порция</option><option value="base" ${r && r.kind === 'base' ? 'selected' : ''}>Заготовка: идёт в другие блюда</option></select></label>
        <div class="cat" style="margin-top:12px">Ингредиенты</div>
        <div id="rc-lines"></div>
        <div class="row2" style="margin-top:6px"><button type="button" class="btn ghost" id="rc-add-cat">+ из справочника</button><button type="button" class="btn ghost" id="rc-add-man">+ вручную</button></div>
        <div id="rc-picker" hidden><input type="search" id="rc-search" placeholder="Найти продукт" autocomplete="off"><div class="pick-list" id="rc-list"></div></div>
        <div id="rc-manual" hidden class="card" style="padding:10px;margin-top:8px">
          <label>Название <input id="rm-name"></label>
          <div class="row2"><label>Грамм <input id="rm-grams" type="number" inputmode="decimal" step="any"></label><label>Ккал на 100 г <input id="rm-kcal" type="number" inputmode="decimal" step="any"></label></div>
          <div class="row3"><label>Б на 100 г <input id="rm-protein" type="number" inputmode="decimal" step="any" value="0"></label><label>Ж на 100 г <input id="rm-fat" type="number" inputmode="decimal" step="any" value="0"></label><label>У на 100 г <input id="rm-carbs" type="number" inputmode="decimal" step="any" value="0"></label></div>
          <button type="button" class="btn ghost" id="rm-ok">Добавить ингредиент</button>
        </div>
        <div class="cat" style="margin-top:14px">Готовка</div>
        <div class="row2"><label>Сырой вес, г <input name="raw" type="number" readonly value=""></label>
          <label>Готовое блюдо, г <input name="cooked" type="number" inputmode="decimal" step="any" value="${r ? r.cooked_grams : ''}" placeholder="взвесь после готовки"></label></div>
        <label>Обычная порция, г (необязательно) <input name="portion" type="number" inputmode="decimal" step="any" value="${r && r.portion_grams ? r.portion_grams : ''}"></label>
        <div class="recipe-sum card" id="rc-sum"></div>
        <label class="chk"><input type="checkbox" name="deduct"> Списать ингредиенты из холодильника</label>
        <label class="chk"><input type="checkbox" name="to_fridge"> Положить готовое блюдо в холодильник</label>
        <button class="btn" type="submit">${r ? 'Сохранить' : 'Сохранить рецепт'}</button>
        ${r ? '<button class="btn ghost" type="button" id="rc-dup">Сохранить как новый</button><button class="btn ghost danger" type="button" id="rc-del">Удалить рецепт</button>' : ''}
      </form>`, (el) => {
      const f = el.querySelector('form');
      const linesBox = $('#rc-lines', el);
      const renderLines = () => {
        linesBox.innerHTML = lines.map((l, i) => {
          const m = lineMacros(l);
          return `<div class="rc-line"><span class="grow"><span class="name">${esc(l.name)}</span><span class="sub">${fmt(m.kcal)} ккал · Б ${fmt(m.protein)} · Ж ${fmt(m.fat)} · У ${fmt(m.carbs)}</span></span>
            <input type="number" inputmode="decimal" step="any" value="${l.grams}" data-i="${i}" aria-label="грамм"><span class="unit">г</span><button type="button" class="x" data-x="${i}">×</button></div>`;
        }).join('') || '<p class="muted">Пока пусто. Добавь ингредиенты.</p>';
        $$('input[data-i]', linesBox).forEach((inp) => inp.addEventListener('input', () => { lines[Number(inp.dataset.i)].grams = Number(inp.value) || 0; renderSum(); }));
        $$('button[data-x]', linesBox).forEach((b) => b.addEventListener('click', () => { lines.splice(Number(b.dataset.x), 1); renderLines(); }));
        renderSum();
      };
      const renderSum = () => {
        const raw = lines.reduce((a, l) => a + (Number(l.grams) || 0), 0);
        f.raw.value = fmt(raw);
        const cooked = Number(f.cooked.value) || raw;
        const tot = lines.reduce((a, l) => { const m = lineMacros(l); for (const k in m) a[k] += m[k]; return a; }, { kcal: 0, protein: 0, fat: 0, carbs: 0 });
        const per = cooked ? { kcal: tot.kcal * 100 / cooked, protein: tot.protein * 100 / cooked, fat: tot.fat * 100 / cooked, carbs: tot.carbs * 100 / cooked } : tot;
        const portion = Number(f.portion.value) || 0;
        const g400 = per.kcal ? 400 * 100 / per.kcal : 0, g300 = per.kcal ? 300 * 100 / per.kcal : 0;
        $('#rc-sum', el).innerHTML = lines.length ? `
          <div><span>Всё блюдо</span><b>${fmt(tot.kcal)} ккал</b> · Б ${fmt(tot.protein)} · Ж ${fmt(tot.fat)} · У ${fmt(tot.carbs)}</div>
          <div><span>На 100 г готового</span><b>${fmt(per.kcal)} ккал</b> · Б ${fmt(per.protein, 1)} · Ж ${fmt(per.fat, 1)} · У ${fmt(per.carbs, 1)}${raw && cooked && Math.abs(cooked - raw) > 1 ? ` <small>(вес после готовки ${cooked > raw ? '+' : ''}${Math.round((cooked / raw - 1) * 100)}%)</small>` : ''}</div>
          ${portion ? `<div><span>Порция ${fmt(portion)} г</span><b>${fmt(per.kcal * portion / 100)} ккал</b> · Б ${fmt(per.protein * portion / 100)} · Ж ${fmt(per.fat * portion / 100)} · У ${fmt(per.carbs * portion / 100)}</div>` : ''}
          ${per.kcal ? `<div><span>Сколько съесть</span>на 300 ккал: <b>${fmt(g300)} г</b> · на 400 ккал: <b>${fmt(g400)} г</b></div>` : ''}` : '';
      };
      f.cooked.addEventListener('input', renderSum);
      f.portion.addEventListener('input', renderSum);
      // picker from the catalogue
      const picker = $('#rc-picker', el), list = $('#rc-list', el), search = $('#rc-search', el);
      const renderPick = () => {
        const q = search.value.trim().toLowerCase();
        let items = state.products.filter((p) => !(r && p.id === r.product_id));
        items = q ? items.filter((p) => (p.name + ' ' + (p.aliases || '')).toLowerCase().includes(q)) : [...items].sort((a, b) => (b.fridge_qty > 0) - (a.fridge_qty > 0));
        list.innerHTML = items.slice(0, 30).map((p) => `<button type="button" class="pick" data-id="${p.id}"><span class="grow"><span class="name">${esc(p.name)}</span><span class="sub">${fmt(p.kcal)} ккал на ${p.basis === 'portion' ? `порцию${p.grams ? ` ${fmt(p.grams)} г` : ''}` : '100 г'}${p.fridge_qty > 0 ? ` · <i>есть ${qty(p.fridge_qty)} ${p.basis === 'portion' ? 'шт' : 'г'}</i>` : ''}</span></span><span class="chev">+</span></button>`).join('') || '<p class="muted">Не нашлось. Добавь вручную.</p>';
        $$('.pick', list).forEach((b) => b.addEventListener('click', () => {
          const p = state.products.find((x) => x.id === Number(b.dataset.id));
          if (p.basis === 'portion' && !p.grams) { toast('У этой позиции нет веса порции, добавь вручную в граммах'); return; }
          lines.push({ product: p, name: p.name, grams: p.basis === 'portion' ? p.grams : 100 });
          picker.hidden = true; renderLines();
        }));
      };
      $('#rc-add-cat', el).addEventListener('click', () => { picker.hidden = !picker.hidden; $('#rc-manual', el).hidden = true; if (!picker.hidden) { renderPick(); search.focus(); } });
      search.addEventListener('input', renderPick);
      $('#rc-add-man', el).addEventListener('click', () => { $('#rc-manual', el).hidden = !$('#rc-manual', el).hidden; picker.hidden = true; });
      $('#rm-ok', el).addEventListener('click', () => {
        const name = $('#rm-name', el).value.trim(), grams = Number($('#rm-grams', el).value);
        if (!name || !grams) return toast('Нужны название и граммы');
        lines.push({ name, grams, per: { kcal: Number($('#rm-kcal', el).value) || 0, protein: Number($('#rm-protein', el).value) || 0, fat: Number($('#rm-fat', el).value) || 0, carbs: Number($('#rm-carbs', el).value) || 0 } });
        ['rm-name', 'rm-grams', 'rm-kcal'].forEach((id) => { $(`#${id}`, el).value = ''; });
        $('#rc-manual', el).hidden = true; renderLines();
      });
      const payload = () => ({
        name: f.name.value, kind: f.kind.value, cooked_grams: Number(f.cooked.value) || null, portion_grams: Number(f.portion.value) || null,
        deduct: f.deduct.checked, to_fridge: f.to_fridge.checked,
        items: lines.map((l) => { const m = lineMacros(l); return { product_id: l.product ? l.product.id : null, name: l.name, note: l.note || '', grams: Number(l.grams) || 0, kcal: m.kcal, protein: m.protein, fat: m.fat, carbs: m.carbs }; }),
      });
      const save = async (asNew) => {
        if (!lines.length) return toast('Добавь хотя бы один ингредиент');
        const body = payload();
        if (r && !asNew) body.id = r.id;
        if (asNew && r && body.name === r.name) body.name += ' (копия)';
        const saved = (await api('/api/recipes', { method: 'POST', body })).recipe;
        closeModal(); toast('Рецепт сохранён'); await afterRecipeChange(saved);
      };
      f.addEventListener('submit', (e) => { e.preventDefault(); save(false); });
      if (r) {
        $('#rc-dup', el).addEventListener('click', () => save(true));
        $('#rc-del', el).addEventListener('click', async () => {
          if (!confirm(`Удалить рецепт «${r.name}»?`)) return;
          await api(`/api/recipes/${r.id}`, { method: 'DELETE' });
          closeModal(); toast('Удалено'); await afterRecipeChange(null);
        });
      }
      renderLines();
    });
  }

  // ---------- analytics ----------
  $$('#period button').forEach((b) => b.addEventListener('click', () => {
    state.period = b.dataset.period;
    $$('#period button').forEach((x) => x.classList.toggle('on', x === b));
    loadAnalytics();
  }));

  async function loadAnalytics() {
    const box = $('#analytics');
    box.style.opacity = '.5';
    try {
      state.analytics = await api(`/api/analytics?days=${state.period}`);
      renderAnalytics();
    } finally { box.style.opacity = ''; }
  }

  // group a daily series into ISO weeks; every nutrient = average over logged days of that week
  function weeklyAll(series) {
    const out = [];
    for (const s of series) {
      const w = weekStart(s.date);
      let cur = out[out.length - 1];
      if (!cur || cur.date !== w) { cur = { date: w, n: 0, sum: { kcal: 0, protein: 0, fat: 0, carbs: 0 } }; out.push(cur); }
      if (s.n && !s.partial) { cur.n += 1; for (const m of MACROS) cur.sum[m] += s[m]; }
    }
    return out.map((w) => ({ date: w.date, n: w.n, ...Object.fromEntries(MACROS.map((m) => [m, w.n ? w.sum[m] / w.n : null])) }));
  }

  const PERIOD_NAME = { 7: 'за неделю', 30: 'за месяц', 90: 'за 3 месяца', all: 'за всё время' };

  function renderAnalytics() {
    const a = state.analytics, g = a.goals;
    // today is not over yet: it is drawn faded and left out of every average, count and insight
    const logged = a.series.filter((s) => s.n && !s.partial);
    const periodName = PERIOD_NAME[state.period];
    const useWeekly = a.series.length > 120;
    const pts = useWeekly ? weeklyAll(a.series)
      : a.series.map((s) => ({ date: s.date, n: s.n, partial: !!s.partial, ...Object.fromEntries(MACROS.map((m) => [m, s.n ? s[m] : null])) }));
    // a past day is judged against the goals that were set on that day
    const hist = a.goals_history || [];
    const goalOn = (d) => { let r = hist[0] || g; for (const h of hist) { if (h.date <= d) r = h; else break; } return r; };
    const inKcal = logged.filter((s) => { const k = goalOn(s.date).kcal; return Math.abs(s.kcal - k) <= k * 0.1; }).length;
    const inProt = logged.filter((s) => proteinOk(s.protein)).length;
    const fatOver = logged.filter((s) => s.fat > FAT_MAX).length;
    const pct = (m) => (g[m] ? Math.round((100 * a.avg[m]) / g[m]) : null);
    const over = a.avg.kcal > g.kcal * 1.1;
    const best = logged.reduce((b, s) => (!b || s.kcal > b.kcal ? s : b), null);
    const low = logged.reduce((b, s) => (!b || s.kcal < b.kcal ? s : b), null);
    const share = (() => {
      const p = a.avg.protein * 4, f = a.avg.fat * 9, c = a.avg.carbs * 4, t = p + f + c || 1;
      const gp = g.protein * 4, gf = g.fat * 9, gc = g.carbs * 4, gt = gp + gf + gc || 1;
      return { fact: { protein: p / t, fat: f / t, carbs: c / t }, goal: { protein: gp / gt, fat: gf / gt, carbs: gc / gt } };
    })();
    const w = a.weight, ms = a.measurements;
    const wDelta = w.length > 1 ? w[w.length - 1].kg - w[0].kg : null;
    const nutrBar = (m) => {
      const p = g[m] ? a.avg[m] / g[m] : 0;
      return `<div class="sb"><span class="l"><i class="dot ${m}"></i>${MACRO_LABELS[m]}</span>
        <span class="v"><b>${fmt(a.avg[m])}</b> / ${fmt(g[m])} г</span>
        <div class="bar"><i class="${m}" style="width:${Math.min(100, p * 100).toFixed(1)}%"></i><em></em></div></div>`;
    };
    const insights = (() => {
      const out = [];
      const wd = a.weekday.map((x, i) => ({ i, ...x })).filter((x) => x.n > 0);
      if (wd.length >= 3) {
        const hi = wd.reduce((b, x) => (x.kcal > b.kcal ? x : b)), lo = wd.reduce((b, x) => (x.kcal < b.kcal ? x : b));
        if (hi.i !== lo.i) out.push(`Самый сытный день недели — <b>${WEEKDAYS_LONG[hi.i]}</b> (${fmt(hi.kcal)} ккал), самый лёгкий — <b>${WEEKDAYS_LONG[lo.i]}</b> (${fmt(lo.kcal)}).`);
        const wk = wd.filter((x) => x.i < 5), we = wd.filter((x) => x.i >= 5);
        if (wk.length && we.length) {
          const avgOf = (arr) => arr.reduce((s, x) => s + x.kcal * x.n, 0) / arr.reduce((s, x) => s + x.n, 0);
          const d = Math.round((100 * (avgOf(we) - avgOf(wk))) / avgOf(wk));
          if (Math.abs(d) >= 3) out.push(`По выходным ${d > 0 ? 'на <b>' + d + '% больше</b>' : 'на <b>' + -d + '% меньше</b>'} калорий, чем в будни.`);
        }
      }
      if (best && low && best !== low) out.push(`Максимум <b>${fmt(best.kcal)} ккал</b> ${shortDate(best.date)}, минимум <b>${fmt(low.kcal)}</b> ${shortDate(low.date)}.`);
      if (logged.length) out.push(`В среднем <b>${fmt(logged.reduce((s, x) => s + x.n, 0) / logged.length, 1)}</b> ${plural(Math.round(logged.reduce((s, x) => s + x.n, 0) / logged.length), 'запись', 'записи', 'записей')} в день.`);
      if (logged.length) {
        const ap = a.avg.protein;
        out.push(ap >= PROTEIN_OK[0] ? `Белок в среднем <b>${fmt(ap)} г</b>, это в вашей норме ${PROTEIN_OK[0]}–${PROTEIN_OK[1]} г.`
          : `Белок в среднем <b>${fmt(ap)} г</b>: до ${PROTEIN_OK[0]} г не хватает около ${fmt(PROTEIN_OK[0] - ap)} г в день.`);
        out.push(fatOver ? `Жиры больше ${FAT_MAX} г: <b>${fatOver} ${plural(fatOver, 'день', 'дня', 'дней')}</b> из ${logged.length}.` : `Жиры ни разу не были больше ${FAT_MAX} г.`);
      }
      return out;
    })();
    const lastM = ms.length ? ms[ms.length - 1] : null, prevM = ms.length > 1 ? ms[ms.length - 2] : null;
    const todayNote = a.series.some((s) => s.partial && s.n) ? '<p class="muted partial-note">Сегодняшний день ещё идёт: на графиках он бледный и в средние не входит.</p>' : '';
    const mDelta = (k) => (lastM && prevM && lastM[k] != null && prevM[k] != null ? lastM[k] - prevM[k] : null);
    const mVal = (k, label) => lastM && lastM[k] != null ? `<div class="bv"><span>${label}</span><b>${fmt(lastM[k], 1)}</b><small>см${mDelta(k) != null ? ` · ${mDelta(k) > 0 ? '+' : ''}${fmt(mDelta(k), 1)}` : ''}</small></div>` : '';

    $('#analytics').innerHTML = `
      <div class="card sum">
        <div class="sum-ring">${ring(118, 10, g.kcal ? a.avg.kcal / g.kcal : 0, over ? COLOR.carbs : COLOR.kcal)}
          <div class="c"><div class="val">${fmt(a.avg.kcal)}</div><div class="of">ккал в день</div></div></div>
        <div class="sum-bars">
          <div class="sum-pct ${pct('kcal') >= 90 && pct('kcal') <= 110 ? 'good' : ''}">${pct('kcal') != null ? `${pct('kcal')}% от нормы ${fmt(g.kcal)}` : ''}</div>
          ${['protein', 'fat', 'carbs'].map(nutrBar).join('')}
        </div>
        <div class="sum-foot">${periodName} · ${logged.length} ${plural(logged.length, 'день', 'дня', 'дней')} с записями</div>
      </div>
      <div class="tiles">
        <div class="card tile"><b>${inKcal}<small>/${logged.length}</small></b><span>дней в норме по калориям</span></div>
        <div class="card tile"><b>${a.streak}</b><span>${plural(a.streak, 'день', 'дня', 'дней')} подряд с записями</span></div>
        <div class="card tile"><b>${inProt}<small>/${logged.length}</small></b><span>дней белок ${PROTEIN_OK[0]}–${PROTEIN_OK[1]} г</span></div>
      </div>
      ${todayNote}

      <div class="card chart-card"><div class="ch"><b>Калории</b><span>${useWeekly ? 'по неделям, среднее в день' : `по дням, ${shortDate(a.start)} – ${shortDate(a.end)}`}</span></div>
        <div class="chart" id="ch-kcal"></div>
        <div class="legend"><span><i class="dot kcal"></i>калории, ккал</span><span><i class="goal-line"></i>норма ${fmt(g.kcal)}</span></div>
        <button class="table-toggle" id="tbl-toggle">${state.showTable ? 'Скрыть таблицу' : 'Показать таблицу'}</button>
        <div id="tbl" ${state.showTable ? '' : 'hidden'}></div>
      </div>

      <div class="card chart-card"><div class="ch"><b>Белки / жиры / углеводы</b><span>${useWeekly ? 'по неделям' : 'по дням'}, г</span></div>
        <div class="seg small bju" id="bju-seg">
          <button data-b="all" class="${state.bju === 'all' ? 'on' : ''}">Все</button>
          <button data-b="protein" class="${state.bju === 'protein' ? 'on' : ''}"><i class="dot protein"></i>Белки</button>
          <button data-b="fat" class="${state.bju === 'fat' ? 'on' : ''}"><i class="dot fat"></i>Жиры</button>
          <button data-b="carbs" class="${state.bju === 'carbs' ? 'on' : ''}"><i class="dot carbs"></i>Углеводы</button>
        </div>
        <div class="chart" id="ch-bju"></div>
        <div class="legend" id="bju-legend"></div>
      </div>

      <div class="card chart-card"><div class="ch"><b>Баланс Б / Ж / У</b><span>доля калорий</span></div>
        <div class="legend" style="padding-top:0"><span>факт</span></div>
        <div class="share">${['protein', 'fat', 'carbs'].map((k) => `<i class="${k}" style="width:${(share.fact[k] * 100).toFixed(1)}%"></i>`).join('')}</div>
        <div class="legend" style="padding-top:2px">${['protein', 'fat', 'carbs'].map((k) => `<span><i class="dot ${k}"></i>${MACRO_LABELS[k]} <b>${Math.round(share.fact[k] * 100)}%</b></span>`).join('')}</div>
        <div class="legend" style="margin-top:8px;padding-top:0"><span>норма</span></div>
        <div class="share" style="opacity:.55">${['protein', 'fat', 'carbs'].map((k) => `<i class="${k}" style="width:${(share.goal[k] * 100).toFixed(1)}%"></i>`).join('')}</div>
        <div class="legend" style="padding-top:2px">${['protein', 'fat', 'carbs'].map((k) => `<span><i class="dot ${k}"></i><b>${Math.round(share.goal[k] * 100)}%</b></span>`).join('')}</div>
      </div>

      <div class="card chart-card"><div class="ch"><b>По дням недели</b><span>калории, среднее за день</span></div><div class="chart" id="ch-wd"></div>
        ${insights.length ? `<ul class="insights">${insights.map((t) => `<li>${t}</li>`).join('')}</ul>` : ''}
      </div>

      ${a.series.length >= 60 ? `<div class="card chart-card"><div class="ch"><b>Карта дней</b><span>калории от нормы, нажми на день</span></div><div class="heat" id="ch-heat"></div>
        <div class="legend"><span><i class="sw" style="background:rgba(255,255,255,.07)"></i>нет записей</span><span><i class="sw" style="background:${COLOR.kcal};opacity:.45"></i>меньше нормы</span><span><i class="sw" style="background:${COLOR.kcal}"></i>в норме</span><span><i class="sw" style="background:${COLOR.carbs}"></i>выше</span></div></div>` : ''}

      <div class="card chart-card"><div class="ch"><b>Тело</b><span>${w.length ? `${fmt(w[w.length - 1].kg, 1)} кг${wDelta != null ? `, ${wDelta > 0 ? '+' : ''}${fmt(wDelta, 1)} ${periodName}` : ''}` : 'вес и объёмы'}</span></div>
        ${w.length > 1 ? '<div class="chart" id="ch-weight"></div>' : `<p class="muted" style="margin:4px 2px 6px">${w.length ? 'Одна запись веса за период.' : 'Веса за этот период нет. Записывай его на вкладке «Цели».'}</p>`}
        ${w.length > 1 ? `<div class="legend"><span><i class="dot" style="background:#c9d2ff"></i>вес за день</span><span><i class="trend-line"></i>среднее за 7 дней</span></div>` : ''}
        ${lastM ? `<div class="body-vals">${MEAS.map(([k, l]) => mVal(k, l)).join('')}</div>` : '<p class="muted" style="margin:4px 2px 6px">Объёмов (ОБ / ОГ / ОТ) за этот период нет. Они записываются раз в две недели на вкладке «Цели».</p>'}
        ${ms.length > 1 ? `<div class="chart" id="ch-meas"></div><div class="legend">${MEAS.map(([, l, c]) => `<span><i class="dot" style="background:${c}"></i>${l}</span>`).join('')}</div>` : ''}
      </div>
      <h3>Чаще всего ${periodName}</h3>
      <ul class="card top-list">${a.top.length ? a.top.map((t) => `<li><div>${esc(t.name)}</div><span>× ${t.n} · ${fmt(t.kcal)} ккал</span></li>`).join('')
        : '<li class="muted">Пока нет блюд с названиями: записи из FatSecret сгруппированы по приёмам. Новые записи через Claude попадут сюда.</li>'}</ul>`;

    const n = pts.length;
    const labelEvery = n > 45 ? Math.ceil(n / 5) : n > 20 ? 7 : 1;
    const xLabel = (i) => (i % labelEvery === 0 ? (useWeekly || n > 45 ? shortDate(pts[i].date) : parse(pts[i].date).getDate()) : '');
    const ptTitle = (i) => (useWeekly ? `неделя с ${shortDate(pts[i].date)}, ${pts[i].n} ${plural(pts[i].n, 'день', 'дня', 'дней')}` : dateTitle(pts[i].date));

    // calories
    const kc = $('#ch-kcal');
    const faded = (i) => !!pts[i].partial;
    const ptTitle2 = (i) => `${ptTitle(i)}${pts[i].partial ? ', день ещё идёт' : ''}`;
    const kOpts = { values: pts.map((p) => p.kcal), color: COLOR.kcal, goal: g.kcal, unit: 'ккал', label: xLabel, faded, tip: (i) => ({ title: `${fmt(pts[i].kcal)} ккал`, text: ptTitle2(i) }) };
    if (!useWeekly && n > 45) line(kc, kOpts); else bars(kc, kOpts);
    $('#tbl').innerHTML = `<table class="dtable">${pts.filter((p) => p.kcal != null).map((p) => `<tr><td class="l">${useWeekly ? `нед. с ${shortDate(p.date)}` : `${shortDate(p.date)}, ${WEEKDAYS[weekdayIdx(p.date)]}`}</td><td>${fmt(p.kcal)} ккал</td><td><i class="dot protein"></i>${fmt(p.protein)}</td><td><i class="dot fat"></i>${fmt(p.fat)}</td><td><i class="dot carbs"></i>${fmt(p.carbs)}</td></tr>`).join('')}</table>`;
    $('#tbl-toggle').addEventListener('click', () => { state.showTable = !state.showTable; $('#tbl').hidden = !state.showTable; $('#tbl-toggle').textContent = state.showTable ? 'Скрыть таблицу' : 'Показать таблицу'; });

    // protein / fat / carbs: stacked grams, or one nutrient against its goal
    const drawBju = () => {
      const el = $('#ch-bju'), lg = $('#bju-legend');
      if (state.bju === 'all') {
        stackedBars(el, {
          series: ['protein', 'fat', 'carbs'].map((m) => ({ key: m, color: COLOR[m], values: pts.map((p) => p[m]) })),
          unit: 'г', label: xLabel, height: 190, faded,
          tip: (i) => ({ title: `${fmt(pts[i].protein + pts[i].fat + pts[i].carbs)} г`, text: `${ptTitle2(i)}<br><i class="dot protein"></i> Б ${fmt(pts[i].protein)} · <i class="dot fat"></i> Ж ${fmt(pts[i].fat)} · <i class="dot carbs"></i> У ${fmt(pts[i].carbs)}` }),
        });
        lg.innerHTML = ['protein', 'fat', 'carbs'].map((m) => `<span><i class="dot ${m}"></i>${MACRO_LABELS[m].toLowerCase()}, норма ${fmt(g[m])} г</span>`).join('');
      } else {
        const m = state.bju;
        const o = { values: pts.map((p) => p[m]), color: COLOR[m], goal: g[m], unit: 'г', label: xLabel, height: 190, faded, tip: (i) => ({ title: `${fmt(pts[i][m])} г`, text: ptTitle2(i) }) };
        if (!useWeekly && n > 45) line(el, o); else bars(el, o);
        lg.innerHTML = `<span><i class="dot ${m}"></i>${MACRO_LABELS[m].toLowerCase()}, г</span><span><i class="goal-line"></i>норма ${fmt(g[m])} г</span>`;
      }
    };
    drawBju();
    $$('#bju-seg button').forEach((b) => b.addEventListener('click', () => {
      state.bju = b.dataset.b;
      $$('#bju-seg button').forEach((x) => x.classList.toggle('on', x === b));
      drawBju();
    }));

    const wd = a.weekday.map((x) => (x.n ? x.kcal : null));
    bars($('#ch-wd'), {
      values: wd, color: COLOR.kcal, goal: g.kcal, unit: 'ккал', height: 150,
      label: (i) => WEEKDAYS[i],
      tip: (i) => ({ title: `${fmt(wd[i])} ккал`, text: `${WEEKDAYS_LONG[i]} · ${a.weekday[i].n} ${plural(a.weekday[i].n, 'день', 'дня', 'дней')}` }),
    });
    if ($('#ch-heat')) heatmap($('#ch-heat'), { series: a.series, goalOn: (d) => goalOn(d).kcal });
    if (w.length > 1) {
      // daily weight jumps by a few hundred grams: the bold line is the average of the last 7 days
      const trend = w.map((x) => { const from = addDays(x.date, -6); const win = w.filter((y) => y.date >= from && y.date <= x.date); return win.reduce((s, y) => s + y.kg, 0) / win.length; });
      timeChart($('#ch-weight'), {
        dates: w.map((x) => x.date), unit: 'кг', height: 160, decimals: 1,
        series: [{ values: w.map((x) => x.kg), color: '#c9d2ff', faint: true }, { values: trend, color: '#c9d2ff', bold: true }],
        tip: (i) => ({ title: `${fmt(w[i].kg, 1)} кг`, text: `${dateTitle(w[i].date)} · среднее за 7 дней ${fmt(trend[i], 1)}` }),
      });
    }
    if (ms.length > 1) {
      timeChart($('#ch-meas'), {
        dates: ms.map((x) => x.date), unit: 'см', height: 200, decimals: 0,
        series: MEAS.map(([k, , c]) => ({ values: ms.map((x) => x[k]), color: c })),
        tip: (i) => ({ title: shortDate(ms[i].date), text: MEAS.map(([k, l]) => `${l} ${ms[i][k] != null ? fmt(ms[i][k], 1) : '–'}`).join(' · ') }),
      });
    }
  }

  // ---------- SVG charts ----------
  // The tooltip lives INSIDE the chart box (absolute, not fixed), so it scrolls with the chart and never
  // "follows" the finger around the page. Any tap elsewhere or a page scroll hides every tooltip.
  function tipFor(el) {
    let t = el.querySelector(':scope > .tip');
    if (!t) { t = document.createElement('div'); t.className = 'tip'; t.hidden = true; el.appendChild(t); }
    return t;
  }
  function showTip(el, sx, sy, W, H, t) {
    const tip = tipFor(el);
    tip.innerHTML = `<b>${t.title}</b>${t.text}`;
    tip.hidden = false;
    const svg = el.querySelector('svg'), sb = svg.getBoundingClientRect();
    const px = (sx * sb.width) / W, py = (sy * sb.height) / H;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${Math.max(0, Math.min(el.clientWidth - tw, px - tw / 2))}px`;
    tip.style.top = `${py - th - 12 < 0 ? py + 14 : py - th - 12}px`;
  }
  function hideAllTips() {
    $$('.chart .tip').forEach((t) => { t.hidden = true; });
    $$('.chart .bar.dim').forEach((b) => b.classList.remove('dim'));
    $$('.chart .cursor, .chart .hdot').forEach((c) => c.setAttribute('visibility', 'hidden'));
  }
  document.addEventListener('scroll', hideAllTips, { capture: true, passive: true });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.chart')) hideAllTips(); });

  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    const k = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 3 ? 3 : n <= 4 ? 4 : n <= 5 ? 5 : n <= 6 ? 6 : n <= 8 ? 8 : 10;
    return k * p;
  }
  const compact = (v, d = 0) => (v >= 10000 ? `${(v / 1000).toFixed(1).replace(/\.0$/, '')}K` : fmt(v, d));

  function frame(el, opts) {
    const W = el.clientWidth || 320, H = opts.height || 180;
    const pad = { l: 36, r: 10, t: 12, b: 22 };
    const vals = opts.values.filter((v) => v != null);
    if (!vals.length) vals.push(0);
    const lo = opts.zero === false ? Math.min(...vals) : 0;
    const hiRaw = Math.max(...vals, opts.goal || 0, lo + 1);
    const span = opts.zero === false ? (hiRaw - lo) * 1.15 + 0.1 : niceMax(hiRaw * 1.08);
    const min = opts.zero === false ? lo - (hiRaw - lo) * 0.15 - 0.05 : 0;
    const max = min + span;
    const y = (v) => pad.t + ((H - pad.t - pad.b) * (max - v)) / (max - min);
    const ticks = opts.zero === false ? [min + span * 0.1, min + span / 2, max - span * 0.05] : [0, max / 2, max];
    let g = '';
    for (const t of ticks) g += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>
      <text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${compact(t, opts.decimals || 0)}</text>`;
    if (opts.goal) g += `<line class="goal" x1="${pad.l}" x2="${W - pad.r}" y1="${y(opts.goal)}" y2="${y(opts.goal)}"/>`;
    return { W, H, pad, y, min, max, grid: g };
  }

  // shared hover: nearest index by x; markAt(i) moves the cursor, markAt.y(i) gives the tooltip anchor
  function attachHover(el, hitX, n, opts, markAt) {
    const svg = el.querySelector('svg');
    const idxAt = (cx) => {
      const b = svg.getBoundingClientRect(), sx = (cx - b.left) * (opts.W / b.width);
      let best = -1, bd = Infinity;
      for (let i = 0; i < n; i++) { if (opts.has && !opts.has(i)) continue; const d = Math.abs(hitX(i) - sx); if (d < bd) { bd = d; best = i; } }
      return best;
    };
    let active = -1, timer;
    const leave = () => { active = -1; hideAllTips(); };
    const move = (e) => {
      const i = idxAt(e.clientX);
      if (i === active) return;
      active = i;
      $$('.bar', svg).forEach((b) => b.classList.toggle('dim', Number(b.dataset.i) !== i));
      const t = i >= 0 && opts.tip ? opts.tip(i) : null;
      if (!t) { leave(); return; }
      markAt(i);
      showTip(el, hitX(i), markAt.y(i), opts.W, opts.H, t);
      clearTimeout(timer); timer = setTimeout(leave, 2500); // touch has no "leave": fade the tip by itself
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', (e) => { active = -1; move(e); });
    el.addEventListener('pointerleave', () => { if (!('ontouchstart' in window)) leave(); });
  }

  function bars(el, opts) {
    const f = frame(el, opts);
    const n = opts.values.length;
    const slot = (f.W - f.pad.l - f.pad.r) / n;
    const bw = Math.min(24, Math.max(2, slot - 2));
    const id = `b${++gid}`;
    let s = `<svg viewBox="0 0 ${f.W} ${f.H}"><defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${opts.color}"/><stop offset="1" stop-color="${opts.color}" stop-opacity=".35"/></linearGradient>
      <filter id="${id}f" x="-50%" y="-20%" width="200%" height="140%"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>${f.grid}`;
    const x = (i) => f.pad.l + slot * i + slot / 2;
    opts.values.forEach((v, i) => {
      const lbl = opts.label ? opts.label(i) : '';
      if (lbl !== '' && lbl != null) s += `<text x="${x(i)}" y="${f.H - 6}" text-anchor="middle">${lbl}</text>`;
      if (v == null) return;
      const top = f.y(v), base = f.y(f.min), h = Math.max(0, base - top), r = Math.min(4, h / 2, bw / 2);
      s += `<path class="bar${opts.faded && opts.faded(i) ? ' faded' : ''}" data-i="${i}" filter="url(#${id}f)" fill="url(#${id})" d="M${x(i) - bw / 2} ${base} v${-(h - r)} a${r} ${r} 0 0 1 ${r} ${-r} h${bw - 2 * r} a${r} ${r} 0 0 1 ${r} ${r} v${h - r} z"/>`;
    });
    s += `<line class="cursor" id="${id}c" x1="0" x2="0" y1="${f.pad.t}" y2="${f.H - f.pad.b}" visibility="hidden"/></svg>`;
    el.innerHTML = s;
    const cur = el.querySelector(`#${id}c`);
    const markAt = (i) => { if (i < 0) cur.setAttribute('visibility', 'hidden'); else { cur.setAttribute('x1', x(i)); cur.setAttribute('x2', x(i)); cur.setAttribute('visibility', 'visible'); } };
    markAt.y = (i) => f.y(opts.values[i]);
    attachHover(el, x, n, { ...opts, W: f.W, H: f.H, has: (i) => opts.values[i] != null }, markAt);
  }

  // stacked grams: series bottom-up, 2 px surface gap between segments, rounded top segment
  function stackedBars(el, opts) {
    const n = opts.series[0].values.length;
    const totals = Array.from({ length: n }, (_, i) => (opts.series[0].values[i] == null ? null : opts.series.reduce((a, s) => a + (s.values[i] || 0), 0)));
    const f = frame(el, { ...opts, values: totals });
    const slot = (f.W - f.pad.l - f.pad.r) / n;
    const bw = Math.min(24, Math.max(2, slot - 2));
    const id = `s${++gid}`;
    let s = `<svg viewBox="0 0 ${f.W} ${f.H}">${f.grid}`;
    const x = (i) => f.pad.l + slot * i + slot / 2;
    const base = f.y(f.min);
    for (let i = 0; i < n; i++) {
      const lbl = opts.label ? opts.label(i) : '';
      if (lbl !== '' && lbl != null) s += `<text x="${x(i)}" y="${f.H - 6}" text-anchor="middle">${lbl}</text>`;
      if (totals[i] == null) continue;
      let acc = 0;
      s += `<g class="bar${opts.faded && opts.faded(i) ? ' faded' : ''}" data-i="${i}">`;
      opts.series.forEach((ser, k) => {
        const v = ser.values[i] || 0;
        if (v <= 0) return;
        const y0 = f.y(acc), y1 = f.y(acc + v);
        const top = k === opts.series.length - 1;
        const h = Math.max(0, y0 - y1 - (k ? 2 : 0)), r = top ? Math.min(4, h / 2, bw / 2) : 0;
        const yb = y0 - (k ? 2 : 0);
        s += top
          ? `<path fill="${ser.color}" d="M${x(i) - bw / 2} ${yb} v${-(h - r)} a${r} ${r} 0 0 1 ${r} ${-r} h${bw - 2 * r} a${r} ${r} 0 0 1 ${r} ${r} v${h - r} z"/>`
          : `<rect fill="${ser.color}" x="${x(i) - bw / 2}" y="${yb - h}" width="${bw}" height="${h}"/>`;
        acc += v;
      });
      s += '</g>';
    }
    s += `<line class="cursor" id="${id}c" x1="0" x2="0" y1="${f.pad.t}" y2="${f.H - f.pad.b}" visibility="hidden"/></svg>`;
    el.innerHTML = s;
    const cur = el.querySelector(`#${id}c`);
    const markAt = (i) => { if (i < 0) cur.setAttribute('visibility', 'hidden'); else { cur.setAttribute('x1', x(i)); cur.setAttribute('x2', x(i)); cur.setAttribute('visibility', 'visible'); } };
    markAt.y = (i) => f.y(totals[i]);
    attachHover(el, x, n, { ...opts, values: totals, W: f.W, H: f.H, has: (i) => totals[i] != null }, markAt);
    void base;
  }

  function linePath(x, y, values) {
    let path = '', open = false;
    values.forEach((v, i) => { if (v == null) { open = false; return; } path += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; open = true; });
    return path;
  }

  function line(el, opts) {
    const f = frame(el, opts);
    const n = opts.values.length;
    const x = (i) => f.pad.l + ((f.W - f.pad.l - f.pad.r) * i) / Math.max(1, n - 1);
    const id = `l${++gid}`;
    const isFaded = (i) => !!(opts.faded && opts.faded(i));
    const vals = opts.values.map((v, i) => [i, v]).filter(([i, v]) => v != null && !isFaded(i));
    let area = '', dots = '';
    if (vals.length) {
      area = `M${x(vals[0][0]).toFixed(1)} ${f.y(f.min)} ` + vals.map(([i, v]) => `L${x(i).toFixed(1)} ${f.y(v).toFixed(1)}`).join(' ') + ` L${x(vals[vals.length - 1][0]).toFixed(1)} ${f.y(f.min)} Z`;
      const [li, lv] = vals[vals.length - 1];
      dots = `<circle cx="${x(li)}" cy="${f.y(lv)}" r="4.5" fill="${opts.color}" stroke="#0f1526" stroke-width="2"/>`;
    }
    opts.values.forEach((v, i) => { if (v != null && isFaded(i)) dots += `<circle cx="${x(i)}" cy="${f.y(v)}" r="3.5" fill="#0f1526" stroke="${opts.color}" stroke-width="1.5" opacity=".7"/>`; });
    let s = `<svg viewBox="0 0 ${f.W} ${f.H}"><defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${opts.color}" stop-opacity=".35"/><stop offset="1" stop-color="${opts.color}" stop-opacity="0"/></linearGradient>
      <filter id="${id}f" x="-10%" y="-40%" width="120%" height="180%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>${f.grid}
      <path d="${area}" fill="url(#${id})"/>
      <path d="${linePath(x, f.y, opts.values.map((v, i) => (isFaded(i) ? null : v)))}" fill="none" stroke="${opts.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" filter="url(#${id}f)"/>${dots}`;
    opts.values.forEach((v, i) => {
      const lbl = opts.label ? opts.label(i) : '';
      if (lbl !== '' && lbl != null) s += `<text x="${x(i)}" y="${f.H - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${lbl}</text>`;
    });
    s += `<line class="cursor" id="${id}c" x1="0" x2="0" y1="${f.pad.t}" y2="${f.H - f.pad.b}" visibility="hidden"/>
      <circle class="hdot" id="${id}d" r="5" fill="${opts.color}" stroke="#0f1526" stroke-width="2" visibility="hidden"/></svg>`;
    el.innerHTML = s;
    const cur = el.querySelector(`#${id}c`), dot = el.querySelector(`#${id}d`);
    const markAt = (i) => {
      if (i < 0) { cur.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); return; }
      cur.setAttribute('x1', x(i)); cur.setAttribute('x2', x(i)); cur.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', f.y(opts.values[i])); dot.setAttribute('visibility', 'visible');
    };
    markAt.y = (i) => f.y(opts.values[i]);
    attachHover(el, x, n, { ...opts, W: f.W, H: f.H, has: (i) => opts.values[i] != null }, markAt);
  }

  // lines over REAL time: a point sits at its date, so three months between two weighings look like three
  // months, not like one step. Series share one axis; `faint` = thin with dots, `bold` = glowing main line.
  function timeChart(el, opts) {
    const all = opts.series.flatMap((ser) => ser.values);
    const f = frame(el, { ...opts, values: all, zero: false });
    const t = opts.dates.map((d) => parse(d).getTime());
    const t0 = t[0], t1 = Math.max(t[t.length - 1], t0 + 864e5);
    const pw = f.W - f.pad.l - f.pad.r;
    const xt = (ms) => f.pad.l + (pw * (ms - t0)) / (t1 - t0);
    const x = (i) => xt(t[i]);
    const id = `t${++gid}`;
    let s = `<svg viewBox="0 0 ${f.W} ${f.H}"><defs>
      <filter id="${id}f" x="-10%" y="-40%" width="120%" height="180%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>${f.grid}`;
    for (const ser of opts.series) {
      const d = linePath(x, f.y, ser.values);
      if (ser.bold) {
        s += `<path d="${d}" fill="none" stroke="${ser.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" filter="url(#${id}f)"/>`;
        const li = ser.values.length - 1;
        if (ser.values[li] != null) s += `<circle cx="${x(li)}" cy="${f.y(ser.values[li])}" r="4.5" fill="${ser.color}" stroke="#0f1526" stroke-width="2"/>`;
      } else {
        s += `<path d="${d}" fill="none" stroke="${ser.color}" stroke-width="${ser.faint ? 1 : 2}" stroke-opacity="${ser.faint ? 0.35 : 1}" stroke-linejoin="round" stroke-linecap="round"/>`;
        ser.values.forEach((v, i) => { if (v != null) s += `<circle cx="${x(i)}" cy="${f.y(v)}" r="${ser.faint ? 2.2 : 3}" fill="${ser.color}" fill-opacity="${ser.faint ? 0.55 : 1}" stroke="#0f1526" stroke-width="1"/>`; });
      }
    }
    // date labels evenly spread over time (not over points), so they never pile up
    const nl = Math.max(2, Math.min(5, Math.floor(pw / 78) + 1));
    for (let k = 0; k < nl; k++) {
      const ms = t0 + ((t1 - t0) * k) / (nl - 1);
      s += `<text x="${xt(ms)}" y="${f.H - 6}" text-anchor="${k === 0 ? 'start' : k === nl - 1 ? 'end' : 'middle'}">${shortDate(iso(new Date(ms)))}</text>`;
    }
    s += `<line class="cursor" id="${id}c" x1="0" x2="0" y1="${f.pad.t}" y2="${f.H - f.pad.b}" visibility="hidden"/></svg>`;
    el.innerHTML = s;
    const cur = el.querySelector(`#${id}c`);
    const main = opts.series.find((ser) => ser.bold) || opts.series[0];
    const markAt = (i) => { if (i < 0) cur.setAttribute('visibility', 'hidden'); else { cur.setAttribute('x1', x(i)); cur.setAttribute('x2', x(i)); cur.setAttribute('visibility', 'visible'); } };
    markAt.y = (i) => (main.values[i] != null ? f.y(main.values[i]) : f.pad.t);
    attachHover(el, x, t.length, { ...opts, values: all, W: f.W, H: f.H }, markAt);
  }

  // day map: one small calendar per month (Monday first), colour = calories against the goal.
  // Tapping a day opens it in the journal.
  function heatmap(el, opts) {
    const byDate = Object.fromEntries(opts.series.map((d) => [d.date, d]));
    const months = [];
    for (const d of opts.series) { const m = d.date.slice(0, 7); if (months[months.length - 1] !== m) months.push(m); }
    const cellCls = (d) => {
      if (!d || !d.n) return 'none';
      if (d.partial) return 'part';
      const r = d.kcal / (opts.goalOn(d.date) || 1);
      return r > 1.1 ? 'over' : r < 0.9 ? 'under' : 'ok';
    };
    el.innerHTML = months.map((m) => {
      const [y, mo] = m.split('-').map(Number);
      const first = `${m}-01`, n = new Date(y, mo, 0).getDate();
      let cells = '<i class="pad"></i>'.repeat(weekdayIdx(first));
      for (let k = 1; k <= n; k++) {
        const ds = `${m}-${pad2(k)}`, d = byDate[ds];
        cells += d ? `<button type="button" class="hc ${cellCls(d)}" data-date="${ds}" aria-label="${shortDate(ds)}"></button>` : '<i class="pad"></i>';
      }
      return `<div class="hm"><b>${MONTHS_NOM[mo - 1]}</b><div class="hm-grid">${cells}</div></div>`;
    }).reverse().join('');
    $$('.hc', el).forEach((b) => b.addEventListener('click', () => { state.date = b.dataset.date; showTab('journal'); window.scrollTo(0, 0); }));
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.tab === 'analytics' && state.analytics) renderAnalytics(); }, 150);
  });
  // ---------- goals / weight / measurements ----------
  const MEASURE_EVERY = 14; // days between body measurements (ОГ / ОТ / ОБ)
  const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);

  async function loadGoals() {
    const g = await api('/api/goals');
    const f = $('#goals-form');
    for (const k of MACROS) f[k].value = g.goals[k];
    $('#goals-sum').innerHTML = `<span><i class="dot kcal"></i><b>${fmt(g.goals.kcal)}</b> ккал</span>
      <span><i class="dot protein"></i>Б <b>${fmt(g.goals.protein)}</b></span><span><i class="dot fat"></i>Ж <b>${fmt(g.goals.fat)}</b></span><span><i class="dot carbs"></i>У <b>${fmt(g.goals.carbs)}</b></span>
      <p class="muted">Белок в норме при ${PROTEIN_OK[0]}–${PROTEIN_OK[1]} г, жиры плохо только больше ${FAT_MAX} г.</p>`;
    if (g.weight_today) $('#weight-form').kg.value = g.weight_today.kg;
    renderNow(g);
    renderMeasurements(g.measurements || []);
    renderPush();
  }

  // «где я сейчас»: weight with its 7-day average and the month's change, the last measurements
  function renderNow(g) {
    const w = g.weight || [], ms = g.measurements || [];
    const last = w[w.length - 1];
    const box = $('#now-card');
    if (!last && !ms.length) { box.innerHTML = '<h3>Сейчас</h3><p class="muted">Здесь появятся вес и объёмы, когда они будут записаны.</p>'; return; }
    const avg7 = last ? (() => { const from = addDays(last.date, -6); const win = w.filter((x) => x.date >= from); return win.reduce((s, x) => s + x.kg, 0) / win.length; })() : null;
    const monthAgo = last ? [...w].reverse().find((x) => x.date <= addDays(last.date, -28)) : null;
    const dm = monthAgo ? last.kg - monthAgo.kg : null;
    const lm = ms[ms.length - 1], pm = ms[ms.length - 2];
    const cell = (k, label) => {
      const d = lm && pm && lm[k] != null && pm[k] != null ? lm[k] - pm[k] : null;
      return `<div class="bv"><span>${label}</span><b>${lm && lm[k] != null ? fmt(lm[k], 1) : '–'}</b><small>см${d != null ? ` <em class="${d < 0 ? 'down' : d > 0 ? 'up' : ''}">${d > 0 ? '+' : ''}${fmt(d, 1)}</em>` : ''}</small></div>`;
    };
    box.innerHTML = `<h3>Сейчас</h3>
      ${last ? `<div class="now-w"><b>${fmt(last.kg, 1)}</b><span>кг · ${dateTitle(last.date).toLowerCase()}</span></div>
        <p class="muted now-sub">Среднее за 7 дней <b>${fmt(avg7, 1)} кг</b>${dm != null ? ` · за 4 недели ${dm > 0 ? '+' : ''}${fmt(dm, 1)} кг` : ''}</p>` : ''}
      ${lm ? `<div class="body-vals">${MEAS.map(([k, l]) => cell(k, l)).join('')}</div>
        <p class="muted now-sub">Замер ${shortDate(lm.date)}${pm ? `, разница с ${shortDate(pm.date)}` : ''}</p>` : ''}`;
  }

  $('#goals-edit').addEventListener('click', () => {
    const fields = $('#goals-fields');
    fields.hidden = !fields.hidden;
    $('#goals-sum').hidden = !fields.hidden;
    $('#goals-edit').textContent = fields.hidden ? 'Изменить' : 'Отмена';
  });

  function renderMeasurements(ms) {
    const f = $('#measure-form');
    f.date.value = state.today;
    const last = ms[ms.length - 1], prev = ms[ms.length - 2];
    const info = $('#measure-info');
    if (!last) { info.innerHTML = '<p class="muted">Замеров пока нет. Запиши ОГ (грудь), ОТ (талию) и ОБ (бёдра) в сантиметрах, и я напомню про следующий замер через две недели.</p>'; return; }
    const d = (k) => (prev && last[k] != null && prev[k] != null ? last[k] - prev[k] : null);
    const cell = (k, label) => `<div class="bv"><span>${label}</span><b>${last[k] != null ? fmt(last[k], 1) : '–'}</b><small>см${d(k) != null ? ` <em class="${d(k) < 0 ? 'down' : d(k) > 0 ? 'up' : ''}">${d(k) > 0 ? '+' : ''}${fmt(d(k), 1)}</em>` : ''}</small></div>`;
    const next = addDays(last.date, MEASURE_EVERY);
    const left = daysBetween(state.today, next);
    void cell;
    info.innerHTML = `<p class="muted">Последний замер ${shortDate(last.date)}. Следующий: <b>${left <= 0 ? 'уже пора' : left === 1 ? 'завтра' : `${shortDate(next)}, через ${left} ${plural(left, 'день', 'дня', 'дней')}`}</b>.</p>`;
  }

  $('#goals-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('/api/goals', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
    state.goals = r.goals;
    toast('Нормы сохранены');
    $('#goals-edit').click();
    loadGoals();
  });
  $('#weight-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const kg = Number(e.target.kg.value);
    if (!kg) return;
    await api('/api/weight', { method: 'POST', body: { kg } });
    toast('Вес записан'); loadGoals();
  });
  $('#measure-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { chest: f.chest.value || null, waist: f.waist.value || null, hips: f.hips.value || null, date: f.date.value || state.today };
    if (!body.chest && !body.waist && !body.hips) return toast('Введи хотя бы одно значение');
    await api('/api/measurements', { method: 'POST', body });
    f.chest.value = f.waist.value = f.hips.value = '';
    toast('Объёмы записаны'); loadGoals();
  });

  // ---------- body: every date with weight, measurements and photos; compare two dates ----------
  const BODY_KEYS = [['kg', 'Вес', 'кг'], ...MEAS.map(([k, l]) => [k, l, 'см'])];
  let bodyCmp = null; // [dateA, dateB]

  function bodyDays(b) {
    const byDate = {};
    const day = (d) => (byDate[d] = byDate[d] || { date: d, photos: [] });
    b.measurements.forEach((m) => Object.assign(day(m.date), { chest: m.chest, waist: m.waist, hips: m.hips }));
    b.photos.forEach((p) => day(p.date).photos.push(p));
    const weights = Object.fromEntries(b.weight.map((w) => [w.date, w.kg]));
    // a measurement day shows that day's weight, or the closest one within 3 days
    for (const d of Object.values(byDate)) {
      for (let k = 0; k <= 3 && d.kg == null; k++) {
        const w = weights[d.date] ?? weights[addDays(d.date, -k)] ?? weights[addDays(d.date, k)];
        if (w != null) { d.kg = w; d.kgNear = k > 0 && weights[d.date] == null; }
      }
    }
    return Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  const longDate = (s) => `${shortDate(s)} ${s.slice(0, 4) !== state.today.slice(0, 4) ? s.slice(0, 4) : ''}`.trim();
  const photoUrl = (p) => `/api/photos/${p.id}`;
  const num2 = (v) => String(Math.round(v * 100) / 100);

  async function openBody() {
    const b = await api('/api/body');
    const days = bodyDays(b);
    const withData = days.filter((d) => d.kg != null || d.chest != null || d.photos.length);
    if (!bodyCmp || !withData.some((d) => d.date === bodyCmp[0]) || !withData.some((d) => d.date === bodyCmp[1])) {
      bodyCmp = withData.length ? [withData[0].date, withData[withData.length - 1].date] : null;
    }
    const allPhotos = [...withData].reverse().flatMap((d) => d.photos.map((p) => ({ ...p, date: d.date })));
    const view = (id) => viewPhotos(allPhotos, Number(id));
    const opt = (sel) => withData.map((d) => `<option value="${d.date}" ${d.date === sel ? 'selected' : ''}>${longDate(d.date)}</option>`).join('');
    openPage('Фото и замеры', `
      ${withData.length > 1 ? `<h3>Сравнить</h3>
      <div class="card cmp">
        <div class="cmp-pick"><select id="cmp-a">${opt(bodyCmp[0])}</select><span>→</span><select id="cmp-b">${opt(bodyCmp[1])}</select></div>
        <div id="cmp-out"></div>
      </div>` : ''}
      <h3>Добавить фото</h3>
      <div class="card body-add">
        <label class="fld">Дата съёмки<input type="date" id="ph-date" value="${state.today}" max="${state.today}"></label>
        <label class="btn ghost ph-btn">Выбрать фото<input type="file" id="ph-file" accept="image/*" multiple hidden></label>
      </div>
      <h3>Все даты <small>${withData.length}</small></h3>
      <div id="body-list">${[...withData].reverse().map((d) => `
        <div class="card bday" data-date="${d.date}">
          <div class="bday-top"><b>${longDate(d.date)}</b>
            <span>${BODY_KEYS.map(([k, l, u]) => (d[k] != null ? `<i>${l} <b>${num2(d[k])}</b>${k === 'kg' && d.kgNear ? '≈' : ''}</i>` : '')).join('')}</span></div>
          ${d.photos.length ? `<div class="thumbs">${d.photos.map((p) => `<img loading="lazy" src="${photoUrl(p)}" data-id="${p.id}" alt="">`).join('')}</div>` : ''}
        </div>`).join('') || '<p class="empty">Пока ничего нет. Запиши замеры или добавь фото.</p>'}</div>`, (el) => {
      const renderCmp = () => {
        const out = $('#cmp-out', el);
        if (!out) return;
        const A = days.find((d) => d.date === bodyCmp[0]), B = days.find((d) => d.date === bodyCmp[1]);
        const rows = BODY_KEYS.map(([k, l, u]) => {
          const a = A[k], c = B[k], diff = a != null && c != null ? c - a : null;
          const ds = diff == null ? '–' : `${diff > 0 ? '+' : ''}${num2(diff)}`;
          return `<tr><td class="l">${l}, ${u}</td><td>${a != null ? num2(a) : '–'}</td><td>${c != null ? num2(c) : '–'}</td><td class="${diff < 0 ? 'down' : diff > 0 ? 'up' : ''}">${ds}</td></tr>`;
        }).join('');
        const n = Math.max(A.photos.length, B.photos.length);
        let pairs = '';
        for (let i = 0; i < n; i++) {
          const cell = (p) => (p ? `<img src="${photoUrl(p)}" data-id="${p.id}" alt="">` : '<div class="nophoto">нет фото</div>');
          pairs += `<div class="pair">${cell(A.photos[i])}${cell(B.photos[i])}</div>`;
        }
        const span = daysBetween(A.date, B.date);
        out.innerHTML = `<table class="dtable cmp-t"><tr><td></td><td>${shortDate(A.date)}</td><td>${shortDate(B.date)}</td><td>разница</td></tr>${rows}</table>
          <p class="muted">Между датами ${Math.abs(span)} ${plural(Math.abs(span), 'день', 'дня', 'дней')}.</p>
          ${n ? `<div class="pairs">${pairs}</div>` : ''}`;
        $$('img', out).forEach((im) => im.addEventListener('click', () => view(im.dataset.id)));
      };
      ['a', 'b'].forEach((w, i) => { const s = $(`#cmp-${w}`, el); s && s.addEventListener('change', () => { bodyCmp[i] = s.value; renderCmp(); }); });
      renderCmp();
      $$('.thumbs img', el).forEach((im) => im.addEventListener('click', () => view(im.dataset.id)));
      $('#ph-file', el).addEventListener('change', async (e) => {
        const files = [...e.target.files];
        const date = $('#ph-date', el).value || state.today;
        if (!files.length) return;
        toast(`Загружаю ${files.length} фото…`);
        try {
          for (const f of files) await api('/api/photos', { method: 'POST', body: { date, data: await shrinkPhoto(f) } });
          toast('Фото добавлены');
          openBody();
        } catch (err) { toast(err.message); }
      });
    });
  }

  // shrink to 1600 px on the long side so a phone photo uploads fast and the server stays small
  function shrinkPhoto(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не получилось открыть фото')); };
      img.src = url;
    });
  }

  // full-screen photo viewer: swipe (or the arrows) through every photo; «Два рядом» shows the photo and the
  // next one side by side, and swiping then moves the pair by one photo
  let viewerPair = false;
  function viewPhotos(list, id) {
    if (!list.length) return;
    let i = Math.max(0, list.findIndex((p) => p.id === id));
    const v = document.createElement('div');
    v.className = 'viewer';
    document.body.appendChild(v);
    document.body.classList.add('page-open');
    const close = () => { v.remove(); if ($('#page').hidden) document.body.classList.remove('page-open'); };
    const img = (p) => (p ? `<figure><img src="${photoUrl(p)}" alt=""><figcaption>${shortDate(p.date)}</figcaption></figure>` : '<figure class="none"><div class="nophoto">дальше фото нет</div></figure>');
    const render = () => {
      const last = viewerPair ? Math.max(0, list.length - 2) : list.length - 1;
      i = Math.min(i, last);
      const cur = list[i];
      v.innerHTML = `<div class="v-top">
          <button type="button" class="v-btn" data-v="close" aria-label="Закрыть">✕</button>
          <span class="v-pos">${viewerPair ? `${i + 1}–${Math.min(i + 2, list.length)}` : i + 1} из ${list.length}</span>
          <button type="button" class="v-mode ${viewerPair ? 'on' : ''}" data-v="pair">Два рядом</button></div>
        <div class="v-stage ${viewerPair ? 'pair' : ''}">${img(cur)}${viewerPair ? img(list[i + 1]) : ''}</div>
        <div class="v-bottom">
          <button type="button" class="v-btn" data-v="prev" ${i === 0 ? 'disabled' : ''} aria-label="Назад">‹</button>
          ${viewerPair ? '' : '<button type="button" class="v-del" data-v="del">Удалить фото</button>'}
          <button type="button" class="v-btn" data-v="next" ${i >= last ? 'disabled' : ''} aria-label="Дальше">›</button></div>`;
    };
    const go = (d) => { const last = viewerPair ? Math.max(0, list.length - 2) : list.length - 1; const n = Math.max(0, Math.min(last, i + d)); if (n !== i) { i = n; render(); } };
    v.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      const act = b.dataset.v;
      if (act === 'close') close();
      else if (act === 'pair') { viewerPair = !viewerPair; render(); }
      else if (act === 'prev') go(-1);
      else if (act === 'next') go(1);
      else if (act === 'del') {
        if (!confirm('Удалить это фото?')) return;
        await api(`/api/photos/${list[i].id}`, { method: 'DELETE' });
        close(); toast('Фото удалено'); openBody();
      }
    });
    let x0 = null, y0 = null;
    v.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    v.addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
      else if (dy > 120 && Math.abs(dx) < 60) close(); // pull down to close
      x0 = y0 = null;
    }, { passive: true });
    render();
  }
  $('#body-open').addEventListener('click', () => openBody().catch((e) => toast(e.message)));

  // check-in sheet on entering the app, from 10:00 only: today's weight if not entered yet, and the
  // measurements when two weeks have passed. Each is asked at most once a day ("Позже" means tomorrow).
  const CHECKIN_HOUR = 10;
  const askedOn = (k) => { try { return localStorage.getItem(k) === state.today; } catch (_) { return false; } };
  const markAsked = (k) => { try { localStorage.setItem(k, state.today); } catch (_) { /* private mode */ } };

  async function checkIns(force) {
    if (state.weightAsked) return;
    if (!force && new Date().getHours() < CHECKIN_HOUR) return;
    let g;
    try { g = await api('/api/goals'); } catch (_) { return; /* offline or unauthorized */ }
    const ms = g.measurements || [];
    const last = ms[ms.length - 1];
    const measureDue = !!g.measure_due && g.measure_due <= state.today;
    const needWeight = !g.weight_today && !askedOn('weightAsked');
    const needMeasure = measureDue && (force || !askedOn('measureAsked'));
    if (!needWeight && !needMeasure) return;
    state.weightAsked = true;
    if (needWeight) markAsked('weightAsked');
    if (needMeasure) markAsked('measureAsked');
    const lastVals = last && (last.chest != null || last.waist != null || last.hips != null)
      ? `: ОГ ${last.chest != null ? fmt(last.chest, 1) : '–'} · ОТ ${last.waist != null ? fmt(last.waist, 1) : '–'} · ОБ ${last.hips != null ? fmt(last.hips, 1) : '–'}` : '';
    openModal(`
      <h3>${needMeasure ? 'Две недели прошли: замеры' : 'Какой сегодня вес?'}</h3>
      <form class="form" id="ci-form">
        ${needWeight ? '<label>Вес, кг <input name="kg" type="number" step="0.1" inputmode="decimal" autofocus></label>' : ''}
        ${needMeasure ? `<p class="muted" style="margin:6px 2px 0">Прошлый замер ${shortDate(last.date)}${lastVals}</p>
          <div class="row2"><label>ОГ, см <input name="chest" type="number" step="0.1" inputmode="decimal"></label>
          <label>ОТ, см <input name="waist" type="number" step="0.1" inputmode="decimal"></label>
          <label>ОБ, см <input name="hips" type="number" step="0.1" inputmode="decimal"></label></div>` : ''}
        <button class="btn" type="submit">Записать</button>
        <button class="btn ghost" type="button" id="ci-skip">Позже</button>
      </form>`, (el) => {
      el.querySelector('#ci-skip').addEventListener('click', closeModal);
      el.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const kg = f.kg ? Number(f.kg.value) : 0;
        if (kg) await api('/api/weight', { method: 'POST', body: { kg } });
        if (f.chest && (f.chest.value || f.waist.value || f.hips.value)) {
          await api('/api/measurements', { method: 'POST', body: { chest: f.chest.value || null, waist: f.waist.value || null, hips: f.hips.value || null } });
        }
        toast('Записано');
        closeModal();
        if (state.tab === 'goals') loadGoals();
      });
    });
  }

  // ---------- phone notifications (Web Push) ----------
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const b64ToBytes = (s) => { const b = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };

  async function renderPush() {
    const box = $('#push-card');
    let on = false;
    if (pushSupported() && Notification.permission === 'granted') {
      try { const reg = await navigator.serviceWorker.ready; on = !!(await reg.pushManager.getSubscription()); } catch (_) { /* ignore */ }
    }
    if (!pushSupported()) {
      box.innerHTML = `<h3>Уведомления</h3><p class="muted">Чтобы телефон напоминал про замеры, открой приложение с иконки на экране «Домой», а не в браузере, и нажми здесь «Включить».</p>`;
      return;
    }
    if (Notification.permission === 'denied') {
      box.innerHTML = `<h3>Уведомления</h3><p class="muted">Уведомления запрещены в настройках телефона: Настройки → Уведомления → MealLog → Допуск уведомлений.</p>`;
      return;
    }
    box.innerHTML = on
      ? `<h3>Уведомления <small class="ok">включены</small></h3><p class="muted">В день замеров в 10:00 придёт напоминание, и ещё одно через два дня, если замеры не записаны.</p>
         <button class="btn ghost" id="push-test">Прислать проверочное</button>`
      : `<h3>Уведомления</h3><p class="muted">Раз в две недели телефон напомнит про замеры ОГ, ОТ, ОБ.</p>
         <button class="btn" id="push-on">Включить напоминания</button>`;
    const onBtn = $('#push-on', box), testBtn = $('#push-test', box);
    if (onBtn) onBtn.addEventListener('click', enablePush);
    if (testBtn) testBtn.addEventListener('click', async () => {
      const r = await api('/api/push/test', { method: 'POST' });
      toast(r.sent ? 'Отправлено, проверь экран' : 'Не дошло, нажми «Включить» ещё раз');
    });
  }

  async function enablePush() {
    try {
      if ((await Notification.requestPermission()) !== 'granted') { renderPush(); return; }
      const reg = await navigator.serviceWorker.ready;
      const { key } = await api('/api/push/key');
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
      await api('/api/push/test', { method: 'POST' });
      toast('Напоминания включены');
    } catch (err) {
      toast('Не получилось включить: ' + (err.message || err));
    }
    renderPush();
  }

  // re-send the current subscription now and then: the phone may rotate it
  async function syncPush() {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
    } catch (_) { /* offline */ }
  }

  // ---------- lifecycle ----------
  // iOS standalone PWA does not reload on reopen: refresh on visibility/pageshow, not on load.
  function onWake() {
    const t = localToday();
    if (state.today !== t) { state.today = t; state.date = t; weeksBuilt = null; }
    state.weightAsked = false;
    state.goals = null;    // forces /api/days refetch (Claude may have logged meals meanwhile)
    state.products = [];   // fridge may have changed too
    refresh();
    checkIns();
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onWake(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) onWake(); });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'updated') location.reload();
    });
  }

  state.today = localToday();
  state.date = state.today;
  let initial = 'journal';
  try { initial = localStorage.getItem('tab') || 'journal'; } catch (_) { /* ignore */ }
  if (!TITLES[initial]) initial = 'journal';
  try { state.prodView = localStorage.getItem('prodView') || 'fridge'; } catch (_) { /* ignore */ }
  try { state.sort = localStorage.getItem('sort') || 'default'; } catch (_) { /* ignore */ }
  try { state.closedShelves = JSON.parse(localStorage.getItem('closedShelves') || '[]'); } catch (_) { /* ignore */ }
  if (!SORTS[state.sort]) state.sort = 'default';
  showTab(initial);
  const fromPush = new URLSearchParams(location.search).has('checkin');
  if (fromPush) history.replaceState(null, '', '/');
  checkIns(fromPush);
  syncPush();
})();
