'use strict';
// Книги: прочитанное со статистикой и планы. Оболочка публичная, данные — в закрытом репозитории
// mary-jetmetrics/books-data (books.json), доступ по ключу (fine-grained token), который вводится один раз на устройстве.
const OWNER = 'mary-jetmetrics', REPO = 'books-data', BRANCH = 'main', FILE = 'books.json';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* без хранилища — войдёт заново */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* нечего удалять */ } },
};
const PREVIEW = window.BOOKS_PREVIEW || null;   // превью в артефакте: данные вшиты, ничего не сохраняется
// свой ключ или ключ «Поездок» (тот же сайт mary-jetmetrics.github.io, общее хранилище): если ему дан доступ к books-data, вводить ничего не надо
let TOKEN = LS.get('bk-token') || LS.get('trips-token');
let D = null, SHA = null;                       // books.json и sha его версии
let saving = false, dirty = false, saveTimer = null, net = 'ok';
// form: открытая форма — { mode: 'edit' | 'finish' | 'add-read' | 'add-plan' | 'pact', id }; confirm — id книги, которую спросили «Точно удалить?»
const UI = { tab: LS.get('bk-tab') === 'plan' ? 'plan' : 'read', year: null, sort: 'month', form: null, confirm: null, bbc: false, q: '', hse: false, hq: '', aq: '' };
const root = document.getElementById('root');

/* ---------- общее ---------- */
const MON = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MON_S = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const FMTS = [['audio', 'аудио'], ['paper', 'бумага'], ['ebook', 'электронная']];
const FMT = Object.fromEntries(FMTS);
const LANGS = [['ru', 'русский'], ['en', 'английский']];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return (m > 10 && m < 20) ? c : k === 1 ? a : (k >= 2 && k <= 4) ? b : c; };
const books = n => `${n} ${plural(n, 'книга', 'книги', 'книг')}`;
const dec = (v, d = 1) => v.toFixed(d).replace('.', ',');
const pad = n => String(n).padStart(2, '0');
const NOW = new Date(), THIS_YEAR = String(NOW.getFullYear()), THIS_MONTH = `${THIS_YEAR}-${pad(NOW.getMonth() + 1)}`;
// month — «ГГГГ-ММ», а у старых книг без записанного месяца — только «ГГГГ» (рукописные списки 2018, часть Notion)
const yearOnly = ym => !!ym && ym.length === 4;
// без месяца: в году — прочерк (Мария, 12.10.26), за всё время — год
const monLabel = ym => !ym ? '' : yearOnly(ym) ? (UI.year === 'all' ? ym : '—') : `${MON[+ym.slice(5, 7) - 1]}${ym.slice(0, 4) !== THIS_YEAR ? ' ' + ym.slice(0, 4) : ''}`;
const b64enc = str => { const bytes = new TextEncoder().encode(str); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };
const b64dec = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));
const WAVE = '<svg class="ls-wave" viewBox="0 0 190 8" aria-hidden="true"><path d="M1 4 Q 6 0 11 4 T 21 4 T 31 4 T 41 4 T 51 4 T 61 4 T 71 4 T 81 4 T 91 4 T 101 4 T 111 4 T 121 4 T 131 4 T 141 4 T 151 4 T 161 4 T 171 4 T 181 4"/></svg>';
const head = sub => `<header class="head"><h1 class="ls-title">Книги</h1>${WAVE}${sub ? `<p class="cap">${sub}</p>` : ''}</header>`;
const newId = () => 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

/* ---------- GitHub ---------- */
async function gh(path, opts = {}) {
  const headers = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(API + path, { cache: 'no-store', ...opts, headers });
  if (!r.ok) { const e = new Error(`GitHub ${r.status}`); e.status = r.status; throw e; }
  return r;
}
async function getFile(file) { const j = await (await gh(`/contents/${file}?ref=${BRANCH}`)).json(); return { sha: j.sha, data: JSON.parse(b64dec(j.content)) }; }
async function putFile(file, data, sha, message) {
  const body = { message, content: b64enc(JSON.stringify(data, null, 1) + '\n'), branch: BRANCH };
  if (sha) body.sha = sha;
  return (await (await gh(`/contents/${file}`, { method: 'PUT', body: JSON.stringify(body) })).json()).content.sha;
}

