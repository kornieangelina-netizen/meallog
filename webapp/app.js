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
  const css = getComputedStyle(document.documentElement);
  const COLOR = Object.fromEntries(MACROS.map((m) => [m, css.getPropertyValue(`--${m}`).trim()]));

  const state = {
    tab: 'journal',
    date: null,          // selected day, 'YYYY-MM-DD'
    today: null,         // local today, refreshed on wake
    serverToday: null,   // from /api/recs
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
  const maxDate = () => addDays(state.today, 1); // plan for tomorrow is allowed

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

  // swipe-to-reveal actions on .item elements
  function swipeable(el) {
    let x0 = null;
    el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (dx < -40) { $$('.item.open').forEach((o) => o !== el && o.classList.remove('open')); el.classList.add('open'); }
      else if (dx > 40) el.classList.remove('open');
      x0 = null;
    }, { passive: true });
    el.querySelector('.row').addEventListener('click', () => {
      if (el.classList.contains('open')) el.classList.remove('open');
    });
  }

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
  const TITLES = { journal: 'Журнал', recs: 'План на день', products: 'Продукты', analytics: 'Аналитика', goals: 'Цели' };
  function showTab(tab) {
    state.tab = tab;
    $$('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${tab}`));
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    const dated = tab === 'journal' || tab === 'recs';
    $('#title').textContent = TITLES[tab];
    $('#week-wrap').hidden = !dated;
    $('#month-btn').hidden = !dated;
    try { localStorage.setItem('tab', tab); } catch (_) { /* private mode */ }
    refresh();
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  function refresh() {
    const dated = state.tab === 'journal' || state.tab === 'recs';
    $('#date-title').textContent = dated ? dateTitle(state.date) : TITLES[state.tab];
    $('#title').textContent = dated ? `${TITLES[state.tab]} · ${WEEKDAYS_LONG[weekdayIdx(state.date)]}` : ({ analytics: 'Питание в цифрах', products: 'Справочник и холодильник', goals: 'Настройки' }[state.tab]);
    if (dated) renderWeeks();
    const r = { journal: loadJournal, recs: loadRecs, products: loadProducts, analytics: loadAnalytics, goals: loadGoals }[state.tab];
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
    state.serverToday = d.today;
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
      cells += `<button class="${cls}" data-date="${s}" ${future ? 'disabled' : ''}>${future ? '' : dayRing(s, 40, 2.5)}<span>${d}</span></button>`;
    }
    const monthTotals = Object.values(state.dayTotals).filter((t) => t.date.startsWith(state.pickerMonth));
    const avg = monthTotals.length ? Math.round(monthTotals.reduce((a, t) => a + t.kcal, 0) / monthTotals.length) : null;
    $('#cal').innerHTML = `
      <div class="cal-head"><button id="cal-prev">‹</button><b>${MONTHS_NOM[m - 1]} ${y}</b><button id="cal-next">›</button></div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-legend"><span><i style="background:${COLOR.kcal}"></i>кольцо = калории от нормы</span>
        <span><i style="background:${COLOR.carbs}"></i>выше нормы</span></div>
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
      if (x0 == null || !(state.tab === 'journal' || state.tab === 'recs')) return;
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
      return { title: m.description.slice('Из FatSecret: '.length), sub: timeOf(m.logged_at) };
    }
    return { title: m.name, sub: [timeOf(m.logged_at), m.grams ? `${fmt(m.grams)} г` : '', m.description].filter(Boolean).join(' · ') };
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
    renderFits(d);
    const box = $('#meals');
    box.innerHTML = '';
    $('#meals-empty').hidden = d.meals.length > 0;
    const bySlot = {};
    for (const m of d.meals) (bySlot[m.slot || 'snack'] = bySlot[m.slot || 'snack'] || []).push(m);
    for (const slot of SLOTS) {
      const items = bySlot[slot] || [];
      const kcal = items.reduce((a, m) => a + m.kcal, 0);
      const sec = document.createElement('section');
      sec.className = `slot-sec ${items.length ? '' : 'empty'}`;
      sec.innerHTML = `<div class="slot-head"><span class="slot-title">${SLOT_TITLES[slot]}</span>
          <span class="slot-sum">${items.length ? `<b>${fmt(kcal)}</b> ккал` : ''}</span>
          <button class="slot-add" data-slot="${slot}" aria-label="Добавить">+</button></div>
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
      <div class="actions"><button data-del="${m.id}">Удалить</button></div>
      <div class="row">
        <div class="grow"><div class="name">${esc(title)}</div><div class="sub">${esc(sub)}</div></div>
        <div class="macros"><b>${fmt(m.kcal)}</b> <span class="k">ккал</span>
          <div class="mrow"><span><i class="dot protein"></i>${fmt(m.protein)}</span><span><i class="dot fat"></i>${fmt(m.fat)}</span><span><i class="dot carbs"></i>${fmt(m.carbs)}</span></div>
        </div>
        <span class="chev">›</span>
      </div>`;
    li.querySelector('[data-del]').addEventListener('click', async () => {
      await api(`/api/meals/${m.id}`, { method: 'DELETE' });
      toast('Удалено'); state.products = []; loadJournal();
    });
    swipeable(li);
    li.querySelector('.row').addEventListener('click', () => { if (!li.classList.contains('open')) openEditSheet(m); });
    return li;
  }

  // fridge items that fit into what is left today, by protein density
  function renderFits(d) {
    const box = $('#fits');
    const left = d.left.kcal;
    if (state.date !== state.today || left < 100) { box.innerHTML = ''; return; }
    const items = state.products.filter((p) => p.fridge_qty > 0).map((p) => {
      const one = p.basis === 'portion' ? p : { ...p, kcal: p.kcal * (p.grams || 100) / 100, protein: p.protein * (p.grams || 100) / 100 };
      return { p, kcal: one.kcal, protein: one.protein };
    }).filter((x) => x.kcal > 0 && x.kcal <= left).sort((a, b) => (b.protein / b.kcal) - (a.protein / a.kcal)).slice(0, 6);
    if (!items.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="fits-title">Влезет в остаток <span>${fmt(left)} ккал</span></div>
      <div class="quick">${items.map((x) => `<button data-id="${x.p.id}"><b>${fmt(x.kcal)}</b> ${esc(x.p.name)}</button>`).join('')}</div>`;
    $$('button', box).forEach((b) => b.addEventListener('click', () => quickLog(state.products.find((p) => p.id === Number(b.dataset.id)))));
  }

  function renderHero(d) {
    const goal = d.goals.kcal || 1;
    const pct = d.totals.kcal / goal;
    const over = d.totals.kcal > goal;
    const minis = ['protein', 'fat', 'carbs'].map((m) => {
      const g = d.goals[m] || 1, p = d.totals[m] / g;
      return `<div class="mini"><div class="r">${ring(44, 5, p, COLOR[m])}<span>${Math.round(p * 100)}%</span></div>
        <div class="t"><b>${fmt(d.totals[m])} <small>/ ${fmt(g)} г</small></b>${MACRO_LABELS[m]}</div></div>`;
    }).join('');
    $('#hero').innerHTML = `
      <div class="ring-big">${ring(150, 12, pct, over ? COLOR.carbs : COLOR.kcal)}
        <div style="text-align:center;position:relative"><div class="val">${fmt(d.totals.kcal)}</div>
          <div class="of">${over ? `+${fmt(d.totals.kcal - goal)} сверх нормы` : `из ${fmt(goal)} ккал`}</div>
          <div class="cap">${over ? 'перебор' : `осталось ${fmt(d.left.kcal)}`}</div></div>
      </div>
      <div class="minis">${minis}</div>`;
    const p = $('#pace');
    if (d.pace != null && d.pace > 0 && d.count) {
      const shouldKcal = d.goals.kcal * d.pace;
      const diff = d.totals.kcal - shouldKcal;
      p.innerHTML = `Темп: к этому часу обычно <b>${fmt(shouldKcal)} ккал</b>, ${diff >= 0 ? 'опережение' : 'запас'} ${fmt(Math.abs(diff))} ккал. Белка осталось <b>${fmt(Math.max(0, d.left.protein))} г</b>.`;
    } else if (d.count) {
      p.innerHTML = `Итого: <b>${fmt(d.totals.kcal)} ккал</b> из ${fmt(d.goals.kcal)} · Б ${fmt(d.totals.protein)} · Ж ${fmt(d.totals.fat)} · У ${fmt(d.totals.carbs)}`;
    } else p.textContent = '';
  }

  // add sheet: pick from the fridge / catalogue, or type a meal by hand
  function openAddSheet(slot) {
    slot = slot || slotForHour(new Date().getHours());
    const dayNote = state.date === state.today ? '' : ` · ${dateTitle(state.date).toLowerCase()}`;
    openModal(`
      <h3>${SLOT_ONE[slot]}${dayNote}</h3>
      <div class="seg small" id="add-tabs"><button data-t="pick" class="on">Из холодильника</button><button data-t="recent">Недавнее</button><button data-t="manual">Вручную</button></div>
      <div id="add-pick">
        <input type="search" id="add-search" placeholder="Поиск по справочнику" autocomplete="off">
        <div class="pick-list" id="add-list"></div>
      </div>
      <div id="add-recent" hidden><div class="pick-list" id="recent-list"><p class="muted">Загружаю…</p></div></div>
      <form class="form" id="add-manual" hidden>
        <label>Название <input name="name" required></label>
        <div class="row2"><label>Время <input name="time" type="time" value="${state.date === state.today ? nowHM() : '12:00'}"></label>
          <label>Приём <select name="slot">${SLOTS.map((s) => `<option value="${s}" ${s === slot ? 'selected' : ''}>${SLOT_ONE[s]}</option>`).join('')}</select></label></div>
        <div class="row2"><label>Ккал <input name="kcal" type="number" inputmode="decimal" step="any" required></label>
          <label>Вес, г <input name="grams" type="number" inputmode="decimal" step="any"></label></div>
        <div class="row2"><label>Белки <input name="protein" type="number" inputmode="decimal" step="any" value="0"></label>
          <label>Жиры <input name="fat" type="number" inputmode="decimal" step="any" value="0"></label>
          <label>Углев. <input name="carbs" type="number" inputmode="decimal" step="any" value="0"></label></div>
        <label>Состав <input name="description"></label>
        <button class="btn" type="submit">Записать</button>
      </form>`, (el) => {
      $$('#add-tabs button', el).forEach((b) => b.addEventListener('click', () => {
        $$('#add-tabs button', el).forEach((x) => x.classList.toggle('on', x === b));
        $('#add-pick', el).hidden = b.dataset.t !== 'pick';
        $('#add-recent', el).hidden = b.dataset.t !== 'recent';
        $('#add-manual', el).hidden = b.dataset.t !== 'manual';
        if (b.dataset.t === 'recent') renderRecent();
      }));
      // "repeat": the same dish as lately, copied with its macros (no fridge deduction)
      let recent = null;
      const whenOf = () => `${state.date}T${state.date === state.today ? nowHM() : '12:00'}:00`;
      const renderRecent = async () => {
        const list = $('#recent-list', el);
        if (!recent) recent = (await api('/api/meals/recent')).meals;
        list.innerHTML = recent.map((m, i) => { const t = mealTitle({ ...m, logged_at: m.last }); return `<button class="pick" data-i="${i}">
            <span class="grow"><span class="name">${esc(t.title)}</span><span class="sub">${fmt(m.kcal)} ккал · Б ${fmt(m.protein)} · Ж ${fmt(m.fat)} · У ${fmt(m.carbs)}${m.grams ? ` · ${fmt(m.grams)} г` : ''} · ${shortDate(m.last.slice(0, 10))}${m.n > 1 ? `, ×${m.n}` : ''}</span></span>
            <span class="chev">+</span></button>`; }).join('') || '<p class="muted">За три недели записей нет.</p>';
        $$('.pick', list).forEach((b) => b.addEventListener('click', async () => {
          const m = recent[Number(b.dataset.i)];
          const body = { name: m.name, description: m.description, grams: m.grams, kcal: m.kcal, protein: m.protein, fat: m.fat, carbs: m.carbs, slot, when: whenOf() };
          await api('/api/meals', { method: 'POST', body });
          closeModal(); toast('Записано'); state.goals = null; loadJournal();
        }));
      };
      const list = $('#add-list', el), search = $('#add-search', el);
      const render = () => {
        const q = search.value.trim().toLowerCase();
        let items = state.products;
        if (q) items = items.filter((p) => (p.name + ' ' + (p.aliases || '')).toLowerCase().includes(q));
        else items = [...items].sort((a, b) => (b.fridge_qty > 0) - (a.fridge_qty > 0) || (state.frequent.indexOf(a.id) + 1 || 99) - (state.frequent.indexOf(b.id) + 1 || 99));
        list.innerHTML = items.slice(0, 40).map((p) => `<button class="pick" data-id="${p.id}">
            <span class="grow"><span class="name">${esc(p.name)}</span><span class="sub">${fmt(p.kcal)} ккал · Б ${fmt(p.protein)} · Ж ${fmt(p.fat)} · У ${fmt(p.carbs)} на ${p.basis === 'portion' ? 'порцию' : '100 г'}${p.fridge_qty > 0 ? ` · <i>${qty(p.fridge_qty)} ${p.basis === 'portion' ? 'шт' : 'г'} есть</i>` : ''}</span></span>
            <span class="chev">›</span></button>`).join('') || '<p class="muted">Ничего не нашлось. Добавь вручную.</p>';
        $$('.pick', list).forEach((b) => b.addEventListener('click', () => quickLog(state.products.find((p) => p.id === Number(b.dataset.id)), slot)));
      };
      search.addEventListener('input', render);
      render();
      $('#add-manual', el).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const body = { name: f.name.value, kcal: f.kcal.value, grams: f.grams.value || null, protein: f.protein.value, fat: f.fat.value,
          carbs: f.carbs.value, description: f.description.value, slot: f.slot.value, when: `${state.date}T${f.time.value || '12:00'}:00` };
        await api('/api/meals', { method: 'POST', body });
        closeModal(); toast('Записано'); state.goals = null; loadJournal();
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
        <div class="row2"><label>Белки <input name="protein" type="number" inputmode="decimal" step="any" value="${m.protein}"></label>
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

  // ---------- recommendations ----------
  async function loadRecs() {
    await loadDayTotals();
    const d = await api(`/api/recs?date=${state.date}`);
    state.serverToday = d.today;
    const box = $('#recs');
    box.innerHTML = '';
    $('#recs-empty').hidden = d.plan.length > 0;
    const locked = state.date < d.today && new Date().getHours() >= 7;
    $('#regen').disabled = state.date < d.today;
    $('#regen').textContent = d.plan.length ? 'Перегенерировать' : 'Собрать план';
    const bySlot = {};
    for (const r of d.plan) (bySlot[r.slot] = bySlot[r.slot] || []).push(r);
    const tot = { kcal: 0, protein: 0, fat: 0, carbs: 0 };
    for (const slot of SLOT_ORDER) {
      const items = bySlot[slot];
      if (!items) continue;
      box.insertAdjacentHTML('beforeend', `<div class="slot">${esc(items[0].slot_title)}</div>`);
      for (const r of items) {
        for (const m in tot) tot[m] += r[m];
        const div = document.createElement('div');
        div.className = `rec ${r.done ? 'done' : ''} ${locked ? 'locked' : ''}`;
        div.innerHTML = `<input type="checkbox" ${r.done ? 'checked' : ''} ${locked ? 'disabled' : ''}>
          <div class="name"><div>${esc(r.name)}${flags(r)}</div>
            <div class="sub muted">${fmt(r.portions, 1)} порц.${r.grams ? ` · ${fmt(r.grams)} г` : ''}${r.note ? ` · ${esc(r.note)}` : ''}</div></div>
          <div class="macros"><b>${fmt(r.kcal)}</b> <span class="k">ккал</span>
            <div class="mrow"><span><i class="dot protein"></i>${fmt(r.protein)}</span><span><i class="dot fat"></i>${fmt(r.fat)}</span><span><i class="dot carbs"></i>${fmt(r.carbs)}</span></div></div>`;
        div.querySelector('input').addEventListener('change', async (e) => {
          e.target.disabled = true;
          try { await api(`/api/recs/${r.id}/toggle`, { method: 'POST' }); toast(e.target.checked ? 'Записано в журнал' : 'Отменено'); }
          finally { loadRecs(); }
        });
        box.appendChild(div);
      }
    }
    if (d.plan.length) {
      box.insertAdjacentHTML('beforeend', `<p class="rec-total">План: ${fmt(tot.kcal)} ккал · Б ${fmt(tot.protein)} · Ж ${fmt(tot.fat)} · У ${fmt(tot.carbs)}</p>`);
    }
  }

  $('#regen').addEventListener('click', () => openModal(`
    <h3>План на ${dateTitle(state.date).toLowerCase()}</h3>
    <form class="form" id="regen-form">
      <label>Пожелание (необязательно) <input name="wish" placeholder="например: без молочного, лёгкий ужин"></label>
      <button class="btn" type="submit">Собрать план</button>
    </form>`, (el) => {
    el.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      btn.disabled = true; btn.textContent = 'Думаю…';
      try {
        const r = await api('/api/recs/regenerate', { method: 'POST', body: { date: state.date, wish: e.target.wish.value } });
        $('#rec-comment').textContent = r.comment || '';
        closeModal(); loadRecs();
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Собрать план';
        let p = el.querySelector('.error'); if (!p) { p = document.createElement('p'); p.className = 'error'; e.target.appendChild(p); }
        p.textContent = err.message;
      }
    });
  }));

  // ---------- products + recipes ----------
  async function loadProducts() {
    const q = $('#product-search').value.trim();
    const [d, rr] = await Promise.all([api(`/api/products${q ? `?q=${encodeURIComponent(q)}` : ''}`), q ? { recipes: null } : api('/api/recipes')]);
    state.products = d.products; state.frequent = d.frequent;
    if (rr.recipes) state.recipes = rr.recipes;
    renderQuick();
    const box = $('#products');
    box.innerHTML = '';
    if (!q) renderRecipes(box);
    const fridge = d.products.filter((p) => p.fridge_qty > 0);
    const rest = d.products.filter((p) => !(p.fridge_qty > 0) && !(p.recipe_id && !q)); // recipes have their own section
    if (fridge.length) {
      const tot = fridge.reduce((a, p) => a + (p.basis === 'portion' ? p.kcal * p.fridge_qty : p.kcal * p.fridge_qty / 100), 0);
      box.insertAdjacentHTML('beforeend', `<div class="cat">В холодильнике <small>· ${fridge.length} ${plural(fridge.length, 'позиция', 'позиции', 'позиций')}, ${fmt(tot)} ккал</small></div>`);
      fridge.forEach((p) => box.appendChild(productItem(p)));
    }
    const cats = {};
    for (const p of rest) (cats[p.category || 'Прочее'] = cats[p.category || 'Прочее'] || []).push(p);
    for (const c of Object.keys(cats).sort()) {
      box.insertAdjacentHTML('beforeend', `<div class="cat">${esc(c)}</div>`);
      cats[c].forEach((p) => box.appendChild(productItem(p)));
    }
    if (!d.products.length && !(state.recipes || []).length) box.innerHTML = '<p class="empty">Справочник пуст. Попроси Claude сохранить продукты или добавь вручную.</p>';
  }

  function renderQuick() {
    const q = $('#quick');
    const items = state.frequent.map((id) => state.products.find((p) => p.id === id)).filter(Boolean);
    q.innerHTML = items.length ? `<div class="quick">${items.map((p) => `<button data-id="${p.id}">+ ${esc(p.name)}</button>`).join('')}</div>` : '';
    $$('button', q).forEach((b) => b.addEventListener('click', () => quickLog(state.products.find((p) => p.id === Number(b.dataset.id)))));
  }

  function productItem(p) {
    const unit = p.basis === 'portion' ? 'шт' : 'г';
    const step = p.basis === 'portion' ? 1 : 100;
    const per = p.basis === 'portion' ? `порция${p.grams ? ` ${fmt(p.grams)} г` : ''}` : '100 г';
    const el = document.createElement('div');
    el.className = 'item three';
    el.innerHTML = `
      <div class="actions">
        <button class="alt" data-act="log">Съела</button>
        <button class="warn" data-act="urgent">${p.urgent ? 'Не срочно' : 'Срочно'}</button>
        <button data-act="del">Удалить</button>
      </div>
      <div class="row">
        <div class="grow"><div class="name">${esc(p.name)}<span class="flags">${flags(p)}</span></div>
          <div class="sub">${fmt(p.kcal)} ккал · Б ${fmt(p.protein)} · Ж ${fmt(p.fat)} · У ${fmt(p.carbs)} на ${per}</div></div>
        <div class="side">
          <div class="qty"><button data-d="-${step}">−</button><span>${qty(p.fridge_qty)} ${unit}</span><button data-d="${step}">+</button></div>
          <button class="eat" data-act="eat">Съела</button>
        </div>
      </div>`;
    $$('.qty button', el).forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const r = await api(`/api/products/${p.id}/fridge`, { method: 'POST', body: { delta: Number(b.dataset.d) } });
      p.fridge_qty = r.product.fridge_qty;
      el.querySelector('.qty span').textContent = `${qty(p.fridge_qty)} ${unit}`;
    }));
    el.querySelector('[data-act=log]').addEventListener('click', () => quickLog(p));
    el.querySelector('[data-act=eat]').addEventListener('click', (e) => { e.stopPropagation(); quickLog(p); });
    el.querySelector('[data-act=urgent]').addEventListener('click', async () => {
      await api(`/api/products/${p.id}/flags`, { method: 'POST', body: { urgent: !p.urgent } });
      loadProducts();
    });
    el.querySelector('[data-act=del]').addEventListener('click', async () => {
      if (!confirm(`Удалить «${p.name}» из справочника?`)) return;
      await api(`/api/products/${p.id}`, { method: 'DELETE' });
      toast('Удалено'); loadProducts();
    });
    el.querySelector('.row').addEventListener('click', () => {
      if (p.recipe_id) { const r = (state.recipes || []).find((x) => x.id === p.recipe_id); if (r) return openRecipeEditor(r); }
      editProduct(p);
    });
    swipeable(el);
    return el;
  }

  // log a catalogue product in any amount: grams or portions, linked both ways when the portion weight is known
  function quickLog(p, slot) {
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
          ${isPortion || both ? `<label>Порций <input name="portions" type="number" inputmode="decimal" step="any" min="0" value="${isPortion ? 1 : ''}"></label>` : ''}
          ${!isPortion || both ? `<label>Граммов <input name="grams" type="number" inputmode="decimal" step="any" min="0" value="${isPortion ? (pg || '') : (pg || 100)}"></label>` : ''}
        </div>
        <div class="row2"><label>Время <input name="time" type="time" value="${state.date === state.today ? nowHM() : '12:00'}"></label>
          <label>Приём <select name="slot">${SLOTS.map((s) => `<option value="${s}" ${s === slot ? 'selected' : ''}>${SLOT_ONE[s]}</option>`).join('')}</select></label></div>
        <p class="muted" id="amount-preview" style="margin:4px 2px 0"></p>
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
        el.querySelector('#amount-preview').innerHTML = factor > 0
          ? `Будет записано: <b>${v('kcal')} ккал</b> · Б ${v('protein')} · Ж ${v('fat')} · У ${v('carbs')}${a.grams ? ` · ${fmt(a.grams)} г` : ''}`
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
    p = p || { basis: 'portion', kcal: 0, protein: 0, fat: 0, carbs: 0 };
    openModal(`
      <h3>${isNew ? 'Новый продукт' : 'Продукт'}</h3>
      <form class="form" id="product-form">
        <label>Название <input name="name" value="${esc(p.name || '')}" required></label>
        <label>Значения указаны
          <select name="basis"><option value="portion" ${p.basis === 'portion' ? 'selected' : ''}>на порцию</option>
            <option value="100g" ${p.basis === '100g' ? 'selected' : ''}>на 100 г</option></select></label>
        <div class="row2"><label>Ккал <input name="kcal" type="number" inputmode="decimal" step="any" value="${p.kcal}"></label>
          <label>Вес порции, г <input name="grams" type="number" inputmode="decimal" step="any" value="${p.grams ?? ''}"></label></div>
        <div class="row2"><label>Белки <input name="protein" type="number" inputmode="decimal" step="any" value="${p.protein}"></label>
          <label>Жиры <input name="fat" type="number" inputmode="decimal" step="any" value="${p.fat}"></label>
          <label>Углев. <input name="carbs" type="number" inputmode="decimal" step="any" value="${p.carbs}"></label></div>
        <div class="row2"><label>Категория <input name="category" value="${esc(p.category || '')}"></label>
          <label>Синонимы <input name="aliases" value="${esc(p.aliases || '')}"></label></div>
        <div class="row2"><label class="chk"><input type="checkbox" name="lactose" ${p.lactose ? 'checked' : ''}> 🥛 лактоза</label>
          <label class="chk"><input type="checkbox" name="sugar" ${p.sugar ? 'checked' : ''}> 🍬 сахар</label></div>
        ${isNew ? '<label>Сразу в холодильник (шт или г) <input name="fridge_add" type="number" inputmode="decimal" value="0"></label>' : ''}
        <button class="btn" type="submit">Сохранить</button>
      </form>`, (el) => {
      el.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const body = {
          name: f.name.value, basis: f.basis.value, kcal: f.kcal.value, grams: f.grams.value || null,
          protein: f.protein.value, fat: f.fat.value, carbs: f.carbs.value, category: f.category.value,
          aliases: f.aliases.value, lactose: f.lactose.checked, sugar: f.sugar.checked,
          fridge_add: f.fridge_add ? f.fridge_add.value : 0,
        };
        await api('/api/products', { method: 'POST', body });
        closeModal(); toast('Сохранено'); loadProducts();
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

  // ----- recipes -----
  function renderRecipes(box) {
    const rs = state.recipes || [];
    box.insertAdjacentHTML('beforeend', `<div class="cat">Рецепты <button class="link" id="new-recipe">+ новый</button></div>`);
    $('#new-recipe', box).addEventListener('click', () => openRecipeEditor(null));
    if (!rs.length) { box.insertAdjacentHTML('beforeend', '<p class="muted" style="margin:0 2px 6px">Рецепт = блюдо из ингредиентов с весом до и после готовки. Сохранённый рецепт попадает в справочник «на 100 г готового», и съеденное считается по граммам.</p>'); return; }
    for (const r of rs) {
      const el = document.createElement('div');
      el.className = 'item recipe';
      el.innerHTML = `<div class="row">
        <div class="grow"><div class="name">${esc(r.name)}</div>
          <div class="sub">${fmt(r.per100.kcal)} ккал · Б ${fmt(r.per100.protein)} · Ж ${fmt(r.per100.fat)} · У ${fmt(r.per100.carbs)} на 100 г готового · всего ${fmt(r.cooked_grams)} г${r.fridge_qty > 0 ? ` · <i>в холодильнике ${qty(r.fridge_qty)} г</i>` : ''}</div></div>
        <div class="side"><button class="eat" data-act="eat">Съела</button></div></div>`;
      el.querySelector('[data-act=eat]').addEventListener('click', (e) => { e.stopPropagation(); const p = state.products.find((x) => x.id === r.product_id); p && quickLog(p); });
      el.querySelector('.row').addEventListener('click', () => openRecipeEditor(r));
      box.appendChild(el);
    }
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
      return p ? { product: p, name: p.name, grams: it.grams } : { name: it.name, grams: it.grams, per: { kcal: it.grams ? it.kcal * 100 / it.grams : 0, protein: it.grams ? it.protein * 100 / it.grams : 0, fat: it.grams ? it.fat * 100 / it.grams : 0, carbs: it.grams ? it.carbs * 100 / it.grams : 0 } };
    });
    openModal(`
      <h3>${r ? 'Рецепт' : 'Новый рецепт'}</h3>
      <form class="form" id="recipe-form">
        <label>Название <input name="name" value="${esc(r ? r.name : '')}" required placeholder="например: Плов с курицей"></label>
        <div class="cat" style="margin-top:12px">Ингредиенты</div>
        <div id="rc-lines"></div>
        <div class="row2" style="margin-top:6px"><button type="button" class="btn ghost" id="rc-add-cat">+ из справочника</button><button type="button" class="btn ghost" id="rc-add-man">+ вручную</button></div>
        <div id="rc-picker" hidden><input type="search" id="rc-search" placeholder="Найти продукт" autocomplete="off"><div class="pick-list" id="rc-list"></div></div>
        <div id="rc-manual" hidden class="card" style="padding:10px;margin-top:8px">
          <label>Название <input id="rm-name"></label>
          <div class="row2"><label>Грамм <input id="rm-grams" type="number" inputmode="decimal" step="any"></label><label>Ккал на 100 г <input id="rm-kcal" type="number" inputmode="decimal" step="any"></label></div>
          <div class="row2"><label>Б на 100 г <input id="rm-protein" type="number" inputmode="decimal" step="any" value="0"></label><label>Ж на 100 г <input id="rm-fat" type="number" inputmode="decimal" step="any" value="0"></label><label>У на 100 г <input id="rm-carbs" type="number" inputmode="decimal" step="any" value="0"></label></div>
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
        name: f.name.value, cooked_grams: Number(f.cooked.value) || null, portion_grams: Number(f.portion.value) || null,
        deduct: f.deduct.checked, to_fridge: f.to_fridge.checked,
        items: lines.map((l) => { const m = lineMacros(l); return { product_id: l.product ? l.product.id : null, name: l.name, grams: Number(l.grams) || 0, kcal: m.kcal, protein: m.protein, fat: m.fat, carbs: m.carbs }; }),
      });
      const save = async (asNew) => {
        if (!lines.length) return toast('Добавь хотя бы один ингредиент');
        const body = payload();
        if (r && !asNew) body.id = r.id;
        if (asNew && r && body.name === r.name) body.name += ' (копия)';
        await api('/api/recipes', { method: 'POST', body });
        closeModal(); toast('Рецепт сохранён'); state.products = []; loadProducts();
      };
      f.addEventListener('submit', (e) => { e.preventDefault(); save(false); });
      if (r) {
        $('#rc-dup', el).addEventListener('click', () => save(true));
        $('#rc-del', el).addEventListener('click', async () => {
          if (!confirm(`Удалить рецепт «${r.name}»?`)) return;
          await api(`/api/recipes/${r.id}`, { method: 'DELETE' });
          closeModal(); toast('Удалено'); loadProducts();
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
      if (s.n) { cur.n += 1; for (const m of MACROS) cur.sum[m] += s[m]; }
    }
    return out.map((w) => ({ date: w.date, n: w.n, ...Object.fromEntries(MACROS.map((m) => [m, w.n ? w.sum[m] / w.n : null])) }));
  }

  const PERIOD_NAME = { 7: 'за неделю', 30: 'за месяц', 90: 'за 3 месяца', all: 'за всё время' };

  function renderAnalytics() {
    const a = state.analytics, g = a.goals;
    const logged = a.series.filter((s) => s.n);
    const periodName = PERIOD_NAME[state.period];
    const useWeekly = a.series.length > 120;
    const pts = useWeekly ? weeklyAll(a.series)
      : a.series.map((s) => ({ date: s.date, n: s.n, ...Object.fromEntries(MACROS.map((m) => [m, s.n ? s[m] : null])) }));
    const inKcal = logged.filter((s) => Math.abs(s.kcal - g.kcal) <= g.kcal * 0.1).length;
    const inProt = logged.filter((s) => s.protein >= g.protein * 0.9).length;
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
      const pp = pct('protein');
      if (pp != null) out.push(pp >= 95 ? `Белок в среднем <b>${pp}% нормы</b> — отлично.` : `Белка в среднем <b>${pp}% нормы</b>: не хватает около ${fmt(g.protein - a.avg.protein)} г в день.`);
      return out;
    })();
    const lastM = ms.length ? ms[ms.length - 1] : null, prevM = ms.length > 1 ? ms[ms.length - 2] : null;
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
        <div class="card tile"><b>${inProt}<small>/${logged.length}</small></b><span>дней добрала белок</span></div>
      </div>

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

      ${a.series.length >= 60 ? `<div class="card chart-card"><div class="ch"><b>Карта дней</b><span>калории от нормы</span></div><div class="chart heat" id="ch-heat"></div>
        <div class="legend"><span><i class="sw" style="background:rgba(255,255,255,.07)"></i>нет записей</span><span><i class="sw" style="background:${COLOR.kcal};opacity:.45"></i>меньше нормы</span><span><i class="sw" style="background:${COLOR.kcal}"></i>в норме</span><span><i class="sw" style="background:${COLOR.carbs}"></i>выше</span></div></div>` : ''}

      <div class="card chart-card"><div class="ch"><b>Тело</b><span>${w.length ? `${fmt(w[w.length - 1].kg, 1)} кг${wDelta != null ? `, ${wDelta > 0 ? '+' : ''}${fmt(wDelta, 1)} ${periodName}` : ''}` : 'вес и объёмы'}</span></div>
        ${w.length > 1 ? '<div class="chart" id="ch-weight"></div>' : `<p class="muted" style="margin:4px 2px 6px">${w.length ? 'Одна запись веса за период.' : 'Веса за этот период нет. Записывай его на вкладке «Цели».'}</p>`}
        ${lastM ? `<div class="body-vals">${mVal('chest', 'ОГ')}${mVal('waist', 'ОТ')}${mVal('hips', 'ОБ')}</div>` : '<p class="muted" style="margin:4px 2px 6px">Объёмов (ОГ / ОТ / ОБ) за этот период нет. Они записываются раз в две недели на вкладке «Цели».</p>'}
        ${ms.length > 1 ? '<div class="chart" id="ch-meas"></div><div class="legend"><span><i class="dot" style="background:#3dbbf5"></i>ОГ</span><span><i class="dot" style="background:#c9d2ff"></i>ОТ</span><span><i class="dot" style="background:#ee5fae"></i>ОБ</span></div>' : ''}
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
    const kOpts = { values: pts.map((p) => p.kcal), color: COLOR.kcal, goal: g.kcal, unit: 'ккал', label: xLabel, tip: (i) => ({ title: `${fmt(pts[i].kcal)} ккал`, text: ptTitle(i) }) };
    if (!useWeekly && n > 45) line(kc, kOpts); else bars(kc, kOpts);
    $('#tbl').innerHTML = `<table class="dtable">${pts.filter((p) => p.kcal != null).map((p) => `<tr><td class="l">${useWeekly ? `нед. с ${shortDate(p.date)}` : `${shortDate(p.date)}, ${WEEKDAYS[weekdayIdx(p.date)]}`}</td><td>${fmt(p.kcal)} ккал</td><td><i class="dot protein"></i>${fmt(p.protein)}</td><td><i class="dot fat"></i>${fmt(p.fat)}</td><td><i class="dot carbs"></i>${fmt(p.carbs)}</td></tr>`).join('')}</table>`;
    $('#tbl-toggle').addEventListener('click', () => { state.showTable = !state.showTable; $('#tbl').hidden = !state.showTable; $('#tbl-toggle').textContent = state.showTable ? 'Скрыть таблицу' : 'Показать таблицу'; });

    // protein / fat / carbs: stacked grams, or one nutrient against its goal
    const drawBju = () => {
      const el = $('#ch-bju'), lg = $('#bju-legend');
      if (state.bju === 'all') {
        stackedBars(el, {
          series: ['protein', 'fat', 'carbs'].map((m) => ({ key: m, color: COLOR[m], values: pts.map((p) => p[m]) })),
          unit: 'г', label: xLabel, height: 190,
          tip: (i) => ({ title: `${fmt(pts[i].protein + pts[i].fat + pts[i].carbs)} г`, text: `${ptTitle(i)}<br><i class="dot protein"></i> Б ${fmt(pts[i].protein)} · <i class="dot fat"></i> Ж ${fmt(pts[i].fat)} · <i class="dot carbs"></i> У ${fmt(pts[i].carbs)}` }),
        });
        lg.innerHTML = ['protein', 'fat', 'carbs'].map((m) => `<span><i class="dot ${m}"></i>${MACRO_LABELS[m].toLowerCase()}, норма ${fmt(g[m])} г</span>`).join('');
      } else {
        const m = state.bju;
        const o = { values: pts.map((p) => p[m]), color: COLOR[m], goal: g[m], unit: 'г', label: xLabel, height: 190, tip: (i) => ({ title: `${fmt(pts[i][m])} г`, text: ptTitle(i) }) };
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
    if ($('#ch-heat')) heatmap($('#ch-heat'), { series: a.series, goal: g.kcal });
    if (w.length > 1) {
      line($('#ch-weight'), {
        values: w.map((x) => x.kg), color: '#c9d2ff', unit: 'кг', height: 150, decimals: 1, zero: false,
        label: (i) => (i === 0 || i === w.length - 1 || (w.length > 6 && i % Math.ceil(w.length / 5) === 0) ? shortDate(w[i].date) : ''),
        tip: (i) => ({ title: `${fmt(w[i].kg, 1)} кг`, text: dateTitle(w[i].date) }),
      });
    }
    if (ms.length > 1) {
      multiLine($('#ch-meas'), {
        series: [{ name: 'ОГ', color: '#3dbbf5', values: ms.map((x) => x.chest) }, { name: 'ОТ', color: '#c9d2ff', values: ms.map((x) => x.waist) }, { name: 'ОБ', color: '#ee5fae', values: ms.map((x) => x.hips) }],
        unit: 'см', height: 160, decimals: 0, zero: false,
        label: (i) => (i === 0 || i === ms.length - 1 || (ms.length > 6 && i % Math.ceil(ms.length / 5) === 0) ? shortDate(ms[i].date) : ''),
        tip: (i) => ({ title: shortDate(ms[i].date), text: ['chest', 'waist', 'hips'].map((k, j) => `${['ОГ', 'ОТ', 'ОБ'][j]} ${ms[i][k] != null ? fmt(ms[i][k], 1) : '–'}`).join(' · ') }),
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
      s += `<path class="bar" data-i="${i}" filter="url(#${id}f)" fill="url(#${id})" d="M${x(i) - bw / 2} ${base} v${-(h - r)} a${r} ${r} 0 0 1 ${r} ${-r} h${bw - 2 * r} a${r} ${r} 0 0 1 ${r} ${r} v${h - r} z"/>`;
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
      s += `<g class="bar" data-i="${i}">`;
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
    const vals = opts.values.map((v, i) => [i, v]).filter(([, v]) => v != null);
    let area = '', dots = '';
    if (vals.length) {
      area = `M${x(vals[0][0]).toFixed(1)} ${f.y(f.min)} ` + vals.map(([i, v]) => `L${x(i).toFixed(1)} ${f.y(v).toFixed(1)}`).join(' ') + ` L${x(vals[vals.length - 1][0]).toFixed(1)} ${f.y(f.min)} Z`;
      const [li, lv] = vals[vals.length - 1];
      dots = `<circle cx="${x(li)}" cy="${f.y(lv)}" r="4.5" fill="${opts.color}" stroke="#0f1526" stroke-width="2"/>`;
    }
    let s = `<svg viewBox="0 0 ${f.W} ${f.H}"><defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${opts.color}" stop-opacity=".35"/><stop offset="1" stop-color="${opts.color}" stop-opacity="0"/></linearGradient>
      <filter id="${id}f" x="-10%" y="-40%" width="120%" height="180%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>${f.grid}
      <path d="${area}" fill="url(#${id})"/>
      <path d="${linePath(x, f.y, opts.values)}" fill="none" stroke="${opts.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" filter="url(#${id}f)"/>${dots}`;
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

  // several lines on ONE axis (same unit), e.g. body measurements in cm
  function multiLine(el, opts) {
    const all = opts.series.flatMap((s) => s.values);
    const f = frame(el, { ...opts, values: all });
    const n = opts.series[0].values.length;
    const x = (i) => f.pad.l + ((f.W - f.pad.l - f.pad.r) * i) / Math.max(1, n - 1);
    const id = `m${++gid}`;
    let s = `<svg viewBox="0 0 ${f.W} ${f.H}">${f.grid}`;
    for (const ser of opts.series) {
      s += `<path d="${linePath(x, f.y, ser.values)}" fill="none" stroke="${ser.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      ser.values.forEach((v, i) => { if (v != null) s += `<circle cx="${x(i)}" cy="${f.y(v)}" r="3" fill="${ser.color}" stroke="#0f1526" stroke-width="1.5"/>`; });
    }
    opts.series[0].values.forEach((_, i) => {
      const lbl = opts.label ? opts.label(i) : '';
      if (lbl !== '' && lbl != null) s += `<text x="${x(i)}" y="${f.H - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${lbl}</text>`;
    });
    s += `<line class="cursor" id="${id}c" x1="0" x2="0" y1="${f.pad.t}" y2="${f.H - f.pad.b}" visibility="hidden"/></svg>`;
    el.innerHTML = s;
    const cur = el.querySelector(`#${id}c`);
    const markAt = (i) => { if (i < 0) cur.setAttribute('visibility', 'hidden'); else { cur.setAttribute('x1', x(i)); cur.setAttribute('x2', x(i)); cur.setAttribute('visibility', 'visible'); } };
    markAt.y = () => f.pad.t;
    attachHover(el, x, n, { ...opts, values: all, W: f.W, H: f.H }, markAt);
  }

  // calendar heatmap: one column per week, Monday on top; color = calories against the goal
  function heatmap(el, opts) {
    const days = opts.series, goal = opts.goal || 1;
    const first = weekStart(days[0].date);
    const weeks = Math.ceil((parse(days[days.length - 1].date) - parse(first)) / 864e5 / 7) + 1;
    const W = el.clientWidth || 320, padL = 22, padT = 16, gap = 2;
    const cell = Math.min(14, Math.floor((W - padL - gap * (weeks - 1)) / weeks));
    const H = padT + 7 * (cell + gap);
    const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
    let s = `<svg viewBox="0 0 ${W} ${H}">`;
    ['пн', '', 'ср', '', 'пт', '', 'вс'].forEach((t, r) => { if (t) s += `<text x="0" y="${padT + r * (cell + gap) + cell * 0.8}">${t}</text>`; });
    const cells = [];
    let lastMonth = '';
    for (let w = 0; w < weeks; w++) {
      const ws = addDays(first, w * 7);
      const mon = ws.slice(0, 7);
      const nextMon = addDays(ws, 14).slice(0, 7);
      if (mon !== lastMonth && (w === 0 || parse(ws).getDate() <= 7) && !(w === 0 && nextMon !== mon)) { lastMonth = mon; s += `<text x="${padL + w * (cell + gap)}" y="10">${MONTHS_NOM[parse(ws).getMonth()].slice(0, 3)}</text>`; }
      for (let r = 0; r < 7; r++) {
        const date = addDays(ws, r);
        const d = byDate[date];
        if (!d) continue;
        const ratio = d.n ? d.kcal / goal : null;
        const fill = ratio == null ? 'rgba(255,255,255,.07)' : ratio > 1.1 ? COLOR.carbs : COLOR.kcal;
        const op = ratio == null ? 1 : ratio > 1.1 ? Math.min(1, 0.6 + (ratio - 1.1)) : ratio < 0.9 ? Math.max(0.25, ratio * 0.5) : 1;
        const cx = padL + w * (cell + gap), cy = padT + r * (cell + gap);
        cells.push({ date, d, cx, cy });
        s += `<rect class="cellr" data-i="${cells.length - 1}" x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="3" fill="${fill}" fill-opacity="${op}"/>`;
      }
    }
    s += '</svg>';
    el.innerHTML = s;
    const svg = el.querySelector('svg');
    let timer;
    const pick = (e) => {
      const b = svg.getBoundingClientRect();
      const sx = (e.clientX - b.left) * (W / b.width), sy = (e.clientY - b.top) * (H / b.height);
      const c = cells.find((k) => sx >= k.cx && sx <= k.cx + cell && sy >= k.cy && sy <= k.cy + cell);
      if (!c) return;
      $$('.cellr', svg).forEach((r) => r.classList.toggle('on', Number(r.dataset.i) === cells.indexOf(c)));
      const t = c.d.n ? { title: `${fmt(c.d.kcal)} ккал`, text: `${dateTitle(c.date)} · ${Math.round((100 * c.d.kcal) / goal)}% нормы · Б ${fmt(c.d.protein)} · Ж ${fmt(c.d.fat)} · У ${fmt(c.d.carbs)}` } : { title: 'Нет записей', text: dateTitle(c.date) };
      showTip(el, c.cx + cell / 2, c.cy, W, H, t);
      clearTimeout(timer); timer = setTimeout(hideAllTips, 2500);
    };
    el.addEventListener('pointermove', pick);
    el.addEventListener('pointerdown', pick);
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
    const last = g.weight[g.weight.length - 1];
    $('#weight-last').textContent = last ? `Последняя запись: ${fmt(last.kg, 1)} кг (${shortDate(last.date)})` : 'Веса ещё нет';
    if (g.weight_today) $('#weight-form').kg.value = g.weight_today.kg;
    renderMeasurements(g.measurements || []);
  }

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
    info.innerHTML = `<div class="body-vals">${cell('chest', 'ОГ')}${cell('waist', 'ОТ')}${cell('hips', 'ОБ')}</div>
      <p class="muted">Последний замер ${shortDate(last.date)}${prev ? `, изменения — к ${shortDate(prev.date)}` : ''}.
      Следующий: <b>${left <= 0 ? 'уже пора' : left === 1 ? 'завтра' : `${shortDate(next)}, через ${left} ${plural(left, 'день', 'дня', 'дней')}`}</b>.</p>
      ${ms.length > 1 ? `<details class="hist"><summary>Все замеры (${ms.length})</summary><table class="dtable">${[...ms].reverse().map((m) => `<tr><td class="l">${shortDate(m.date)}</td><td>${m.chest != null ? fmt(m.chest, 1) : '–'}</td><td>${m.waist != null ? fmt(m.waist, 1) : '–'}</td><td>${m.hips != null ? fmt(m.hips, 1) : '–'}</td></tr>`).join('')}</table></details>` : ''}`;
  }

  $('#goals-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('/api/goals', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
    state.goals = r.goals;
    toast('Цели сохранены');
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

  // one check-in sheet on wake: today's weight (every open until entered) and, every two weeks, the measurements (once a day)
  async function checkIns() {
    if (state.weightAsked) return;
    let g;
    try { g = await api('/api/goals'); } catch (_) { return; /* offline or unauthorized */ }
    const ms = g.measurements || [];
    const last = ms[ms.length - 1];
    const measureDue = last ? daysBetween(last.date, state.today) >= MEASURE_EVERY : false;
    let askedToday = false;
    try { askedToday = localStorage.getItem('measureAsked') === state.today; } catch (_) { /* private mode */ }
    const needWeight = !g.weight_today, needMeasure = measureDue && !askedToday;
    if (!needWeight && !needMeasure) return;
    state.weightAsked = true;
    if (needMeasure) { try { localStorage.setItem('measureAsked', state.today); } catch (_) { /* ignore */ } }
    openModal(`
      <h3>${needMeasure ? 'Две недели прошли: замеры' : 'Какой сегодня вес?'}</h3>
      <form class="form" id="ci-form">
        ${needWeight ? '<label>Вес, кг <input name="kg" type="number" step="0.1" inputmode="decimal" autofocus></label>' : ''}
        ${needMeasure ? `<p class="muted" style="margin:6px 2px 0">Прошлый замер ${shortDate(last.date)}: ОГ ${last.chest != null ? fmt(last.chest, 1) : '–'} · ОТ ${last.waist != null ? fmt(last.waist, 1) : '–'} · ОБ ${last.hips != null ? fmt(last.hips, 1) : '–'}</p>
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
  showTab(initial);
  checkIns();
})();
