/* Общие функции фронтенда: API, форматирование, иконки, модальные окна, сканер */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
const digits = s => String(s ?? '').replace(/\D/g, '');
const maskIIN = d => (d.length > 6 ? d.slice(0, 6) + ' ' + d.slice(6) : d);
const fmtDT = t => (t ? new Date(t).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDate = t => (t ? new Date(t).toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty' }) : '—');
const STATUS = { pending: 'Ожидает оплаты', paid: 'Оплачен', issued: 'Выдан', returned: 'Возврат', cancelled: 'Отменён' };
const pill = s => `<span class="pill ${s}">${STATUS[s] || esc(s)}</span>`;

class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data || {}; this.code = this.data.code; } }

async function api(method, url, body) {
  const opt = { method, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opt); } catch { throw new ApiError('Нет связи с сервером. Проверьте интернет и повторите.', 0); }
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) throw new ApiError(data?.error || 'Ошибка сервера', res.status, data);
  return data;
}
const GET = url => api('GET', url);
const POST = (url, body) => api('POST', url, body ?? {});
const PUT = (url, body) => api('PUT', url, body);
const DEL = url => api('DELETE', url);

const msgBox = (type, title, text) => `<div class="msg ${type}">${ic(type === 'ok' ? 'check' : type === 'info' ? 'info' : 'alert', 20)}<div>${title ? `<b>${esc(title)}</b>` : ''}${text ? esc(text) : ''}</div></div>`;