/* ---------- данные: слияние с ноутбука и телефона, сохранение ---------- */
// у каждой книги время правки: из двух версий побеждает более поздняя, удалённые остаются с пометкой del
function merge(a, b) {
  const m = new Map(a.books.map(x => [x.id, x]));
  for (const x of b.books) { const y = m.get(x.id); if (!y || (x.at || 0) > (y.at || 0)) m.set(x.id, x); }
  return { ...a, books: [...m.values()] };
}
function queueSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300); }
async function save() {
  if (PREVIEW) return setNet('preview');
  if (saving) { dirty = true; return; }
  saving = true; dirty = false; setNet('saving');
  try {
    for (let i = 0; ; i++) {
      try { SHA = await putFile(FILE, D, SHA, 'книги из приложения'); break; }
      catch (e) {
        if (![409, 422].includes(e.status) || i >= 4) throw e;
        const r = await getFile(FILE); D = merge(D, r.data); SHA = r.sha;
      }
    }
    setNet('ok');
  } catch (e) { setNet('err'); dirty = true; }
  saving = false;
  if (dirty) setTimeout(save, net === 'err' ? 5000 : 0);
}
async function refresh() {
  if (PREVIEW || !TOKEN || !D || document.hidden || saving) return;
  try {
    const r = await getFile(FILE);
    if (saving || r.sha === SHA) return;
    D = merge(D, r.data); SHA = r.sha;
    if (!UI.form) render();
  } catch (e) { /* в другой раз */ }
}
const NET = { ok: 'сохранено', saving: 'сохраняю…', err: 'нет связи, повторю', preview: 'превью: изменения не сохраняются' };
function setNet(v) { net = v; const el = document.getElementById('net'); if (el) el.textContent = NET[v]; }

const live = () => D.books.filter(b => !b.del);
const byStatus = s => live().filter(b => b.status === s);
const find = id => D.books.find(b => b.id === id);
function upsert(b) {
  b.at = Date.now();
  const i = D.books.findIndex(x => x.id === b.id);
  if (i < 0) D.books.push(b); else D.books[i] = b;
  queueSave();
}

/* ---------- экраны ---------- */
function render() {
  if (!D) return;
  const r = byStatus('read').length, now = byStatus('reading').length, p = byStatus('plan').length;
  root.innerHTML = head(`Прочитано ${r} · читаю ${now} · в планах ${p}`) +
    `<nav class="tabs" role="tablist">${[['read', 'Прочитано'], ['plan', 'Планы']].map(([k, n]) =>
      `<button role="tab" data-act="tab" data-v="${k}" aria-selected="${UI.tab === k}">${n}</button>`).join('')}</nav>` +
    (UI.tab === 'read' ? readView() : planView()) +
    `<p class="cap foot"><span id="net">${NET[net]}</span>${PREVIEW ? '' : ' · <button class="link" data-act="logout">Выйти</button>'}</p>`;
}

