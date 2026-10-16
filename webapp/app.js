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
  const SLOT_ORDER = ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner'];
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
  async function loadJournal() {
    await loadDayTotals();
    const d = await api(`/api/day?date=${state.date}`);
    state.goals = d.goals;
    state.dayTotals[state.date] = d.count ? { date: state.date, ...d.totals, n: d.count } : undefined;
    if (!state.dayTotals[state.date]) delete state.dayTotals[state.date];
    renderWeeks();
    renderHero(d);
    const list = $('#meals');
    list.innerHTML = '';
    $('#meals-empty').hidden = d.meals.length > 0;
    for (const m of d.meals) {
      const li = document.createElement('li');
      li.className = 'item';
      li.innerHTML = `
        <div class="actions"><button data-del="${m.id}">Удалить</button></div>
        <div class="row">
          <div><div class="name">${esc(m.name)}</div>
            <div class="sub">${timeOf(m.logged_at)}${m.grams ? ` · ${fmt(m.grams)} г` : ''}${m.description ? ` · ${esc(m.description)}` : ''}</div></div>
          <div class="macros"><b>${fmt(m.kcal)}</b> <span class="k">ккал</span>
            <div class="mrow"><span><i class="dot protein"></i>${fmt(m.protein)}</span><span><i class="dot fat"></i>${fmt(m.fat)}</span><span><i class="dot carbs"></i>${fmt(m.carbs)}</span></div>
          </div>
        </div>`;
      li.querySelector('[data-del]').addEventListener('click', async () => {
        await api(`/api/meals/${m.id}`, { method: 'DELETE' });
        toast('Удалено'); loadJournal();
      });
      swipeable(li);
      list.appendChild(li);
    }
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
    if (d.pace != null && d.count) {
      const shouldKcal = d.goals.kcal * d.pace;
      const diff = d.totals.kcal - shouldKcal;
      p.innerHTML = `Темп: к этому часу обычно <b>${fmt(shouldKcal)} ккал</b>, ${diff >= 0 ? 'опережение' : 'запас'} ${fmt(Math.abs(diff))} ккал. Белка осталось <b>${fmt(Math.max(0, d.left.protein))} г</b>.`;
    } else if (d.count) {
      p.innerHTML = `Итого за день: <b>${fmt(d.totals.kcal)} ккал</b> из ${fmt(d.goals.kcal)} · Б ${fmt(d.totals.protein)} · Ж ${fmt(d.totals.fat)} · У ${fmt(d.totals.carbs)}`;
    } else p.textContent = '';
  }

  $('#add-meal').addEventListener('click', () => openModal(`
    <h3>Добавить приём вручную</h3>
    <form class="form" id="meal-form">
      <label>Название <input name="name" required></label>
      <div class="row2"><label>Ккал <input name="kcal" type="number" inputmode="decimal" required></label>
        <label>Вес, г <input name="grams" type="number" inputmode="decimal"></label></div>
      <div class="row2"><label>Белки <input name="protein" type="number" inputmode="decimal" value="0"></label>
        <label>Жиры <input name="fat" type="number" inputmode="decimal" value="0"></label>
        <label>Углев. <input name="carbs" type="number" inputmode="decimal" value="0"></label></div>
      <label>Состав <input name="description"></label>
      <button class="btn" type="submit">Записать</button>
    </form>`, (el) => {
    el.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      if (state.date !== state.today) body.when = `${state.date}T12:00:00`;
      await api('/api/meals', { method: 'POST', body });
      closeModal(); toast('Записано'); state.goals = null; loadJournal();
    });
  }));

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
      } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Собрать план'; }
    });
  }));

  // ---------- products ----------
  async function loadProducts() {
    const q = $('#product-search').value.trim();
    const d = await api(`/api/products${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    state.products = d.products; state.frequent = d.frequent;
    renderQuick();
    const box = $('#products');
    box.innerHTML = '';
    const fridge = d.products.filter((p) => p.fridge_qty > 0);
    const rest = d.products.filter((p) => !(p.fridge_qty > 0));
    if (fridge.length) {
      const tot = fridge.reduce((a, p) => a + (p.basis === 'portion' ? p.kcal * p.fridge_qty : p.kcal * p.fridge_qty / 100), 0);
      box.insertAdjacentHTML('beforeend', `<div class="cat">В холодильнике <small style="text-transform:none;font-weight:500">· ${fridge.length} ${plural(fridge.length, 'позиция', 'позиции', 'позиций')}, ${fmt(tot)} ккал</small></div>`);
      fridge.forEach((p) => box.appendChild(productItem(p)));
    }
    const cats = {};
    for (const p of rest) (cats[p.category || 'Прочее'] = cats[p.category || 'Прочее'] || []).push(p);
    for (const c of Object.keys(cats).sort()) {
      box.insertAdjacentHTML('beforeend', `<div class="cat">${esc(c)}</div>`);
      cats[c].forEach((p) => box.appendChild(productItem(p)));
    }
    if (!d.products.length) box.innerHTML = '<p class="empty">Справочник пуст. Попроси Claude сохранить продукты или добавь вручную.</p>';
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
        <div><div class="name">${esc(p.name)}<span class="flags">${flags(p)}</span></div>
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
    el.querySelector('.row').addEventListener('click', () => editProduct(p));
    swipeable(el);
    return el;
  }

  // log a catalogue product in any amount: grams or portions, linked both ways when the portion weight is known
  function quickLog(p) {
    if (!p) return;
    const isPortion = p.basis === 'portion';
    const pg = Number(p.grams) || 0;           // weight of one portion (may be unknown)
    const both = pg > 0;                        // can convert grams <-> portions
    const per = isPortion ? p : { kcal: p.kcal * pg / 100, protein: p.protein * pg / 100, fat: p.fat * pg / 100, carbs: p.carbs * pg / 100 };
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
        const body = { product_id: p.id };
        if (isPortion) { if (!a.portions) return toast('Укажи количество'); body.portions = a.portions; }
        else { if (!a.grams) return toast('Укажи количество'); body.grams = a.grams; }
        if (state.date !== state.today) body.when = `${state.date}T12:00:00`;
        const r = await api('/api/meals', { method: 'POST', body });
        closeModal(); toast(`Записано: ${fmt(r.meal.kcal)} ккал`);
        state.goals = null; // day totals changed: refetch calendar rings
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
  $('#add-product').addEventListener('click', () => editProduct(null));
  let searchTimer;
  $('#product-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadProducts, 250); });

  // ---------- analytics ----------
  $$('#period button').forEach((b) => b.addEventListener('click', () => {
    state.period = b.dataset.period;
    $$('#period button').forEach((x) => x.classList.toggle('on', x === b));
    loadAnalytics();
  }));
  $$('#nutrient button').forEach((b) => b.addEventListener('click', () => {
    state.nutrient = b.dataset.m;
    $$('#nutrient button').forEach((x) => x.classList.toggle('on', x === b));
    if (state.analytics) renderAnalytics(); // no refetch: the payload carries every nutrient
  }));

  async function loadAnalytics() {
    const box = $('#analytics');
    box.style.opacity = '.5';
    try {
      state.analytics = await api(`/api/analytics?days=${state.period}`);
      renderAnalytics();
    } finally { box.style.opacity = ''; }
  }

  // group a daily series into ISO weeks; value = average over logged days of that week
  function weekly(series, m) {
    const out = [];
    for (const s of series) {
      const w = weekStart(s.date);
      let cur = out[out.length - 1];
      if (!cur || cur.date !== w) { cur = { date: w, sum: 0, n: 0 }; out.push(cur); }
      if (s.n) { cur.sum += s[m]; cur.n += 1; }
    }
    return out.map((w) => ({ date: w.date, value: w.n ? w.sum / w.n : null, n: w.n }));
  }

  function renderAnalytics() {
    const a = state.analytics, m = state.nutrient, unit = UNIT[m], color = COLOR[m], goal = a.goals[m];
    const logged = a.series.filter((s) => s.n);
    const avg = a.avg[m];
    const inTarget = logged.filter((s) => Math.abs(s[m] - goal) <= goal * 0.1).length;
    const best = logged.reduce((b, s) => (!b || s[m] > b[m] ? s : b), null);
    const low = logged.reduce((b, s) => (!b || s[m] < b[m] ? s : b), null);
    const pctGoal = goal ? Math.round((100 * avg) / goal) : null;
    const periodName = { 7: 'за неделю', 30: 'за месяц', 90: 'за 3 месяца', all: 'за всё время' }[state.period];

    // main series: daily for <= 31 days, line for ~90, weekly averages for "all"
    const useWeekly = a.series.length > 120;
    const points = useWeekly
      ? weekly(a.series, m)
      : a.series.map((s) => ({ date: s.date, value: s.n ? s[m] : null, n: s.n }));
    const mainTitle = useWeekly ? 'По неделям' : 'По дням';
    const mainSub = useWeekly ? 'среднее в день' : `${shortDate(a.start)} – ${shortDate(a.end)}`;

    const wd = a.weekday.map((w) => w[m]);
    const hours = a.hours.map((h) => h[m]);
    const share = (() => {
      const p = a.avg.protein * 4, f = a.avg.fat * 9, c = a.avg.carbs * 4, t = p + f + c || 1;
      const gp = a.goals.protein * 4, gf = a.goals.fat * 9, gc = a.goals.carbs * 4, gt = gp + gf + gc || 1;
      return { fact: { protein: p / t, fat: f / t, carbs: c / t }, goal: { protein: gp / gt, fat: gf / gt, carbs: gc / gt } };
    })();
    const w = a.weight;
    const wDelta = w.length > 1 ? w[w.length - 1].kg - w[0].kg : null;

    $('#analytics').innerHTML = `
      <div class="stats">
        <div class="card stat"><b>${fmt(avg)}<small>${unit}</small></b><span>в среднем в день ${periodName}</span>
          ${pctGoal != null ? `<span class="delta ${pctGoal >= 90 && pctGoal <= 110 ? 'good' : ''}">${pctGoal}% от нормы ${fmt(goal)}</span>` : ''}</div>
        <div class="card stat"><b>${inTarget}<small>из ${logged.length}</small></b><span>дней в норме (±10%)</span>
          <span class="delta">${logged.length ? Math.round((100 * inTarget) / logged.length) : 0}% дней</span></div>
        <div class="card stat"><b>${a.streak}<small>${plural(a.streak, 'день', 'дня', 'дней')}</small></b><span>подряд с записями</span></div>
        <div class="card stat"><b>${best ? fmt(best[m]) : '–'}<small>${unit}</small></b><span>максимум${best ? `, ${shortDate(best.date)}` : ''}</span>
          ${low ? `<span class="delta">минимум ${fmt(low[m])} · ${shortDate(low.date)}</span>` : ''}</div>
      </div>

      <div class="card chart-card"><div class="ch"><b>${mainTitle}</b><span>${mainSub}</span></div>
        <div class="chart" id="ch-main"></div>
        <div class="legend"><span><i class="dot ${m}"></i>${MACRO_LABELS[m].toLowerCase()}, ${unit}</span><span><i style="width:14px;height:1px;background:rgba(255,255,255,.5)"></i>норма ${fmt(goal)}</span></div>
        <button class="table-toggle" id="tbl-toggle">${state.showTable ? 'Скрыть таблицу' : 'Показать таблицу'}</button>
        <div id="tbl" ${state.showTable ? '' : 'hidden'}></div>
      </div>

      <div class="card chart-card"><div class="ch"><b>Баланс Б / Ж / У</b><span>доля калорий</span></div>
        <div class="legend" style="padding-top:0"><span>факт</span></div>
        <div class="share">${['protein', 'fat', 'carbs'].map((k) => `<i class="${k}" style="width:${(share.fact[k] * 100).toFixed(1)}%"></i>`).join('')}</div>
        <div class="legend" style="padding-top:2px">${['protein', 'fat', 'carbs'].map((k) => `<span><i class="dot ${k}"></i>${MACRO_LABELS[k]} <b>${Math.round(share.fact[k] * 100)}%</b> · ${fmt(a.avg[k])} г</span>`).join('')}</div>
        <div class="legend" style="margin-top:8px;padding-top:0"><span>норма</span></div>
        <div class="share" style="opacity:.55">${['protein', 'fat', 'carbs'].map((k) => `<i class="${k}" style="width:${(share.goal[k] * 100).toFixed(1)}%"></i>`).join('')}</div>
        <div class="legend" style="padding-top:2px">${['protein', 'fat', 'carbs'].map((k) => `<span><i class="dot ${k}"></i><b>${Math.round(share.goal[k] * 100)}%</b> · ${fmt(a.goals[k])} г</span>`).join('')}</div>
      </div>

      <div class="card chart-card"><div class="ch"><b>По дням недели</b><span>среднее за день</span></div><div class="chart" id="ch-wd"></div></div>
      <div class="card chart-card"><div class="ch"><b>По времени суток</b><span>среднее за день, по часу записи</span></div><div class="chart" id="ch-hours"></div></div>
      <div class="card chart-card"><div class="ch"><b>Вес</b><span>${w.length ? `${fmt(w[w.length - 1].kg, 1)} кг${wDelta != null ? `, ${wDelta > 0 ? '+' : ''}${fmt(wDelta, 1)} ${periodName}` : ''}` : ''}</span></div>
        ${w.length > 1 ? '<div class="chart" id="ch-weight"></div>' : `<p class="muted" style="margin:4px 2px 6px">${w.length ? 'Одна запись. Взвешивайся регулярно, и здесь появится график.' : 'Веса пока нет. Записывай его на вкладке «Цели», и здесь появится график.'}</p>`}
      </div>
      <h3>Чаще всего ${periodName}</h3>
      <ul class="card top-list">${a.top.length ? a.top.map((t) => `<li><div>${esc(t.name)}</div><span>× ${t.n} · ${fmt(t.kcal)} ккал</span></li>`).join('')
        : '<li class="muted">Пока нет блюд с названиями: записи из FatSecret сгруппированы по приёмам. Новые записи через Claude попадут сюда.</li>'}</ul>`;

    const labelEvery = points.length > 45 ? Math.ceil(points.length / 5) : points.length > 20 ? 7 : 1;
    const main = $('#ch-main');
    if (useWeekly) {
      bars(main, {
        values: points.map((p) => p.value), color, goal, unit,
        label: (i) => (i % Math.ceil(points.length / 5) === 0 ? shortDate(points[i].date) : ''),
        tip: (i) => ({ title: `${fmt(points[i].value)} ${unit}`, text: `неделя с ${shortDate(points[i].date)}, ${points[i].n} ${plural(points[i].n, 'день', 'дня', 'дней')}` }),
      });
    } else if (points.length <= 45) {
      bars(main, {
        values: points.map((p) => p.value), color, goal, unit,
        label: (i) => (i % labelEvery === 0 ? parse(points[i].date).getDate() : ''),
        tip: (i) => ({ title: `${fmt(points[i].value)} ${unit}`, text: dateTitle(points[i].date) }),
      });
    } else {
      line(main, {
        values: points.map((p) => p.value), color, goal, unit,
        label: (i) => (i % labelEvery === 0 ? shortDate(points[i].date) : ''),
        tip: (i) => ({ title: `${fmt(points[i].value)} ${unit}`, text: dateTitle(points[i].date) }),
      });
    }
    $('#tbl').innerHTML = `<table class="dtable">${points.filter((p) => p.value != null).map((p) => `<tr><td class="l">${useWeekly ? `нед. с ${shortDate(p.date)}` : `${shortDate(p.date)}, ${WEEKDAYS[weekdayIdx(p.date)]}`}</td><td>${fmt(p.value)} ${unit}</td></tr>`).join('')}</table>`;
    $('#tbl-toggle').addEventListener('click', () => { state.showTable = !state.showTable; $('#tbl').hidden = !state.showTable; $('#tbl-toggle').textContent = state.showTable ? 'Скрыть таблицу' : 'Показать таблицу'; });

    bars($('#ch-wd'), {
      values: wd, color, goal, unit, height: 150,
      label: (i) => WEEKDAYS[i],
      tip: (i) => ({ title: `${fmt(wd[i])} ${unit}`, text: `${WEEKDAYS_LONG[i]} · ${a.weekday[i].n} ${plural(a.weekday[i].n, 'день', 'дня', 'дней')}` }),
    });
    bars($('#ch-hours'), {
      values: hours, color, unit, height: 130,
      label: (i) => (i % 6 === 0 ? `${i}:00` : ''),
      tip: (i) => ({ title: `${fmt(hours[i])} ${unit}`, text: `${i}:00 – ${i + 1}:00` }),
    });
    if (w.length > 1) {
      line($('#ch-weight'), {
        values: w.map((x) => x.kg), color: '#c9d2ff', unit: 'кг', height: 150, decimals: 1, zero: false,
        label: (i) => (i === 0 || i === w.length - 1 || (w.length > 6 && i % Math.ceil(w.length / 5) === 0) ? shortDate(w[i].date) : ''),
        tip: (i) => ({ title: `${fmt(w[i].kg, 1)} кг`, text: dateTitle(w[i].date) }),
      });
    }
  }

  // ---------- SVG charts ----------
  const tipEl = $('#tip');
  function showTip(x, y, t) {
    tipEl.innerHTML = `<b>${t.title}</b>${t.text}`;
    tipEl.hidden = false;
    const r = tipEl.getBoundingClientRect();
    let left = x - r.width / 2;
    left = Math.max(8, Math.min(window.innerWidth - r.width - 8, left));
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${Math.max(8, y - r.height - 14)}px`;
  }
  function hideTip() { tipEl.hidden = true; }

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

  function attachHover(el, hitX, n, opts, markAt) {
    const svg = el.querySelector('svg');
    const bbox = () => svg.getBoundingClientRect();
    const idxAt = (cx) => {
      const b = bbox(), sx = (cx - b.left) * (opts.W / b.width);
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const d = Math.abs(hitX(i) - sx); if (d < bd) { bd = d; best = i; } }
      return best;
    };
    let active = -1;
    const move = (e) => {
      const i = idxAt(e.clientX);
      if (i === active) return;
      active = i;
      $$('.bar', svg).forEach((b, j) => b.classList.toggle('dim', j !== i));
      const t = opts.tip ? opts.tip(i) : null;
      if (!t || opts.values[i] == null) { hideTip(); markAt(-1); return; }
      markAt(i);
      const b = bbox();
      showTip(b.left + hitX(i) * (b.width / opts.W), b.top + markAt.y(i) * (b.height / opts.H), t);
    };
    const leave = () => { active = -1; hideTip(); markAt(-1); $$('.bar', svg).forEach((b) => b.classList.remove('dim')); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', move);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('pointerup', () => setTimeout(leave, 1500));
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
      s += `<path class="bar" filter="url(#${id}f)" fill="url(#${id})" d="M${x(i) - bw / 2} ${base} v${-(h - r)} a${r} ${r} 0 0 1 ${r} ${-r} h${bw - 2 * r} a${r} ${r} 0 0 1 ${r} ${r} v${h - r} z"/>`;
    });
    s += `<line class="cursor" id="${id}c" x1="0" x2="0" y1="${f.pad.t}" y2="${f.H - f.pad.b}" visibility="hidden"/></svg>`;
    el.innerHTML = s;
    const cur = el.querySelector(`#${id}c`);
    const markAt = (i) => { if (i < 0) cur.setAttribute('visibility', 'hidden'); else { cur.setAttribute('x1', x(i)); cur.setAttribute('x2', x(i)); cur.setAttribute('visibility', 'visible'); } };
    markAt.y = (i) => f.y(opts.values[i]);
    attachHover(el, x, n, { ...opts, W: f.W, H: f.H }, markAt);
  }

  function line(el, opts) {
    const f = frame(el, opts);
    const n = opts.values.length;
    const x = (i) => f.pad.l + ((f.W - f.pad.l - f.pad.r) * i) / Math.max(1, n - 1);
    const id = `l${++gid}`;
    let path = '', area = '', dots = '', open = false, lastI = -1;
    opts.values.forEach((v, i) => {
      if (v == null) { open = false; return; }
      path += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${f.y(v).toFixed(1)}`;
      open = true; lastI = i;
    });
    // area under each segment: simple approach, one area over the whole series ignoring gaps (gaps stay unfilled by the line)
    const vals = opts.values.map((v, i) => [i, v]).filter(([, v]) => v != null);
    if (vals.length) {
      area = `M${x(vals[0][0]).toFixed(1)} ${f.y(f.min)} ` + vals.map(([i, v]) => `L${x(i).toFixed(1)} ${f.y(v).toFixed(1)}`).join(' ') + ` L${x(vals[vals.length - 1][0]).toFixed(1)} ${f.y(f.min)} Z`;
    }
    if (lastI >= 0) dots = `<circle cx="${x(lastI)}" cy="${f.y(opts.values[lastI])}" r="4.5" fill="${opts.color}" stroke="#0f1526" stroke-width="2"/>`;
    let s = `<svg viewBox="0 0 ${f.W} ${f.H}"><defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${opts.color}" stop-opacity=".35"/><stop offset="1" stop-color="${opts.color}" stop-opacity="0"/></linearGradient>
      <filter id="${id}f" x="-10%" y="-40%" width="120%" height="180%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>${f.grid}
      <path d="${area}" fill="url(#${id})"/>
      <path d="${path}" fill="none" stroke="${opts.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" filter="url(#${id}f)"/>${dots}`;
    opts.values.forEach((v, i) => {
      const lbl = opts.label ? opts.label(i) : '';
      if (lbl !== '' && lbl != null) s += `<text x="${x(i)}" y="${f.H - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${lbl}</text>`;
    });
    s += `<line class="cursor" id="${id}c" x1="0" x2="0" y1="${f.pad.t}" y2="${f.H - f.pad.b}" visibility="hidden"/>
      <circle id="${id}d" r="5" fill="${opts.color}" stroke="#0f1526" stroke-width="2" visibility="hidden"/></svg>`;
    el.innerHTML = s;
    const cur = el.querySelector(`#${id}c`), dot = el.querySelector(`#${id}d`);
    const markAt = (i) => {
      if (i < 0) { cur.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); return; }
      cur.setAttribute('x1', x(i)); cur.setAttribute('x2', x(i)); cur.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', f.y(opts.values[i])); dot.setAttribute('visibility', 'visible');
    };
    markAt.y = (i) => f.y(opts.values[i]);
    attachHover(el, x, n, { ...opts, W: f.W, H: f.H }, markAt);
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.tab === 'analytics' && state.analytics) renderAnalytics(); }, 150);
  });

  // ---------- goals / weight ----------
  async function loadGoals() {
    const g = await api('/api/goals');
    const f = $('#goals-form');
    for (const k of MACROS) f[k].value = g.goals[k];
    const last = g.weight[g.weight.length - 1];
    $('#weight-last').textContent = last ? `Последняя запись: ${fmt(last.kg, 1)} кг (${shortDate(last.date)})` : 'Веса ещё нет';
    if (g.weight_today) $('#weight-form').kg.value = g.weight_today.kg;
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

  async function weightReminder() {
    if (state.weightAsked) return;
    try {
      const g = await api('/api/goals');
      if (g.weight_today) return;
      state.weightAsked = true;
      openModal(`
        <h3>Какой сегодня вес?</h3>
        <form class="form" id="wr-form">
          <label>кг <input name="kg" type="number" step="0.1" inputmode="decimal" autofocus></label>
          <button class="btn" type="submit">Записать</button>
          <button class="btn ghost" type="button" id="wr-skip">Позже</button>
        </form>`, (el) => {
        el.querySelector('#wr-skip').addEventListener('click', closeModal);
        el.querySelector('form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const kg = Number(e.target.kg.value);
          if (kg) { await api('/api/weight', { method: 'POST', body: { kg } }); toast('Вес записан'); }
          closeModal();
        });
      });
    } catch (_) { /* offline or unauthorized */ }
  }

  // ---------- lifecycle ----------
  // iOS standalone PWA does not reload on reopen: refresh on visibility/pageshow, not on load.
  function onWake() {
    const t = localToday();
    if (state.today !== t) { state.today = t; state.date = t; weeksBuilt = null; }
    state.weightAsked = false;
    state.goals = null; // forces /api/days refetch (Claude may have logged meals meanwhile)
    refresh();
    weightReminder();
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
  weightReminder();
})();