function toast(t) {
  const el = $('#toast'); if (!el) return;
  el.textContent = t; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 3000);
}
let modalCleanup = null;
function openModal(html, opts = {}) {
  closeModal();
  $('#modal-root').innerHTML = `<div class="modal-back" data-act="backdrop"><div class="sheet ${opts.wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  modalCleanup = opts.onClose || null;
  const f = $('#modal-root .sheet input:not([type=hidden]), #modal-root .sheet select, #modal-root .sheet textarea');
  (f || $('#modal-root .sheet button'))?.focus();
}
function closeModal() {
  if (modalCleanup) { const f = modalCleanup; modalCleanup = null; f(); }
  const root = $('#modal-root'); if (root) root.innerHTML = '';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#modal-root')?.innerHTML) closeModal(); });

/** Капча: загружает картинку в контейнер, возвращает id */
async function loadCaptcha(boxSel, inputSel) {
  const c = await GET('/api/captcha');
  $(boxSel).innerHTML = c.svg;
  $(boxSel).dataset.id = c.id;
  if (inputSel && $(inputSel)) $(inputSel).value = '';
  return c.id;
}

/** Обратный отсчёт для элементов [data-deadline] (с поправкой на часы сервера) */
let clockSkew = 0;
function setServerNow(serverNow) { if (serverNow) clockSkew = new Date(serverNow).getTime() - Date.now(); }
function tickDeadlines() {
  $$('[data-deadline]').forEach(el => {
    const ms = Math.max(0, new Date(el.dataset.deadline).getTime() - (Date.now() + clockSkew));
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    el.textContent = h ? `${h}:${mmss}` : mmss;
  });
}
setInterval(tickDeadlines, 1000);

/**
 * Сканер QR / штрих-кодов камерой (html5-qrcode). Камера доступна только по HTTPS или на localhost.
 * kind: 'qr' — QR заказа; 'bar' — штрих-код серийного номера.
 */
function openScanner(kind) {
  return new Promise(resolve => {
    let scanner = null, done = false;
    const finish = v => { if (done) return; done = true; const s = scanner; scanner = null; if (s) s.stop().catch(() => {}).finally(() => s.clear?.()); closeModal(); resolve(v); };
    openModal(`<div class="sheet-head"><h2>${kind === 'qr' ? 'QR-код заказа' : 'Штрих-код счетчика'}</h2><button class="iconbtn" data-act="closeModal" aria-label="Закрыть">${ic('x', 22)}</button></div>
      <div id="reader" class="reader"></div>
      <p class="muted sm" style="text-align:center" id="scanHint">${kind === 'qr' ? 'Наведите камеру на QR-код на экране покупателя или в PDF' : 'Совместите штрих-код на корпусе или коробке с рамкой'}</p>`,
      { onClose: () => { if (!done) { done = true; if (scanner) scanner.stop().catch(() => {}); resolve(null); } } });
    if (!window.Html5Qrcode || !navigator.mediaDevices) { $('#scanHint').textContent = 'Камера недоступна в этом браузере. Введите значение вручную.'; return; }
    const F = window.Html5QrcodeSupportedFormats;
    const formats = kind === 'qr' ? [F.QR_CODE] : [F.CODE_128, F.CODE_39, F.EAN_13, F.EAN_8, F.ITF, F.DATA_MATRIX, F.QR_CODE];
    scanner = new Html5Qrcode('reader', { formatsToSupport: formats, verbose: false });
    const box = kind === 'qr' ? { width: 220, height: 220 } : { width: 280, height: 110 };
    scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: box }, text => finish(text.trim()), () => {})
      .catch(() => { $('#scanHint') && ($('#scanHint').textContent = 'Нет доступа к камере. Разрешите доступ в настройках браузера (сайт должен работать по HTTPS) или введите значение вручную.'); });
  });
}

/** Делегирование событий: data-act / data-in / data-ch */
function bindEvents(ACT, IN = {}, CH = {}) {
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    if (t.dataset.act === 'closeModal') return closeModal();
    if (t.dataset.act === 'backdrop') { if (e.target === t) closeModal(); return; }
    const f = ACT[t.dataset.act];
    if (f) { e.preventDefault(); Promise.resolve(f(t, e)).catch(handleError); }
  });
  document.addEventListener('input', e => { const f = IN[e.target.dataset.in]; if (f) f(e.target, e); });
  document.addEventListener('change', e => { const f = CH[e.target.dataset.ch]; if (f) Promise.resolve(f(e.target, e)).catch(handleError); });
}
function handleError(e) { console.error(e); toast(e.message || 'Ошибка'); }

/** Блокирует кнопку на время запроса */
async function busy(btn, fn) {
  if (!btn) return fn();
  const html = btn.innerHTML; btn.disabled = true; btn.innerHTML = 'Подождите…';
  try { return await fn(); } finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = html; } }
}

const productImg = (p, pos = 0) => (p.photos && p.photos.length > pos
  ? `<img src="/api/products/${p.id}/photos/${p.photos[pos]}" alt="${esc(p.name)}" loading="lazy">`
  : meterSVG(/g2[,.]?5|компакт/i.test(p.name) ? 'compact' : /смарт|lcd|связ/i.test(p.name) ? 'lcd' : /термо/i.test(p.name) ? 'thermo' : 'drum', 0));

const IC = {
  back:'<path d="M15 18l-6-6 6-6"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  qr:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20.5v.01M17.5 17.5H21V21h-3.5z"/>',
  barcode:'<path d="M4 6v12M7 6v12M11 6v12M14 6v12M18 6v12M20 6v12"/>',
  scan:'<path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3M4 12h16"/>',
  check:'<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chev:'<path d="M9 6l6 6-6 6"/>',
  x:'<path d="M6 6l12 12M18 6L6 18"/>',
  box:'<path d="M3 7.5l9-4.5 9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9"/>',
  store:'<path d="M4 10v10h16V10"/><path d="M3 4h18l-1 6H4z"/><path d="M10 20v-5h4v5"/>',
  users:'<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5"/><path d="M16 4.5a3.5 3.5 0 010 7M18 14.5c2.5.6 4 2.4 4 5.5"/>',
  db:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  chart:'<path d="M4 20V11M10 20V4M16 20v-7M21 20H3"/>',
  logout:'<path d="M15 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4M10 16l-4-4 4-4M6 12h11"/>',
  ret:'<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/>',
  download:'<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  edit:'<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  lock:'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  unlock:'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 017.5-2"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  alert:'<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.5h.01"/>',
  refresh:'<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/>',
  pin:'<path d="M12 21s-7-6.2-7-12a7 7 0 0114 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  folder:'<path d="M3 6a1 1 0 011-1h5l2 2h9a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1z"/>',
  flame:'<path d="M12 2.5c1 3.5 5 5.5 5 10.5a5 5 0 01-10 0c0-2.4 1.2-3.9 2.3-5 .2 1.7.9 2.8 2 3.3-.3-3 .2-5.8.7-8.8z"/>',
  key:'<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
  doc:'<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  camera:'<path d="M3 8a2 2 0 012-2h2l2-2h6l2 2h2a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><circle cx="12" cy="13" r="3.5"/>',
  image:'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 9"/>',
};
const ic = (n, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n]}</svg>`;

/* ============ product illustrations (placeholders instead of photos) ============ */
let svgN = 0;
function meterSVG(kind, view) {
  const id = 'm' + (svgN++);
  const defs = `<defs>
    <linearGradient id="${id}b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#EEF1F3"/><stop offset="1" stop-color="#C4CCD2"/></linearGradient>
    <linearGradient id="${id}s" x1="0" x2="1"><stop offset="0" stop-color="#A9B3BA"/><stop offset="1" stop-color="#87929A"/></linearGradient>
    <linearGradient id="${id}p" x1="0" x2="1"><stop offset="0" stop-color="#8A949B"/><stop offset=".5" stop-color="#D3D9DD"/><stop offset="1" stop-color="#8A949B"/></linearGradient>
  </defs>`;
  const open = `<svg class="ph" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Изображение счётчика">${defs}<rect width="200" height="200" fill="#F4F6F7"/>`;
  const lcd = kind === 'lcd';
  if (view === 3) { // packaging
    return open + `<ellipse cx="100" cy="176" rx="70" ry="6" fill="#17212B" opacity=".08"/>
      <path d="M40 60l60-18 60 18v108l-60 8-60-8z" fill="#fff" stroke="#DCE2E6"/>
      <path d="M100 42l60 18-60 14-60-14z" fill="#F0F3F5" stroke="#DCE2E6"/>
      <path d="M100 74v102" stroke="#DCE2E6"/>
      <path d="M40 60l60 14v26L40 86z" fill="#0ABAB5"/>
      <path d="M100 74l60-14v26l-60 14z" fill="#09A39F"/>
      <rect x="54" y="110" width="32" height="38" rx="5" fill="#E6EAED"/><rect x="58" y="116" width="24" height="10" rx="2" fill="#17212B"/>
      <text x="128" y="132" font-family="Onest,Arial" font-size="20" font-weight="800" fill="#17212B" text-anchor="middle">${kind==='compact'?'G2,5':'G4'}</text>
      <text x="128" y="148" font-family="Onest,Arial" font-size="8" fill="#67737D" text-anchor="middle">счётчик газа</text></svg>`;
  }
  if (view === 2) { // close-up of counter
    const face = lcd
      ? `<rect x="22" y="58" width="156" height="84" rx="12" fill="#9ED8C6"/><text x="100" y="114" font-family="Courier New,monospace" font-size="34" font-weight="700" fill="#1F3B33" text-anchor="middle">0124.368</text><text x="36" y="76" font-family="Arial" font-size="10" fill="#1F3B33">м³</text><text x="164" y="76" font-family="Arial" font-size="10" fill="#1F3B33" text-anchor="end">GSM ▮▮▮</text>`
      : `<rect x="18" y="62" width="164" height="76" rx="12" fill="#1C2830"/>${[0,1,2,3,4,5,6,7].map(i=>`<rect x="${28+i*19.5}" y="78" width="16" height="44" rx="3" fill="${i>4?'#E7584A':'#F4F6F7'}"/><text x="${36+i*19.5}" y="109" font-family="Courier New,monospace" font-size="22" font-weight="700" fill="${i>4?'#fff':'#17212B'}" text-anchor="middle">${'00124368'[i]}</text>`).join('')}`;
    return open + `<rect x="8" y="30" width="184" height="140" rx="18" fill="url(#${id}b)"/>${face}<text x="100" y="160" font-family="Onest,Arial" font-size="10" fill="#67737D" text-anchor="middle">${lcd?'электронный отсчётный механизм':'роликовый отсчётный механизм, м³'}</text></svg>`;
  }
  const compact = kind === 'compact';
  let bx = compact ? 54 : 40, bw = compact ? 92 : 120, by = compact ? 54 : 42, bh = compact ? 118 : 136;
  if (view === 1) bx -= 10;
  const p1 = bx + bw * .24, p2 = bx + bw * .76;
  const pipe = x => `<rect x="${x-10}" y="${by-22}" width="20" height="24" fill="url(#${id}p)"/><rect x="${x-14}" y="${by-28}" width="28" height="10" rx="2" fill="#7F8A92"/>`;
  const side = view === 1 ? `<path d="M${bx+bw-4},${by+8} L${bx+bw+20},${by} L${bx+bw+20},${by+bh-12} L${bx+bw-4},${by+bh-2} Z" fill="url(#${id}s)"/>` : '';
  const seamY = by + bh * .42;
  const win = lcd
    ? `<rect x="${bx+14}" y="${by+16}" width="${bw-28}" height="30" rx="6" fill="#9ED8C6"/><text x="${bx+bw/2}" y="${by+37}" font-family="Courier New,monospace" font-size="${compact?12:15}" font-weight="700" fill="#1F3B33" text-anchor="middle">0124.368</text>`
    : `<rect x="${bx+14}" y="${by+16}" width="${bw-28}" height="30" rx="6" fill="#1C2830"/>${Array.from({length:compact?6:8},(_,i)=>{const n=compact?6:8, w=(bw-36)/n; return `<rect x="${bx+18+i*w}" y="${by+21}" width="${w-2}" height="20" rx="2" fill="${i>=n-3?'#E7584A':'#F4F6F7'}"/>`}).join('')}`;
  const plateY = seamY + 14, plateH = bh * .58 - 28;
  const plate = `<rect x="${bx+14}" y="${plateY}" width="${bw-28}" height="${plateH}" rx="6" fill="#fff"/><rect x="${bx+14}" y="${plateY}" width="${bw-28}" height="9" rx="3" fill="#0ABAB5"/>
    <text x="${bx+22}" y="${plateY+30}" font-family="Onest,Arial" font-size="${compact?13:16}" font-weight="800" fill="#17212B">${compact?'G2,5':'G4'}</text>
    ${kind==='thermo'?`<rect x="${bx+bw-46}" y="${plateY+18}" width="20" height="16" rx="3" fill="#17212B"/><text x="${bx+bw-36}" y="${plateY+30}" font-family="Arial" font-size="9" font-weight="700" fill="#fff" text-anchor="middle">TK</text>`:''}
    <rect x="${bx+22}" y="${plateY+38}" width="${bw-48}" height="3" rx="1.5" fill="#DCE2E6"/><rect x="${bx+22}" y="${plateY+46}" width="${bw-64}" height="3" rx="1.5" fill="#DCE2E6"/>`;
  return open + `<ellipse cx="${bx+bw/2+(view===1?10:0)}" cy="${by+bh+12}" rx="${bw/2+10}" ry="5" fill="#17212B" opacity=".09"/>
    ${pipe(p1)}${pipe(p2)}${side}
    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="14" fill="url(#${id}b)"/>
    <rect x="${bx}" y="${seamY}" width="${bw}" height="5" fill="#B3BCC2"/>
    ${win}${plate}</svg>`;
}