function readView() {
  const read = byStatus('read');
  const years = [...new Set(read.map(b => (b.month || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  if (UI.year === null || (UI.year !== 'all' && !years.includes(UI.year))) UI.year = years[0] || 'all';
  const list = read.filter(b => UI.year === 'all' || (b.month || '').startsWith(UI.year));
  const yearBtns = years.length ? `<div class="filters">${[...years, 'all'].map(y =>
    `<button data-act="year" data-v="${y}" aria-pressed="${UI.year === y}">${y === 'all' ? 'Всё время' : y}</button>`).join('')}</div>` : '';
  return nowBlock() + yearBtns + statsBlock(list) + chartBlock(list) + topBlock(list) + allBlock(list);
}

function nowBlock() {
  const now = byStatus('reading');
  if (!now.length) return '';
  return `<section class="ls-block"><h2 class="ls-h">Сейчас читаю</h2>${now.map(b => `
    <div class="now"><div class="t"><span>${esc(b.title)}</span><span class="cap">${esc(b.author)}${b.author ? ' · ' : ''}${FMT[b.format] || ''}</span></div>
      <div class="acts" style="margin:0"><button class="btn main small" data-act="finish" data-id="${b.id}">Дочитала</button><button class="btn small" data-act="edit" data-id="${b.id}">Править</button></div></div>
    ${UI.form && UI.form.id === b.id && ['finish', 'edit'].includes(UI.form.mode) ? bookForm(UI.form.mode, b) : ''}`).join('')}</section>`;
}

// сколько месяцев в периоде: за текущий год — прошедшие месяцы, за прошлый — 12, за всё время — от первой книги до сегодня
function monthsIn(list) {
  if (UI.year === THIS_YEAR) return NOW.getMonth() + 1;
  if (UI.year !== 'all') return 12;
  const first = list.map(b => b.month).filter(Boolean).sort()[0];
  if (!first) return 1;
  return (NOW.getFullYear() - +first.slice(0, 4)) * 12 + NOW.getMonth() - (yearOnly(first) ? 0 : +first.slice(5, 7) - 1) + 1;
}
function statsBlock(list) {
  const n = list.length;
  if (!n) return `<section class="ls-block"><p class="empty">${UI.year === 'all' ? 'Прочитанных книг пока нет.' : `В ${UI.year} году книг пока нет.`}</p></section>`;
  const rated = list.filter(b => b.rating), avg = rated.length ? rated.reduce((s, b) => s + b.rating, 0) / rated.length : null;
  const best = rated.slice().sort((a, b) => b.rating - a.rating || (b.month || '').localeCompare(a.month || ''))[0];
  const audio = list.filter(b => (b.format || 'audio') === 'audio').length;
  return `<div class="stats">
    <div class="ls-block ls-stat"><span class="cap">${UI.year === 'all' ? 'Прочитано за всё время' : `Прочитано за ${UI.year}`}</span><b>${books(n)}</b>
      <span class="cap sub">в среднем ${dec(n / monthsIn(list))} в месяц</span></div>
    <div class="ls-block ls-stat"><span class="cap">Средняя оценка</span><b>${avg ? `${dec(avg)}<small class="cap"> из 10</small>` : '—'}</b>
      <span class="cap sub">${best ? `лучшая — «${esc(best.title)}», ${best.rating}` : ''}</span></div>
    <div class="ls-block ls-stat"><span class="cap">Аудиокниги</span><b>${Math.round(audio / n * 100)}%</b>
      <span class="cap sub">${audio} из ${n}</span></div>
  </div>`;
}

// столбики по месяцам (за всё время — по годам), внутри — доли форматов
function chartBlock(list) {
  if (!list.length) return '';
  const all = UI.year === 'all';
  // за год книги без месяца в столбики не попадают; год совсем без месяцев (2018) — без графика
  if (!all && list.every(b => yearOnly(b.month))) return '';
  const cols = all
    ? (() => { const ys = list.map(b => +b.month.slice(0, 4)), lo = Math.min(...ys), hi = Math.max(...ys);   // все годы подряд: пустой год (2023) — видимый пропуск
        return Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i)).map(y => ({ key: y, label: all && hi - lo > 6 ? `’${y.slice(2)}` : y })); })()
    : MON_S.map((l, i) => ({ key: `${UI.year}-${pad(i + 1)}`, label: l }));
  const val = (c, f) => list.filter(b => (all ? b.month.slice(0, 4) : b.month) === c.key && (b.format || 'audio') === f).length;
  const totals = cols.map(c => FMTS.reduce((s, [f]) => s + val(c, f), 0));
  const top = Math.max(3, ...totals), step = top <= 6 ? 1 : top <= 12 ? 2 : 5, ceil = Math.ceil(top / step) * step;
  // ширина рисунка = ширина блока, чтобы подписи на телефоне не мельчали
  const W = Math.round(Math.max(300, Math.min(700, root.clientWidth - 34))), H = 190, pl = 22, pr = 4, pt = 8, pb = 24, ph = H - pt - pb, gw = (W - pl - pr) / cols.length, bw = Math.min(28, gw * 0.56);
  const y = v => pt + ph - v / ceil * ph;
  let g = '';
  for (let v = 0; v <= ceil; v += step) g += `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  cols.forEach((c, i) => {
    const x = pl + gw * i + (gw - bw) / 2; let acc = 0;
    for (const [f] of FMTS) {
      const v = val(c, f); if (!v) continue;
      g += `<rect x="${x + .5}" y="${y(acc + v) + .5}" width="${bw - 1}" height="${Math.max(y(acc) - y(acc + v) - 1, 1)}" rx="2" fill="var(--t-${f})" stroke="var(--bar-line)"/>`;
      acc += v;
    }
    g += `<text x="${pl + gw * i + gw / 2}" y="${H - 6}" text-anchor="middle">${c.label}</text>`;
  });
  g += `<line class="axis" x1="${pl}" x2="${W - pr}" y1="${y(0)}" y2="${y(0)}"/>`;
  const used = FMTS.filter(([f]) => list.some(b => (b.format || 'audio') === f));
  return `<section class="ls-block"><div class="sec-top"><h2 class="ls-h">${all ? 'По годам' : 'По месяцам'}</h2>
    <div class="legend">${used.map(([f, l]) => `<span><i class="sq" style="--g:var(--t-${f})"></i>${l}</span>`).join('')}</div></div>
    <div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Книги ${all ? 'по годам' : 'по месяцам'}">${g}</svg></div></section>`;
}

function topBlock(list) {
  const top = list.filter(b => b.rating).sort((a, b) => b.rating - a.rating || (b.month || '').localeCompare(a.month || '')).slice(0, 5);
  if (top.length < 3) return '';
  return `<section class="ls-block"><h2 class="ls-h">Лучшие</h2><div class="top">${top.map(b =>
    `<div>${rateTag(b.rating)}<span>${esc(b.title)} <span class="cap">${esc(b.author)}</span></span></div>`).join('')}</div></section>`;
}

const SORTS = [['month', 'по дате'], ['rating', 'по оценке'], ['title', 'по названию']];
// оценка цветом — та же шкала из 10, что у мест и еды в «Поездках» (Мария, 12.10.26): от 8 — зелёный, 4–7 — жёлтый, ниже 4 — красный
const rateTone = r => r >= 8 ? 'good' : r >= 4 ? 'mid' : 'bad';
const rateTag = r => r ? `<span class="rate r-${rateTone(r)}" title="${r} из 10">${r}</span>` : '<span class="rate none">—</span>';
const LANG_S = { ru: 'рус', en: 'англ' };
const FMT_S = { audio: 'аудио', paper: 'бумага', ebook: 'электр.' };   // в столбце «Всех книг» — коротко, чтобы плашки были узкими
// ширина столбца месяца — по самой длинной подписи в списке: тогда шаг между столбцами везде одинаковый и оценка не отрывается
let measureCtx = null;
function monWidth(list) {
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  measureCtx.font = '12.5px "Golos Text", system-ui, sans-serif';
  return Math.ceil(Math.max(40, ...list.map(b => measureCtx.measureText(monLabel(b.month)).width)) + 4);
}
let LAST = [];   // книги, по которым сейчас ищет поиск «Всех книг»
function allBlock(list) {
  LAST = list;
  return `<section class="ls-block"><div class="sec-top"><h2 class="ls-h">Все книги</h2>
      <button class="btn small" data-act="add-read">+ Прочитанная книга</button></div>
    <input class="search" id="all-q" type="search" placeholder="Найти книгу или автора" value="${esc(UI.aq)}" autocomplete="off">
    <div class="sort">${SORTS.map(([k, l]) => `<button data-act="sort" data-v="${k}" aria-pressed="${UI.sort === k}">${l}</button>`).join('')}</div>
    <div class="list" id="all-list" style="--mon-w:${monWidth(list)}px">${allRows(list)}</div></section>`;
}
// строка книги: название и автор, дальше столбцы одной ширины — формат, язык, месяц, оценка (Мария, 12.10.26: «чтобы не прыгали»)
function allRows(list) {
  const q = norm(UI.aq);
  const s = list.filter(b => !q || norm(b.title + ' ' + b.author).includes(q)).slice().sort(UI.sort === 'rating' ? (a, b) => (b.rating || 0) - (a.rating || 0) || (b.month || '').localeCompare(a.month || '')
    : UI.sort === 'title' ? (a, b) => a.title.localeCompare(b.title, 'ru')
    : (a, b) => (b.month || '').localeCompare(a.month || '') || (b.at || 0) - (a.at || 0));
  const adding = UI.form && UI.form.mode === 'add-read';
  return (adding ? bookForm('add-read', {}) : '') + (s.map(b => {
      const open = UI.form && UI.form.mode === 'edit' && UI.form.id === b.id;
      return `<button class="row bk" data-act="open" data-id="${b.id}" aria-expanded="${open}">
        <span class="t"><span class="name">${esc(b.title)}</span><span class="cap">${esc(b.author)}</span></span>
        <span class="tag t-${b.format || 'audio'}" title="${FMT[b.format] || 'аудио'}">${FMT_S[b.format] || 'аудио'}</span><span class="tag white">${LANG_S[b.lang] || 'рус'}</span>
        <span class="mon">${monLabel(b.month)}</span>${rateTag(b.rating)}</button>
        ${open ? bookForm('edit', b) : ''}`;
    }).join('') || `<p class="empty">${q ? 'Ничего не нашлось.' : 'Пока пусто.'}</p>`);
}

/* ---------- планы ---------- */
const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"'.,:;!?()\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
// книга из справочника уже есть у Марии: одно название содержит другое (не короче 5 букв)
// с автором (ВШЭ): ещё и общая фамилия — там много «Рассказов», «Лирики» и коротких названий («Мы», «Нос»), их сверяем целиком
const surnames = a => norm(a).split(' ').filter(w => w.length > 2);
function mine(title, author) {
  const t = norm(title), as = author ? surnames(author) : null;
  return live().find(b => {
    const m = norm(b.title);
    if (!as) return m.length >= 5 && t.length >= 5 && (t.includes(m) || m.includes(t));
    if (!(m === t || (m.length >= 5 && t.length >= 5 && (t.includes(m) || m.includes(t))))) return false;
    return !b.author || surnames(b.author).some(w => as.includes(w));
  });
}
const STATE = { read: 'прочитано', reading: 'читаю', plan: 'в планах' };

function planView() {
  const plans = byStatus('plan').sort((a, b) => (a.at || 0) - (b.at || 0));
  const adding = UI.form && UI.form.mode === 'add-plan';
  return `<section class="ls-block"><div class="sec-top"><h2 class="ls-h">Хочу прочитать</h2>
      <button class="btn small" data-act="add-plan">+ В планы</button></div>
    <div class="list">${adding ? bookForm('add-plan', {}) : ''}${plans.map(b => {
      const f = UI.form && UI.form.id === b.id ? UI.form.mode : null;
      return `<button class="row" data-act="popen" data-id="${b.id}" aria-expanded="${!!f}">
        <span class="t"><span class="name">${esc(b.title)}</span>${b.author ? `<span class="cap">${esc(b.author)}</span>` : ''}</span>
        <span class="meta">${b.src === 'bbc' ? '<span class="tag white">BBC</span>' : b.src === 'hse' ? '<span class="tag white">ВШЭ</span>' : ''}</span></button>
        ${f === 'pact' ? `<div class="pacts"><button class="btn small main" data-act="start" data-id="${b.id}">Начинаю читать</button>
          <button class="btn small" data-act="finish" data-id="${b.id}">Уже прочитала</button>
          <button class="btn small" data-act="edit" data-id="${b.id}">Править</button>
          <button class="link del" data-act="del" data-id="${b.id}">${UI.confirm === b.id ? 'Точно убрать?' : 'Убрать'}</button></div>` : ''}
        ${f === 'finish' || f === 'edit' ? bookForm(f, b) : ''}`;
    }).join('') || '<p class="empty">Планов пока нет. Добавь книгу или возьми из списков ниже.</p>'}</div></section>
    <section class="ls-block"><button class="sec-head" data-act="bbc" aria-expanded="${UI.bbc}">
        <h2 class="ls-h">Топ-200 BBC</h2><span class="cap">справочник · ${BBC.length}</span><span class="chev">${UI.bbc ? '−' : '+'}</span></button>
      ${UI.bbc ? `<input class="search" id="bbc-q" type="search" placeholder="Найти в списке" value="${esc(UI.q)}" autocomplete="off">
        <div class="list" id="bbc-list">${bbcRows()}</div>` : ''}</section>
    <section class="ls-block"><button class="sec-head" data-act="hse" aria-expanded="${UI.hse}">
        <h2 class="ls-h">Лицей ВШЭ: на лето</h2><span class="cap">справочник · ${HSE_N}</span><span class="chev">${UI.hse ? '−' : '+'}</span></button>
      ${UI.hse ? `<p class="cap">Список литературы на лето для 8–11 классов, <a href="https://school.hse.ru/literature" target="_blank" rel="noopener">school.hse.ru/literature</a></p>
        <input class="search" id="hse-q" type="search" placeholder="Найти в списке" value="${esc(UI.hq)}" autocomplete="off">
        <div class="list" id="hse-list">${hseRows()}</div>` : ''}</section>`;
}
// справочник ВШЭ (hse.js): классы → подразделы → книги [название, автор, заметка]; строки по порядку сайта
const HSE_ROWS = (typeof HSE === 'undefined' ? [] : HSE).flatMap(g => g.parts.flatMap(p => p.books.map(([t, a, n]) => ({ t, a, n: n || '', g: g.grade, p: p.title }))));
const HSE_N = new Set(HSE_ROWS.map(x => x.t + '|' + x.a)).size;
function hseRows() {
  const q = norm(UI.hq);
  let g0 = null, p0 = null, out = '';
  HSE_ROWS.forEach((x, i) => {
    if (q && !norm(x.t + ' ' + x.a).includes(q)) return;
    if (x.g !== g0) { g0 = x.g; p0 = null; out += `<h3 class="grade">${esc(x.g)}</h3>`; }
    if (x.p !== p0) { p0 = x.p; out += `<p class="cap part">${esc(x.p)}</p>`; }
    const m = mine(x.t, x.a);
    out += `<div class="row static"><span class="t"><span class="name">${esc(x.t)}</span><span class="cap">${esc(x.a)}${x.n ? ' · ' + esc(x.n) : ''}</span></span>
      <span class="meta">${m ? `<span class="tag${m.status === 'read' ? '' : ' white'}">${STATE[m.status]}</span>` : `<button class="btn small" data-act="hse-add" data-i="${i}">+ в планы</button>`}</span></div>`;
  });
  return out || '<p class="empty">Ничего не нашлось.</p>';
}
function bbcRows() {
  const q = norm(UI.q);
  const rows = BBC.map((x, i) => [x, i]).filter(([[t, a]]) => !q || norm(t + ' ' + a).includes(q));
  return rows.map(([[t, a], i]) => {
    const m = mine(t);
    return `<div class="row static"><span class="t"><span class="name">${esc(t)}</span><span class="cap">${esc(a)}</span></span>
      <span class="meta">${m ? `<span class="tag${m.status === 'read' ? '' : ' white'}">${STATE[m.status]}</span>` : `<button class="btn small" data-act="bbc-add" data-i="${i}">+ в планы</button>`}</span></div>`;
  }).join('') || '<p class="empty">Ничего не нашлось.</p>';
}

/* ---------- форма книги ---------- */
const opts = (name, list, cur, req) => `<div class="opts">${list.map(([v, l]) =>
  `<label class="opt"><input type="radio" name="${name}" value="${v}"${String(cur) === String(v) ? ' checked' : ''}${req ? ' required' : ''}><span>${l}</span></label>`).join('')}</div>`;
function bookForm(mode, b) {
  const status = mode === 'add-read' || mode === 'finish' ? 'read' : mode === 'add-plan' ? 'plan' : b.status;
  const names = mode !== 'finish';
  const fmt = status !== 'plan';
  const read = status === 'read';
  return `<form class="bform" data-form="${mode}" data-id="${b.id || ''}">
    ${mode === 'finish' ? `<p class="cap">«${esc(b.title)}» — когда дочитала и как оценишь</p>` : ''}
    ${names ? `<label class="f cap">Название<input type="text" name="title" required value="${esc(b.title || '')}" autocomplete="off"></label>
      <label class="f cap">Автор<input type="text" name="author" value="${esc(b.author || '')}" autocomplete="off"></label>` : ''}
    ${fmt ? `<span class="cap">Формат</span>${opts('format', FMTS, b.format || 'audio')}<span class="cap">Язык</span>${opts('lang', LANGS, b.lang || 'ru')}` : ''}
    ${read ? `<label class="f cap">Когда дочитала${yearOnly(b.month) ? ` (записан только год, ${b.month} — можно оставить пустым)` : ''}<input type="month" name="month" ${yearOnly(b.month) ? '' : 'required'} value="${yearOnly(b.month) ? '' : b.month || THIS_MONTH}" max="${THIS_MONTH}"></label>
      <span class="cap">Оценка из 10</span>${opts('rating', Array.from({ length: 10 }, (_, i) => [i + 1, i + 1]), b.rating || '', true)}` : ''}
    <div class="acts"><button class="btn main" type="submit">${mode === 'finish' ? 'Дочитала' : 'Сохранить'}</button>
      <button class="btn" type="button" data-act="cancel">Отмена</button>
      ${mode === 'edit' ? `<button class="link del" type="button" data-act="del" data-id="${b.id}">${UI.confirm === b.id ? 'Точно удалить?' : 'Удалить'}</button>` : ''}</div>
  </form>`;
}
function saveForm(f) {
  const fd = new FormData(f), mode = f.dataset.form, val = k => (fd.get(k) ?? '').toString().trim();
  const b = mode.startsWith('add') ? { id: newId(), status: mode === 'add-read' ? 'read' : 'plan' } : { ...find(f.dataset.id) };
  if (fd.has('title')) { b.title = val('title'); b.author = val('author'); }
  if (fd.has('format')) { b.format = val('format'); b.lang = val('lang'); }
  if (mode === 'finish') b.status = 'read';
  if (fd.has('month')) { b.month = val('month') || (yearOnly(b.month) ? b.month : ''); b.rating = +val('rating') || null; }
  if (!b.title) return;
  upsert(b);
  UI.form = null; UI.confirm = null;
  render();
}

/* ---------- действия ---------- */
const toggleForm = (mode, id) => { UI.form = UI.form && UI.form.mode === mode && UI.form.id === id ? null : { mode, id }; UI.confirm = null; };
root.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id, v = el.dataset.v;
  if (act === 'tab') { UI.tab = v; LS.set('bk-tab', v); UI.form = null; }
  else if (act === 'year') UI.year = v;
  else if (act === 'sort') UI.sort = v;
  else if (act === 'open') toggleForm('edit', id);
  else if (act === 'popen') { if (UI.form && UI.form.id === id) UI.form = null; else UI.form = { mode: 'pact', id }; UI.confirm = null; }
  else if (act === 'add-read' || act === 'add-plan') toggleForm(act, undefined);
  else if (act === 'finish' || act === 'edit') { UI.form = { mode: act, id }; UI.confirm = null; }
  else if (act === 'start') { const b = { ...find(id), status: 'reading' }; b.format = b.format || 'audio'; b.lang = b.lang || 'ru'; upsert(b); UI.form = null; }
  else if (act === 'del') {
    if (UI.confirm !== id) UI.confirm = id;
    else { upsert({ ...find(id), del: true }); UI.form = null; UI.confirm = null; }
  }
  else if (act === 'cancel') { UI.form = null; UI.confirm = null; }
  else if (act === 'bbc') UI.bbc = !UI.bbc;
  else if (act === 'hse') UI.hse = !UI.hse;
  else if (act === 'hse-add') {
    const x = HSE_ROWS[+el.dataset.i];
    upsert({ id: newId(), title: x.t, author: x.a, status: 'plan', src: 'hse' });
  }
  else if (act === 'bbc-add') {
    const [t, a] = BBC[+el.dataset.i];
    upsert({ id: newId(), title: t, author: a, status: 'plan', src: 'bbc' });
  }
  else if (act === 'logout') { LS.del('bk-token'); TOKEN = null; D = null; return loginView(); }
  else return;
  render();
});
root.addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'login') {
    TOKEN = f.querySelector('#key').value.trim();
    if (TOKEN) { LS.set('bk-token', TOKEN); boot(); }
  } else if (f.dataset.form) saveForm(f);
});
// поиск перерисовывает только свой список, чтобы поле не теряло фокус
root.addEventListener('input', e => {
  const id = e.target.id, box = id => document.getElementById(id);
  if (id === 'bbc-q') { UI.q = e.target.value; if (box('bbc-list')) box('bbc-list').innerHTML = bbcRows(); }
  else if (id === 'hse-q') { UI.hq = e.target.value; if (box('hse-list')) box('hse-list').innerHTML = hseRows(); }
  else if (id === 'all-q') { UI.aq = e.target.value; if (box('all-list')) box('all-list').innerHTML = allRows(LAST); }
});

