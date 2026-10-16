/* MealLog PWA: vanilla JS, talks to /api/* on the same origin. */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const fmt = (n, d = 0) => (n == null ? '–' : Number(n).toFixed(d).replace(/\.0$/, ''));
  const MACRO_LABELS = { kcal: 'Калории', protein: 'Белки', fat: 'Жиры', carbs: 'Углеводы' };
  const SLOT_ORDER = ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner'];

  const state = {
    tab: 'journal',
    day: 0,            // offset from today for journal/plan
    today: null,       // server's today, set from /api/recs
    products: [],
    frequent: [],
    period: 30,
    weightAsked: false,
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

  function dayISO(offset = state.day) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function dayLabel(offset) {
    if (offset === 0) return 'сегодня';
    if (offset === -1) return 'вчера';
    if (offset === 1) return 'завтра';
    const d = new Date(); d.setDate(d.getDate() + offset);
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' });
  }

  function timeOf(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function flags(p) {
    return (p.lactose ? ' 🥛' : '') + (p.sugar ? ' 🍬' : '') + (p.urgent ? ' ⏰' : '');
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
    $('#title').textContent = TITLES[tab];
    $('#date-nav').hidden = !(tab === 'journal' || tab === 'recs');
    try { localStorage.setItem('tab', tab); } catch (_) { /* private mode */ }
    refresh();
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $$('#date-nav button').forEach((b) => b.addEventListener('click', () => {
    state.day += Number(b.dataset.day);
    if (state.day > 1) state.day = 1;
    refresh();
  }));

  function refresh() {
    $('#date-label').textContent = dayLabel(state.day);
    const r = { journal: loadJournal, recs: loadRecs, products: loadProducts, analytics: loadAnalytics, goals: loadGoals }[state.tab];
    r && r().catch((e) => toast(e.message));
  }

  // ---------- journal ----------
  async function loadJournal() {
    const d = await api(`/api/day?date=${dayISO()}`);
    renderBars(d);
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
          <div class="macros"><b>${fmt(m.kcal)}</b> ккал<br>Б ${fmt(m.protein)} · Ж ${fmt(m.fat)} · У ${fmt(m.carbs)}</div>
        </div>`;
      li.querySelector('[data-del]').addEventListener('click', async () => {
        await api(`/api/meals/${m.id}`, { method: 'DELETE' });
        toast('Удалено'); loadJournal();
      });
      swipeable(li);
      list.appendChild(li);
    }
  }

  function renderBars(d) {
    const bars = $('#bars');
    bars.innerHTML = '';
    for (const m of ['kcal', 'protein', 'fat', 'carbs']) {
      const goal = d.goals[m] || 1;
      const pct = Math.min(100, (100 * d.totals[m]) / goal);
      const over = d.totals[m] > goal;
      const unit = m === 'kcal' ? '' : ' г';
      bars.insertAdjacentHTML('beforeend', `
        <div class="bar ${m}">
          <div class="lbl"><span>${MACRO_LABELS[m]}</span><span><b>${fmt(d.totals[m])}</b> / ${fmt(goal)}${unit}</span></div>
          <div class="track"><div class="fill ${over ? 'over' : ''}" style="width:${pct}%"></div>
            ${d.pace != null ? `<div class="pace-mark" style="left:${d.pace * 100}%"></div>` : ''}</div>
        </div>`);
    }
    const p = $('#pace');
    if (d.pace != null) {
      const shouldKcal = d.goals.kcal * d.pace;
      const diff = d.totals.kcal - shouldKcal;
      p.textContent = `Темп: к этому часу обычно ${fmt(shouldKcal)} ккал, ${diff >= 0 ? 'опережение' : 'отставание'} ${fmt(Math.abs(diff))} ккал. Осталось ${fmt(d.left.kcal)} ккал, ${fmt(d.left.protein)} г белка.`;
    } else {
      p.textContent = `Итого за день: ${fmt(d.totals.kcal)} ккал из ${fmt(d.goals.kcal)}.`;
    }
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
      if (state.day !== 0) body.when = `${dayISO()}T12:00:00`;
      await api('/api/meals', { method: 'POST', body });
      closeModal(); toast('Записано'); loadJournal();
    });
  }));

  // ---------- recommendations ----------
  async function loadRecs() {
    const d = await api(`/api/recs?date=${dayISO()}`);
    state.today = d.today;
    const box = $('#recs');
    box.innerHTML = '';
    $('#recs-empty').hidden = d.plan.length > 0;
    const locked = dayISO() < d.today && new Date().getHours() >= 7;
    $('#regen').disabled = dayISO() < d.today;
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
          <div class="macros"><b>${fmt(r.kcal)}</b> ккал<br>Б ${fmt(r.protein)} · Ж ${fmt(r.fat)} · У ${fmt(r.carbs)}</div>`;
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
    <h3>Перегенерировать план</h3>
    <form class="form" id="regen-form">
      <label>Пожелание (необязательно) <input name="wish" placeholder="например: без молочного, лёгкий ужин"></label>
      <button class="btn" type="submit">Собрать план</button>
    </form>`, (el) => {
    el.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      btn.disabled = true; btn.textContent = 'Думаю…';
      try {
        const r = await api('/api/recs/regenerate', { method: 'POST', body: { date: dayISO(), wish: e.target.wish.value } });
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
      box.insertAdjacentHTML('beforeend', '<div class="cat">В холодильнике</div>');
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
        <button class="alt" data-act="log">Съел</button>
        <button class="warn" data-act="urgent">${p.urgent ? 'Не срочно' : 'Срочно'}</button>
        <button data-act="del">Удалить</button>
      </div>
      <div class="row">
        <div><div class="name">${esc(p.name)}<span class="flags">${flags(p)}</span></div>
          <div class="sub">${fmt(p.kcal)} ккал · Б ${fmt(p.protein)} · Ж ${fmt(p.fat)} · У ${fmt(p.carbs)} на ${per}</div></div>
        <div class="qty"><button data-d="-${step}">−</button><span>${fmt(p.fridge_qty)} ${unit}</span><button data-d="${step}">+</button></div>
      </div>`;
    $$('.qty button', el).forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const r = await api(`/api/products/${p.id}/fridge`, { method: 'POST', body: { delta: Number(b.dataset.d) } });
      p.fridge_qty = r.product.fridge_qty;
      el.querySelector('.qty span').textContent = `${fmt(p.fridge_qty)} ${unit}`;
    }));
    el.querySelector('[data-act=log]').addEventListener('click', () => quickLog(p));
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

  function quickLog(p) {
    if (!p) return;
    const isPortion = p.basis === 'portion';
    openModal(`
      <h3>${esc(p.name)}</h3>
      <form class="form" id="log-form">
        <label>${isPortion ? 'Порций' : 'Граммов'} <input name="qty" type="number" inputmode="decimal" step="any" value="${isPortion ? 1 : (p.grams || 100)}" required></label>
        <button class="btn" type="submit">Записать</button>
      </form>`, (el) => {
      el.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const qty = Number(e.target.qty.value);
        const body = { product_id: p.id, [isPortion ? 'portions' : 'grams']: qty };
        const r = await api('/api/meals', { method: 'POST', body });
        closeModal(); toast(`Записано: ${fmt(r.meal.kcal)} ккал`);
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
        <div class="row2"><label><input type="checkbox" name="lactose" ${p.lactose ? 'checked' : ''}> 🥛 лактоза</label>
          <label><input type="checkbox" name="sugar" ${p.sugar ? 'checked' : ''}> 🍬 сахар</label></div>
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
    state.period = Number(b.dataset.days);
    $$('#period button').forEach((x) => x.classList.toggle('on', x === b));
    loadAnalytics();
  }));

  async function loadAnalytics() {
    const a = await api(`/api/analytics?days=${state.period}`);
    const w = a.weight;
    const wDelta = w.length > 1 ? (w[w.length - 1].kg - w[0].kg) : null;
    $('#stats').innerHTML = `
      <div class="stat"><b>${a.streak}</b><span>дней подряд</span></div>
      <div class="stat"><b>${fmt(a.avg.kcal)}</b><span>ккал в день</span></div>
      <div class="stat"><b>${fmt(a.avg.protein)}</b><span>г белка в день</span></div>
      <div class="stat"><b>${w.length ? fmt(w[w.length - 1].kg, 1) : '–'}</b><span>вес, кг</span></div>
      <div class="stat"><b>${wDelta == null ? '–' : (wDelta > 0 ? '+' : '') + fmt(wDelta, 1)}</b><span>кг за период</span></div>
      <div class="stat"><b>${a.series.filter((s) => s.n).length}</b><span>дней с записями</span></div>`;
    const css = getComputedStyle(document.documentElement);
    const col = (v) => css.getPropertyValue(v).trim();
    barChart($('#ch-kcal'), a.series.map((s) => s.kcal), a.goals.kcal, col('--kcal'), col('--muted'), col('--line'));
    stackedChart($('#ch-macros'), a.series, ['protein', 'fat', 'carbs'], [col('--protein'), col('--fat'), col('--carbs')], col('--line'));
    lineChart($('#ch-weight'), w.map((x) => x.kg), col('--accent'), col('--muted'), col('--line'));
    barChart($('#ch-hours'), a.hours, null, col('--fat'), col('--muted'), col('--line'), (i) => (i % 6 === 0 ? `${i}:00` : ''));
    $('#top').innerHTML = a.top.map((t) => `<li>${esc(t.name)} <span>× ${t.n}, ${fmt(t.kcal)} ккал</span></li>`).join('') || '<li class="muted">пока пусто</li>';
  }

  function setupCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.getAttribute('height') | 0;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px -apple-system, sans-serif';
    return { ctx, w, h };
  }

  function barChart(c, values, goal, color, textColor, lineColor, label) {
    const { ctx, w, h } = setupCanvas(c);
    const pad = { l: 34, r: 8, t: 10, b: 18 };
    const max = Math.max(goal || 0, ...values, 1) * 1.05;
    const n = values.length;
    const bw = (w - pad.l - pad.r) / n;
    ctx.fillStyle = textColor;
    ctx.fillText(fmt(max / 1.05), 2, pad.t + 8);
    ctx.fillText('0', 2, h - pad.b);
    values.forEach((v, i) => {
      const bh = ((h - pad.t - pad.b) * v) / max;
      ctx.fillStyle = color;
      ctx.fillRect(pad.l + i * bw + 1, h - pad.b - bh, Math.max(1, bw - 2), bh);
      if (label) { const t = label(i); if (t) { ctx.fillStyle = textColor; ctx.fillText(t, pad.l + i * bw, h - 4); } }
    });
    if (goal) {
      const y = h - pad.b - ((h - pad.t - pad.b) * goal) / max;
      ctx.strokeStyle = textColor; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.strokeStyle = lineColor; ctx.beginPath(); ctx.moveTo(pad.l, h - pad.b); ctx.lineTo(w - pad.r, h - pad.b); ctx.stroke();
  }

  function stackedChart(c, series, keys, colors, lineColor) {
    const { ctx, w, h } = setupCanvas(c);
    const pad = { l: 8, r: 8, t: 10, b: 8 };
    const totals = series.map((s) => keys.reduce((a, k) => a + s[k], 0));
    const max = Math.max(...totals, 1) * 1.05;
    const bw = (w - pad.l - pad.r) / series.length;
    series.forEach((s, i) => {
      let y = h - pad.b;
      keys.forEach((k, j) => {
        const bh = ((h - pad.t - pad.b) * s[k]) / max;
        ctx.fillStyle = colors[j];
        ctx.fillRect(pad.l + i * bw + 1, y - bh, Math.max(1, bw - 2), bh);
        y -= bh;
      });
    });
    ctx.strokeStyle = lineColor; ctx.beginPath(); ctx.moveTo(pad.l, h - pad.b); ctx.lineTo(w - pad.r, h - pad.b); ctx.stroke();
  }

  function lineChart(c, values, color, textColor, lineColor) {
    const { ctx, w, h } = setupCanvas(c);
    const pad = { l: 36, r: 10, t: 12, b: 10 };
    if (values.length < 2) { ctx.fillStyle = textColor; ctx.fillText('Мало данных', pad.l, h / 2); return; }
    const min = Math.min(...values) - 0.5, max = Math.max(...values) + 0.5;
    const x = (i) => pad.l + ((w - pad.l - pad.r) * i) / (values.length - 1);
    const y = (v) => h - pad.b - ((h - pad.t - pad.b) * (v - min)) / (max - min);
    ctx.fillStyle = textColor;
    ctx.fillText(fmt(max, 1), 2, pad.t + 4); ctx.fillText(fmt(min, 1), 2, h - pad.b);
    ctx.strokeStyle = lineColor; ctx.beginPath(); ctx.moveTo(pad.l, h - pad.b); ctx.lineTo(w - pad.r, h - pad.b); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = color;
    values.forEach((v, i) => { ctx.beginPath(); ctx.arc(x(i), y(v), 2.5, 0, Math.PI * 2); ctx.fill(); });
  }

  // ---------- goals / weight ----------
  async function loadGoals() {
    const g = await api('/api/goals');
    const f = $('#goals-form');
    for (const k of ['kcal', 'protein', 'fat', 'carbs']) f[k].value = g.goals[k];
    const last = g.weight[g.weight.length - 1];
    $('#weight-last').textContent = last ? `Последняя запись: ${fmt(last.kg, 1)} кг (${last.date})` : 'Веса ещё нет';
    if (g.weight_today) $('#weight-form').kg.value = g.weight_today.kg;
  }
  $('#goals-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/goals', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
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
    const todayNow = dayISO(0);
    if (state.today && state.today !== todayNow) state.day = 0; // new day since last open
    state.weightAsked = false;
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

  let initial = 'journal';
  try { initial = localStorage.getItem('tab') || 'journal'; } catch (_) { /* ignore */ }
  showTab(initial);
  weightReminder();
})();
