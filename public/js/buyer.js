/* Интерфейс покупателя (без авторизации) */
'use strict';
const S = {
  catalog: null, points: null, q: '',
  co: null,            // { productId, iin, tu6, options, option, region, pointId, error }
  order: null, pollTimer: null,
};
const LAST_ORDER_KEY = 'gm_last_order';
const prod = id => S.catalog?.find(p => p.id === Number(id));

const logo = () => `<a class="logo" href="#/" aria-label="${T('home')}"><span class="logo-mark">${ic('flame', 20)}</span><span class="logo-text">${T('logo')}<small>${T('logo_sub')}</small></span></a>`;
const staffLink = () => `<a class="staff-link" href="/staff">${ic('user', 18)}<span>${T('staff')}</span></a>`;
function topbar(withSearch) {
  return `<header class="topbar"><div class="topbar-in">${logo()}
    ${withSearch ? `<label class="search">${ic('search', 18)}<input id="q" data-in="q" placeholder="${T('search')}" value="${esc(S.q)}" aria-label="${T('search_aria')}"></label>` : '<div style="flex:1"></div>'}
    ${langSwitch()}${staffLink()}</div></header>`;
}
function head(title, back, step) {
  return `<header class="topbar"><div class="topbar-in"><a class="iconbtn" href="${back}" aria-label="${T('back')}">${ic('back', 22)}</a><div class="headtitle">${title}</div>${step ? `<span class="muted sm step-n">${T('step', { n: step })}</span>` : ''}${langSwitch()}</div>
    ${step ? `<div class="steps">${[1, 2, 3].map(i => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>` : ''}</header>`;
}
const mini = p => `<div class="mini"><div class="pimg">${productImg(p)}</div><div><b>${esc(p.name)}</b><span class="price" style="font-size:16px">${fmt(p.price)} ₸</span> <span class="muted sm">${T('vat')}</span></div></div>`;
const render = html => { $('#app').innerHTML = html; tickDeadlines(); };

/* ---------- Каталог ---------- */
function lastOrder() { try { return JSON.parse(localStorage.getItem(LAST_ORDER_KEY) || 'null'); } catch { return null; } }
function vCatalog() {
  const q = S.q.trim().toLowerCase();
  const items = S.catalog.filter(p => !q || p.name.toLowerCase().includes(q));
  const lo = lastOrder();
  return `${topbar(true)}<main class="wrap">
    ${lo && Date.now() - lo.at < 3 * 86400000 ? `<a class="msg info" style="margin:0 0 14px;text-decoration:none" href="#/order/${lo.num}/${encodeURIComponent(lo.token)}">${ic('box', 20)}<div><b>${T('last_order', { num: lo.num })}</b>${T('last_order_open')}</div></a>` : ''}
    <section class="banner">
      <h1>${T('banner_h')}</h1>
      <p>${T('banner_p')}</p>
      <ol class="howto"><li>${T('how1')}</li><li>${T('how2')}</li><li>${T('how3')}</li></ol>
    </section>
    <h2 class="h2">${T('catalog')} <span class="muted">${items.length}</span></h2>
    ${items.length ? `<div class="grid">${items.map(p => `
      <a class="pcard" href="#/p/${p.id}" style="text-decoration:none">
        <div class="pimg">${productImg(p)}</div>
        <div class="pbody">${p.inStock ? `<span class="tag">${T('tag_price')}</span>` : `<span class="tag out">${T('out')}</span>`}<span class="pname">${esc(p.name)}</span><span class="price">${fmt(p.price)} ₸<small>${T('vat')}</small></span></div>
      </a>`).join('')}</div>`
      : `<div class="card" style="text-align:center">${S.catalog.length ? `<p>${T('nothing', { q: esc(S.q) })}</p><button class="btn ghost" data-act="clearQ">${T('show_all')}</button>` : `<p class="muted">${T('soon')}</p>`}</div>`}
  </main>`;
}

/* ---------- Карточка товара ---------- */
function vProduct(p) {
  const n = Math.max(1, p.photos.length);
  const slides = Array.from({ length: n }, (_, i) => `<div class="slide">${productImg(p, i)}</div>`).join('');
  return `${head(T('product_card'), '#/')}<main class="narrow">
    <div class="gallery" id="gal">${slides}</div>
    ${n > 1 ? `<div class="dots" id="dots">${Array.from({ length: n }, (_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>
    <div class="thumbs">${Array.from({ length: n }, (_, i) => `<button class="${i ? '' : 'on'}" data-act="photo" data-i="${i}" aria-label="${T('photo_n', { n: i + 1 })}">${productImg(p, i)}</button>`).join('')}</div>` : '<div style="height:12px"></div>'}
    <div class="card"><h1 class="title">${esc(p.name)}</h1><div class="price big">${fmt(p.price)} ₸ <small>${T('vat')}</small></div>
      <div class="msg info" style="margin-top:0">${ic('info', 18)}<span>${T('special')}</span></div></div>
    ${p.specs?.length ? `<div class="card"><h2 class="h3">${T('specs')}</h2><dl class="kv">${p.specs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>` : ''}
    ${p.description ? `<div class="card"><h2 class="h3">${T('descr')}</h2><p>${esc(p.description)}</p></div>` : ''}
  </main>
  <div class="sticky-cta"><div class="in"><div class="price">${fmt(p.price)} ₸</div>${p.inStock ? `<a class="btn" href="#/buy/${p.id}">${T('buy')}</a>` : `<button class="btn" disabled>${T('out')}</button>`}</div></div>`;
}
function bindGallery() {
  const gal = $('#gal'); if (!gal) return;
  gal.addEventListener('scroll', () => {
    const i = Math.round(gal.scrollLeft / gal.clientWidth);
    $$('#dots i').forEach((d, k) => d.classList.toggle('on', k === i));
    $$('.thumbs button').forEach((d, k) => d.classList.toggle('on', k === i));
  }, { passive: true });
}

/* ---------- Шаг 1: проверка ИИН + ТУ ---------- */
function checkResult() {
  const c = S.co;
  if (c.error) return msgBox('err', c.error.title, c.error.text);
  if (!c.options) return '';
  const o0 = c.options[0];
  if (c.options.length === 1) {
    return `${msgBox('ok', T('tu_found'), T('can_continue'))}
      <div class="person" style="margin-top:14px"><span class="avatar">${esc(o0.name[0] || '•')}</span><div><b>${esc(o0.name)}</b>
      <div class="muted sm" style="display:flex;gap:4px;margin-top:2px">${ic('pin', 16)}<span>${esc(o0.address)}</span></div><div class="muted sm">${esc(o0.tuNumber)}</div></div></div>`;
  }
  return `<div class="person" style="margin-top:16px"><span class="avatar">${esc(o0.name[0] || '•')}</span><div><b>${esc(o0.name)}</b><div class="muted sm">${T('many_tu')}</div></div></div>
    ${c.options.map((o, i) => `<button class="radio-card ${c.option === o ? 'on' : ''}" data-act="pickTU" data-i="${i}"><span class="dot"></span><span><b style="font-weight:600">${esc(o.address)}</b><span class="muted sm" style="display:block">${esc(o.tuNumber)}</span></span></button>`).join('')}`;
}
function vCheck(p) {
  const c = S.co;
  const ready = c.iin.length === 12 && c.tu6.length === 6;
  return `${head(T('checkout'), `#/p/${p.id}`, 1)}<main class="narrow">${mini(p)}
    <div class="card">
      <h2 class="h3">${T('check_h')}</h2>
      <p class="muted sm" style="margin:-4px 0 14px">${T('check_hint')}</p>
      <div class="field"><label for="iin">${T('iin')}</label><input class="input big" id="iin" data-in="iin" inputmode="numeric" autocomplete="off" placeholder="000000 000000" maxlength="13" value="${maskIIN(c.iin)}"></div>
      <div class="field"><label for="tu6">${T('tu6')}</label><input class="input big" id="tu6" data-in="tu6" inputmode="numeric" autocomplete="off" placeholder="000000" maxlength="6" value="${esc(c.tu6)}">
        <span class="muted sm">${T('tu6_example')}</span></div>
      <div class="field"><label for="cap">${T('captcha')}</label>
        <div class="captcha"><div class="captcha-img" id="capBox"></div><button class="iconbtn" data-act="captcha" aria-label="${T('captcha_refresh')}">${ic('refresh', 20)}</button></div>
        <input class="input" id="cap" autocomplete="off" placeholder="${T('captcha_ph')}" autocapitalize="off"></div>
      <button class="btn block" id="checkBtn" data-act="check" ${ready ? '' : 'disabled'}>${T('check')}</button>
      <div id="checkRes">${checkResult()}</div>
    </div>
  </main>
  <div id="ctaWrap">${c.option ? `<div class="sticky-cta"><div class="in"><a class="btn" href="#/point">${T('next_point')}</a></div></div>` : ''}</div>`;
}
function refreshCheckBtn() { const b = $('#checkBtn'); if (b) b.disabled = !(S.co.iin.length === 12 && S.co.tu6.length === 6); }

/* ---------- Шаг 2: точка выдачи ---------- */
function vPoint(p) {
  const c = S.co, o = c.option;
  const pts = S.points.points;
  const regs = [...S.points.regions.cities, ...S.points.regions.oblasts];
  const has = r => pts.some(x => x.region === r);
  const opt = r => `<option value="${esc(r)}" ${c.region === r ? 'selected' : ''}>${esc(regionName(r))}</option>`;
  const opts = arr => arr.filter(has).map(opt).join('');
  const other = [...new Set(pts.map(x => x.region))].filter(r => !regs.includes(r));
  const list = pts.filter(x => x.region === c.region);
  const sp = pts.find(x => x.id === c.pointId);
  if (!pts.length) {
    return `${head(T('checkout'), `#/buy/${p.id}`, 2)}<main class="narrow">${mini(p)}
      ${msgBox('warn', T('sold_out'), T('sold_out_t'))}
      <a class="btn sec block" style="margin-top:14px" href="#/">${T('to_catalog')}</a></main>`;
  }
  return `${head(T('checkout'), `#/buy/${p.id}`, 2)}<main class="narrow">${mini(p)}
    <div class="card">
      <h2 class="h3">${T('point_h')}</h2>
      <div class="field"><label for="reg">${T('region')}</label>
        <select class="input" id="reg" data-ch="region"><option value="">${T('region_pick')}</option>
          <optgroup label="${T('cities')}">${opts(S.points.regions.cities)}</optgroup>
          <optgroup label="${T('oblasts')}">${opts(S.points.regions.oblasts)}${other.map(opt).join('')}</optgroup></select></div>
      <div class="field" style="margin-bottom:0"><label for="pt">${T('point_addr')}</label>
        <select class="input" id="pt" data-ch="point" ${c.region ? '' : 'disabled'}><option value="">${c.region ? T('addr_pick') : T('region_first')}</option>
          ${list.map(x => `<option value="${x.id}" ${c.pointId === x.id ? 'selected' : ''}>${esc(x.address)}${S.points.stockEnabled && x.available <= 5 ? T('left_n', { n: x.available }) : ''}</option>`).join('')}</select></div>
      ${sp ? msgBox('info', `${regionName(sp.region)}, ${sp.address}`, `${sp.hours ? sp.hours + '. ' : ''}${T('bring_id')}`) : ''}
    </div>
    <div class="card"><h2 class="h3">${T('install_h')}</h2>
      <div class="person"><span class="avatar">${esc(o.name[0] || '•')}</span><div><b>${esc(o.name)}</b><div class="muted sm">${esc(o.address)}</div><div class="muted sm">${esc(o.tuNumber)}</div></div></div></div>
  </main>
  <div class="sticky-cta"><div class="in"><button class="btn" data-act="placeOrder" ${sp ? '' : 'disabled'}>${T('place_order')}</button></div></div>`;
}
function warning(p) {
  const o = S.co.option;
  const legal = o.dear === 'Уважаемый покупатель';
  const greet = LANG === 'kk' ? (legal ? 'Құрметті сатып алушы' : `Құрметті ${o.name}`) : (legal ? o.dear : `${o.dear} ${o.name}`);
  openModal(`<div class="warn-icon">${ic('alert', 28)}</div><h2>${T('before_h')}</h2>
    <p class="lead">${T('notice', { greet: esc(greet), address: esc(o.address), price: fmt(p.price) })}</p>
    <div id="orderErr"></div>
    <div class="stack"><button class="btn block" data-act="confirmOrder">${T('confirm')}</button><button class="btn ghost block" data-act="closeModal">${T('go_back')}</button></div>`);
}

/* ---------- Заказ ---------- */
function vOrder(o, token) {
  const tk = encodeURIComponent(token);
  const pending = o.status === 'pending';
  return `${head(T('your_order'), '#/')}<main class="narrow">
    <div class="card order-hero">
      ${pill(o.status)}
      <div class="order-num">№ ${o.num}</div>
      ${['pending', 'paid'].includes(o.status) ? `<div class="qrbox"><img src="/api/orders/${o.num}/qr.svg?t=${tk}" width="200" height="200" alt="${T('qr_alt', { num: o.num })}"></div>
      <p class="muted sm" style="margin-top:10px">${pending ? T('qr_pay') : T('qr_take')}</p>` : ''}
      ${pending ? `<div class="countdown">${ic('clock', 18)}<span>${T('pay_within', { t: `<span data-deadline="${esc(o.expiresAt)}">--:--</span>` })}</span></div>` : ''}
      ${o.status === 'cancelled' ? `<div style="text-align:left">${msgBox('err', T('cancelled_h'), T('cancelled_t'))}</div>` : ''}
      ${o.status === 'issued' ? `<div style="text-align:left">${msgBox('ok', T('issued_h'), T('issued_t'))}</div>` : ''}
      ${o.status === 'returned' ? `<div style="text-align:left">${msgBox('info', T('returned_h'), '')}</div>` : ''}
    </div>
    <div class="card"><dl class="kv">
      <dt>${T('k_product')}</dt><dd>${esc(o.productName)}</dd><dt>${T('k_price')}</dt><dd>${T('price_vat', { p: fmt(o.price) })}</dd>
      <dt>${T('k_owner')}</dt><dd>${esc(o.ownerName)}</dd><dt>${T('k_tu')}</dt><dd>${esc(o.tuNumber)}</dd>
      <dt>${T('k_addr')}</dt><dd>${esc(o.address)}</dd>
      <dt>${T('k_point')}</dt><dd>${esc(regionName(o.point.region))}, ${esc(o.point.address)}${o.point.hours ? `<br><span class="muted sm">${esc(o.point.hours)}</span>` : ''}</dd></dl></div>
    ${['pending', 'paid'].includes(o.status) ? `<div class="card"><h2 class="h3">${T('next_h')}</h2><ol class="seq">
      <li><span>${pending ? T('seq1_pending') : T('seq1')}</span></li>
      <li><span>${T('seq2')}</span></li>
      <li><span>${T('seq3')}</span></li></ol></div>
    <div class="btn-row" style="margin-top:16px"><a class="btn" href="/api/orders/${o.num}/pdf?t=${tk}&lang=${LANG}" download>${ic('download', 20)}${T('pdf')}</a><a class="btn sec" href="#/">${T('to_catalog')}</a></div>`
    : `<a class="btn sec block" style="margin-top:16px" href="#/">${T('to_catalog')}</a>`}
  </main>`;
}

/* ---------- Роутер ---------- */
async function ensureData() {
  // Каталог (с наличием) обновляется не реже раза в минуту
  if (!S.catalog || Date.now() - (S.catalogAt || 0) > 60000) { S.catalog = await GET('/api/catalog'); S.catalogAt = Date.now(); }
}
async function route() {
  clearInterval(S.pollTimer);
  closeModal();
  const h = location.hash.replace(/^#\/?/, '').split('/');
  try {
    if (h[0] === 'order' && h[1] && h[2]) return await showOrder(h[1], decodeURIComponent(h[2]));
    await ensureData();
    if (h[0] === 'p' && prod(h[1])) { render(vProduct(prod(h[1]))); bindGallery(); }
    else if (h[0] === 'buy' && prod(h[1])) {
      if (!S.co || S.co.productId !== Number(h[1])) S.co = { productId: Number(h[1]), iin: '', tu6: '', options: null, option: null, region: '', pointId: null, error: null };
      render(vCheck(prod(h[1])));
      loadCaptcha('#capBox', '#cap').catch(handleError);
    } else if (h[0] === 'point' && S.co?.option) {
      S.points = await GET(`/api/points?productId=${S.co.productId}`);
      if (S.co.pointId && !S.points.points.some(x => x.id === S.co.pointId)) S.co.pointId = null;
      render(vPoint(prod(S.co.productId)));
    } else { if (location.hash && location.hash !== '#/') history.replaceState(null, '', '#/'); render(vCatalog()); }
    window.scrollTo(0, 0);
  } catch (e) {
    render(`${topbar(false)}<main class="narrow">${msgBox('err', T('load_fail'), e.message)}<button class="btn sec block" style="margin-top:14px" data-act="reload">${T('retry')}</button></main>`);
  }
}
async function showOrder(num, token) {
  const load = async first => {
    const o = await GET(`/api/orders/${num}?t=${encodeURIComponent(token)}`);
    setServerNow(o.now);
    if (first || !S.order || S.order.status !== o.status) { S.order = o; render(vOrder(o, token)); if (first) window.scrollTo(0, 0); }
    if (!['pending', 'paid'].includes(o.status)) clearInterval(S.pollTimer);
  };
  try {
    await load(true);
    localStorage.setItem(LAST_ORDER_KEY, JSON.stringify({ num: Number(num), token, at: Date.now() }));
    S.pollTimer = setInterval(() => load(false).catch(() => {}), 15000);
  } catch (e) {
    render(`${head(T('order'), '#/')}<main class="narrow">${msgBox('err', T('order_nf'), T('order_nf_t'))}</main>`);
  }
}

bindEvents({
  clearQ() { S.q = ''; render(vCatalog()); },
  lang(t) {
    if (t.dataset.l === LANG) return;
    applyLang(t.dataset.l);
    if (S.co) S.co.error = null; // текст ошибки был на прежнем языке
    return route();
  },
  reload() { route(); },
  photo(t) { const g = $('#gal'); g.scrollTo({ left: g.clientWidth * Number(t.dataset.i), behavior: 'smooth' }); },
  captcha() { return loadCaptcha('#capBox', '#cap'); },
  async check(t) {
    const c = S.co;
    const captchaText = $('#cap').value.trim();
    if (!captchaText) { toast(T('enter_captcha')); $('#cap').focus(); return; }
    c.error = null; c.options = null; c.option = null;
    await busy(t, async () => {
      try {
        const r = await POST('/api/check', { iin: c.iin, tu6: c.tu6, captchaId: $('#capBox').dataset.id, captchaText });
        c.options = r.options;
        if (r.options.length === 1) c.option = r.options[0];
      } catch (e) {
        const left = e.data?.attemptsLeft;
        if (e.code === 'not_found') c.error = { title: T('nf_h'), text: T('nf_t') + (left != null ? T('attempts', { n: left }) : '') };
        else if (e.code === 'captcha') c.error = { title: T('captcha_h'), text: T('captcha_t') };
        else if (e.code === 'locked') c.error = { title: T('locked_h'), text: e.message };
        else if (['already_bought', 'pending', 'legal', 'gas'].includes(e.code)) c.error = { title: e.code === 'pending' ? T('pending_h') : T('unavailable_h'), text: e.message };
        else c.error = { title: T('error'), text: e.message };
      }
    });
    $('#checkRes').innerHTML = checkResult();
    $('#ctaWrap').innerHTML = c.option ? `<div class="sticky-cta"><div class="in"><a class="btn" href="#/point">${T('next_point')}</a></div></div>` : '';
    loadCaptcha('#capBox', '#cap').catch(() => {});
  },
  pickTU(t) {
    S.co.option = S.co.options[Number(t.dataset.i)];
    $('#checkRes').innerHTML = checkResult();
    $('#ctaWrap').innerHTML = `<div class="sticky-cta"><div class="in"><a class="btn" href="#/point">${T('next_point')}</a></div></div>`;
  },
  placeOrder() { warning(prod(S.co.productId)); },
  async confirmOrder(t) {
    await busy(t, async () => {
      try {
        const r = await POST('/api/orders', { ticket: S.co.option.ticket, productId: S.co.productId, pointId: S.co.pointId, confirmed: true });
        closeModal();
        S.co = null;
        location.hash = `#/order/${r.num}/${encodeURIComponent(r.token)}`;
      } catch (e) {
        $('#orderErr').innerHTML = msgBox('err', T('order_fail'), e.message);
        if (e.code === 'out_of_stock') setTimeout(() => { closeModal(); S.co.pointId = null; S.catalog = null; route(); }, 2500);
        if (e.code === 'ticket') setTimeout(() => { closeModal(); location.hash = `#/buy/${S.co.productId}`; S.co.options = null; S.co.option = null; route(); }, 2500);
      }
    });
  },
}, {
  q(t) { S.q = t.value; const pos = t.selectionStart; render(vCatalog()); const n = $('#q'); n.focus(); n.setSelectionRange(pos, pos); },
  iin(t) { const d = digits(t.value).slice(0, 12); S.co.iin = d; t.value = maskIIN(d); resetCheck(); refreshCheckBtn(); },
  tu6(t) { const d = digits(t.value).slice(0, 6); S.co.tu6 = d; t.value = d; resetCheck(); refreshCheckBtn(); },
}, {
  region(t) { S.co.region = t.value; S.co.pointId = null; render(vPoint(prod(S.co.productId))); },
  point(t) { S.co.pointId = Number(t.value) || null; render(vPoint(prod(S.co.productId))); },
});
function resetCheck() {
  if (!S.co.options && !S.co.error) return;
  S.co.options = null; S.co.option = null; S.co.error = null;
  $('#checkRes').innerHTML = ''; $('#ctaWrap').innerHTML = '';
}
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && ['iin', 'tu6', 'cap'].includes(e.target.id)) { const b = $('#checkBtn'); if (b && !b.disabled) b.click(); }
});
window.addEventListener('hashchange', route);
route();