function loginView(msg) {
  root.innerHTML = `${head('Вход один раз на устройстве')}
    ${msg ? `<p class="msg">${esc(msg)}</p>` : ''}
    <form class="ls-block login" id="login">
      <label class="cap" for="key">Ключ доступа</label>
      <input id="key" type="password" autocomplete="off" placeholder="github_pat_…" required>
      <button class="btn main" type="submit">Войти</button>
    </form>`;
}

/* ---------- запуск ---------- */
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('k')) { TOKEN = h.get('k'); LS.set('bk-token', TOKEN); history.replaceState(null, '', location.pathname); }
}
let watching = false;
async function boot() {
  if (PREVIEW) { D = JSON.parse(JSON.stringify(PREVIEW)); net = 'preview'; return render(); }
  readHash();
  if (!TOKEN) return loginView();
  root.innerHTML = head('Загружаю…');
  try {
    const r = await getFile(FILE); D = r.data; SHA = r.sha;
    render();
    if (!watching) { watching = true; document.addEventListener('visibilitychange', refresh); }
  } catch (e) {
    if ([401, 403, 404].includes(e.status)) {
      const own = TOKEN === LS.get('bk-token');   // чужой ключ «Поездок» не стираем: он нужен там
      if (own) LS.del('bk-token'); TOKEN = null;
      return loginView(own ? 'Ключ не подошёл. Проверь, что у него есть доступ к репозиторию books-data и он не просрочен.' : '');
    }
    root.innerHTML = head('Нет связи с GitHub. Обнови страницу через минуту.');
  }
}
// свежая версия: GitHub Pages разрешает браузеру 10 минут держать старую страницу. Сверяем номер версии
// в свежем index.html с загруженным и при расхождении перезагружаем — один раз на версию
const MY_V = (document.querySelector('script[src*="app.js?v="]') || { src: '' }).src.split('v=')[1] || '';
async function checkFresh() {
  if (PREVIEW) return;
  try {
    const html = await (await fetch(`${location.pathname}?fresh=${Date.now()}`, { cache: 'no-store' })).text();
    const v = (html.match(/app\.js\?v=([\w-]+)/) || [])[1];
    if (!v || !MY_V || v === MY_V) return;
    if (sessionStorage.getItem('bk-reloaded') === v) return;
    sessionStorage.setItem('bk-reloaded', v); location.reload();
  } catch (e) { /* без сети — в другой раз */ }
}
// поворот экрана или окно шире — перерисовать график под новую ширину (если не открыта форма)
let resizeT = null;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (D && !UI.form) render(); }, 200); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkFresh(); });
checkFresh();
boot();
