/* Кабинет продавца: выдача, возврат, профиль */
'use strict';
const Seller = {
  tab: 'search', q: '', results: null, order: null, f: null, done: false,
  retQ: '', ret: null, retErr: null,
  async start() { this.tab = 'search'; await this.show(); },

  shell(content, title, extra = '') {
    const pt = Staff.me.point;
    const t = this.tab;
    return `<header class="topbar"><div class="topbar-in"><span class="logo-mark">${ic('flame', 20)}</span><div style="flex:1;min-width:0"><b style="display:block">${esc(title)}</b><span class="muted sm" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${pt ? `${esc(pt.region)}, ${esc(pt.address)}` : ''}</span></div></div></header>
      <main class="narrow">${content}</main>${extra}
      <nav class="bottomnav"><div class="in">
        <button class="${t === 'search' || t === 'order' ? 'on' : ''}" data-act="sTab" data-t="search">${ic('qr', 22)}Выдача</button>
        <button class="${t === 'return' ? 'on' : ''}" data-act="sTab" data-t="return">${ic('ret', 22)}Возврат</button>
        <button class="${t === 'profile' ? 'on' : ''}" data-act="sTab" data-t="profile">${ic('user', 22)}Профиль</button></div></nav>`;
  },
  row: o => `<button class="orow" data-act="sOpen" data-n="${o.num}"><div class="main"><b>№ ${o.num}</b><div class="sub">${esc(o.ownerName)} · ${esc(o.productName)}</div></div>${pill(o.status)}${ic('chev', 18)}</button>`,

  async show() {
    await guard(async () => {
      if (this.tab === 'search') {
        const active = await GET('/api/seller/orders-active');
        const r = this.results;
        render(this.shell(`
          <button class="scan-hero" data-act="sScanOrder"><span class="ico">${ic('scan', 30)}</span><span><b>Сканировать QR заказа</b><span>Наведите камеру на QR-код покупателя</span></span></button>
          <div class="or">или найдите вручную</div>
          <div class="input-row"><input class="input" id="sq" data-in="sq" inputmode="numeric" placeholder="Номер заказа или ИИН" value="${esc(this.q)}" aria-label="Номер заказа или ИИН"><button class="btn" data-act="sSearch" aria-label="Найти">${ic('search', 20)}</button></div>
          ${r ? (r.length ? `<h2 class="h3" style="margin-top:18px">Найдено: ${r.length}</h2><div class="olist">${r.map(this.row).join('')}</div>` : msgBox('err', 'Заказ не найден', 'Проверьте номер заказа или ИИН (12 цифр).')) : ''}
          <h2 class="h3" style="margin-top:22px">Ожидают выдачи на вашей точке</h2>
          ${active.length ? `<div class="olist">${active.map(this.row).join('')}</div>` : '<div class="card muted sm">Сейчас нет заказов, ожидающих выдачи.</div>'}`, 'Выдача заказа'));
      } else if (this.tab === 'order') this.renderOrder();
      else if (this.tab === 'return') this.renderReturn();
      else if (this.tab === 'profile') render(this.shell(`
          <div class="card"><div class="person"><span class="avatar">${esc((Staff.me.fullName.split(' ')[1] || Staff.me.fullName)[0])}</span><div><b>${esc(Staff.me.fullName)}</b><div class="muted sm">Продавец, логин ${esc(Staff.me.login)}</div></div></div></div>
          ${credForm(false)}
          <button class="btn line block" style="margin-top:12px" data-act="logout">${ic('logout', 20)}Выйти</button>`, 'Профиль'));
      window.scrollTo(0, 0);
    });
  },

  async open(num) {
    await guard(async () => {
      this.order = await GET(`/api/seller/orders/${num}`);
      setServerNow(this.order.now);
      this.f = { recipient: 'owner', proxyNumber: '', proxyDate: '', proxyIin: '', serialNumber: '', checklist: {} };
      this.done = false;
      this.tab = 'order';
      this.renderOrder();
      window.scrollTo(0, 0);
    });
  },

  missing() {
    const o = this.order, f = this.f, m = [];
    if (o.status !== 'paid') m.push('оплата');
    if (!f.serialNumber.trim()) m.push('серийный номер');
    if (f.recipient === 'proxy' && (!f.proxyNumber.trim() || !f.proxyDate || f.proxyIin.length !== 12)) m.push('данные доверенности');
    const keys = ['id', 'passport', 'stamp', 'sticker', ...(f.recipient === 'proxy' ? ['proxy'] : [])];
    const left = keys.filter(k => !f.checklist[k]).length;
    if (left) m.push(`чек-лист: ${left}`);
    return m;
  },
  refreshIssue() {
    const m = this.missing(), b = $('#ibtn'), h = $('#ihint');
    if (!b) return;
    b.disabled = !!m.length;
    h.textContent = m.length ? 'Осталось: ' + m.join(', ') : 'Всё готово к выдаче';
  },

  renderOrder() {
    const o = this.order, f = this.f;
    const miniP = `<div class="mini" style="padding:0;margin-bottom:14px"><div class="pimg">${productImg({ id: o.productId, name: o.productName, photos: [] })}</div><div><b>${esc(o.productName)}</b><span class="price" style="font-size:16px">${fmt(o.price)} ₸</span> <span class="muted sm">с НДС</span></div></div>`;
    if (this.done) {
      render(this.shell(`<div class="card" style="text-align:center;padding:28px 20px"><div class="success-ico">${ic('check', 36)}</div><h1 class="title">Счетчик выдан</h1>
        <p class="muted" style="margin:6px 0 18px">Заказ № ${o.num}. ТУ ${esc(o.tuNumber)} заблокировано для повторной покупки.</p>
        <dl class="kv" style="text-align:left"><dt>Серийный номер</dt><dd>${esc(o.serialNumber)}</dd><dt>Получатель</dt><dd>${o.recipient === 'proxy' ? `Представитель, доверенность № ${esc(o.proxy.number)}` : 'Владелец ТУ'}</dd><dt>Дата выдачи</dt><dd>${fmtDT(o.issuedAt)}</dd></dl>
        <button class="btn block" style="margin-top:20px" data-act="sTab" data-t="search">Следующий заказ</button></div>`, `Заказ № ${o.num}`));
      return;
    }
    const canIssue = o.status === 'paid';
    const statusBox = {
      pending: `<div class="msg warn">${ic('clock', 20)}<div><b>Ожидает оплаты на кассе</b>Заказ отменится через <span data-deadline="${o.expiresAt}">--:--</span>. Выдача возможна после оплаты.
        <div class="input-row" style="margin-top:10px"><input class="input" id="rcpt" placeholder="Номер кассового чека" style="height:42px;font-size:15px"><button class="btn sm" data-act="sPay" style="height:42px">Подтвердить оплату</button></div></div></div>`,
      paid: msgBox('ok', 'Оплачен', `${o.receiptNumber ? `Чек № ${o.receiptNumber}. ` : ''}Проверьте документы и заполните чек-лист выдачи.`),
      issued: msgBox('info', 'Счетчик уже выдан', `${fmtDT(o.issuedAt)}, серийный № ${o.serialNumber}. Для возврата откройте вкладку «Возврат».`),
      returned: msgBox('info', 'Оформлен возврат', `${fmtDT(o.returnedAt)}. ТУ разблокировано.`),
      cancelled: msgBox('err', 'Заказ отменён', 'Время на оплату истекло. Покупателю нужно оформить новый заказ.'),
    }[o.status];
    const ck = (k, title, sub) => `<label class="check"><input type="checkbox" data-ch="sChk" data-k="${k}" ${f.checklist[k] ? 'checked' : ''}><span>${title}${sub ? `<small>${sub}</small>` : ''}</span></label>`;
    const m = this.missing();
    render(this.shell(`
      <div class="section-title"><button class="btn ghost sm" data-act="sTab" data-t="search" style="padding-left:4px">${ic('back', 18)}Назад</button>${pill(o.status)}</div>
      ${statusBox}
      ${o.otherPoint ? msgBox('warn', 'Заказ оформлен на другую точку', `${o.point.region}, ${o.point.address}`) : ''}
      <div class="card" style="margin-top:12px">${miniP}
        <dl class="kv"><dt>Владелец ТУ</dt><dd>${esc(o.ownerFullName)}</dd><dt>ИИН/БИН</dt><dd>${maskIIN(o.iin)}</dd><dt>Номер ТУ</dt><dd>${esc(o.tuNumber)}</dd><dt>Адрес установки</dt><dd>${esc(o.address)}</dd><dt>Оформлен</dt><dd>${fmtDT(o.createdAt)}</dd></dl></div>
      ${canIssue ? `
      <div class="card"><h2 class="h3">Кто получает счетчик</h2>
        <div class="seg"><button class="${f.recipient === 'owner' ? 'on' : ''}" data-act="sRec" data-v="owner">Владелец ТУ</button><button class="${f.recipient === 'proxy' ? 'on' : ''}" data-act="sRec" data-v="proxy">Представитель по доверенности</button></div>
        ${f.recipient === 'proxy' ? `<div class="field-grid">
          <div class="field"><label for="pn">Номер доверенности</label><input class="input" id="pn" data-in="sF" data-k="proxyNumber" value="${esc(f.proxyNumber)}"></div>
          <div class="field"><label for="pd">Дата доверенности</label><input class="input" id="pd" type="date" data-in="sF" data-k="proxyDate" value="${esc(f.proxyDate)}" max="${new Date().toISOString().slice(0, 10)}"></div></div>
          <div class="field" style="margin-bottom:0"><label for="pi">ИИН доверенного лица</label><input class="input" id="pi" data-in="sIin" inputmode="numeric" maxlength="13" placeholder="000000 000000" value="${maskIIN(f.proxyIin)}"></div>`
        : `<p class="muted sm">Сверьте удостоверение личности с ФИО владельца ТУ: ${esc(o.ownerFullName)}.</p>`}
      </div>
      <div class="card"><h2 class="h3">Серийный номер счетчика</h2>
        <div class="input-row"><input class="input" id="sn" data-in="sF" data-k="serialNumber" placeholder="Серийный номер с корпуса" value="${esc(f.serialNumber)}" autocapitalize="characters"><button class="btn sec" data-act="sScanSerial" aria-label="Сканировать штрих-код">${ic('barcode', 22)}</button></div>
        <p class="muted sm" style="margin-top:8px">Введите с клавиатуры или отсканируйте штрих-код камерой.</p></div>
      <div class="card"><h2 class="h3">Уведомление для паспорта счетчика</h2>
        <div class="notice">${esc(o.notice)}</div>
        <p class="muted sm" style="margin-top:8px">Поставьте штамп с этим текстом или впишите его от руки и распишитесь.</p></div>
      <div class="card"><h2 class="h3">Чек-лист выдачи</h2>
        ${ck('id', 'Удостоверение личности проверено', f.recipient === 'proxy' ? 'Удостоверение представителя' : 'ФИО совпадает с владельцем ТУ')}
        ${f.recipient === 'proxy' ? ck('proxy', 'Доверенность проверена', 'Данные внесены выше') : ''}
        ${ck('passport', 'Паспорт счетчика заполнен', 'Цена, ИИН владельца, номер ТУ, дата продажи, подпись, приложен кассовый чек')}
        ${ck('stamp', 'Штамп с уведомлением поставлен', 'Или текст вписан от руки с подписью')}
        ${ck('sticker', 'Наклейка с ценой нанесена на счетчик')}
      </div><div id="ierr"></div><div style="height:90px"></div>` : ''}`, `Заказ № ${o.num}`,
      canIssue ? `<div class="sticky-cta" style="bottom:62px;border-bottom:1px solid var(--line)"><div class="hint" id="ihint">${m.length ? 'Осталось: ' + m.join(', ') : 'Всё готово к выдаче'}</div><div class="in"><button class="btn" id="ibtn" data-act="sIssue" ${m.length ? 'disabled' : ''}>Выдать счетчик</button></div></div>` : ''));
  },

  renderReturn() {
    const o = this.ret;
    let body = '';
    if (this.retErr) body = msgBox('err', 'Счетчик не найден', this.retErr);
    else if (o) body = `<div class="card" style="margin-top:14px">
        <dl class="kv"><dt>Товар</dt><dd>${esc(o.productName)}</dd><dt>Серийный номер</dt><dd>${esc(o.serialNumber)}</dd><dt>Заказ</dt><dd>№ ${o.num}</dd><dt>Владелец ТУ</dt><dd>${esc(o.ownerFullName)}</dd><dt>Номер ТУ</dt><dd>${esc(o.tuNumber)}</dd><dt>Выдан</dt><dd>${fmtDT(o.issuedAt)}<br><span class="muted sm">${esc(o.point.address)}</span></dd></dl></div>
      <div class="card"><div class="field"><label for="rr">Причина возврата</label><select class="input" id="rr"><option>Неисправность счетчика</option><option>Отказ покупателя</option><option>Ошибка при выдаче</option><option>Другое</option></select></div>
        <div class="field"><label for="rc">Комментарий</label><textarea class="input" id="rc" maxlength="1000" placeholder="Обязателен, если выбрано «Другое»"></textarea></div>
        <label class="check" style="border:0;padding-top:0"><input type="checkbox" id="rchk" data-ch="sRetChk"><span>Счетчик, паспорт и кассовый чек приняты, деньги возвращены через кассу</span></label>
        <div id="rerr"></div>
        <button class="btn danger block" id="rbtn" data-act="sReturn" disabled style="margin-top:8px">Оформить возврат</button>
        <p class="muted sm" style="margin-top:8px;text-align:center">После возврата ТУ ${esc(o.tuNumber)} разблокируется</p></div>`;
    render(this.shell(`<p class="muted" style="margin-bottom:14px">Найдите счетчик по серийному номеру. После оформления возврата ТУ покупателя разблокируется и по нему снова можно купить счетчик.</p>
      <div class="input-row"><input class="input" id="rq" data-in="sRetQ" placeholder="Серийный номер" value="${esc(this.retQ)}" autocapitalize="characters" aria-label="Серийный номер"><button class="btn sec" data-act="sScanRet" aria-label="Сканировать штрих-код">${ic('barcode', 22)}</button><button class="btn" data-act="sRetFind" aria-label="Найти">${ic('search', 20)}</button></div>
      ${body}`, 'Возврат счетчика'));
  },
  async findReturn() {
    this.ret = null; this.retErr = null;
    if (!this.retQ.trim()) { toast('Введите серийный номер'); return; }
    await guard(async () => {
      try { this.ret = await GET(`/api/seller/returns/find?serial=${encodeURIComponent(this.retQ.trim())}`); }
      catch (e) { if (e.status === 404) this.retErr = e.message; else throw e; }
      this.renderReturn();
    });
  },
};

Object.assign(Staff.ACT, {
  sTab(t) { Seller.tab = t.dataset.t; if (Seller.tab === 'return') { Seller.ret = null; Seller.retErr = null; } if (Seller.tab === 'search') Seller.results = null; return Seller.show(); },
  async sSearch() {
    if (!Seller.q.trim()) return toast('Введите номер заказа или ИИН');
    await guard(async () => {
      try { Seller.results = await GET(`/api/seller/orders?q=${encodeURIComponent(Seller.q.trim())}`); }
      catch (e) { if (e.status === 400) return toast(e.message); throw e; }
      if (Seller.results.length === 1) return Seller.open(Seller.results[0].num);
      Seller.show();
    });
  },
  sOpen(t) { return Seller.open(t.dataset.n); },
  async sScanOrder() {
    const v = await openScanner('qr');
    if (!v) return;
    const m = v.match(/^QGA:(\d+):/i);
    if (!m) return toast('Это не QR-код заказа');
    await Seller.open(m[1]);
  },
  async sScanSerial() {
    const v = await openScanner('bar');
    if (!v) return;
    Seller.f.serialNumber = v.toUpperCase();
    $('#sn').value = Seller.f.serialNumber;
    Seller.refreshIssue();
    toast('Серийный номер считан');
  },
  async sScanRet() {
    const v = await openScanner('bar');
    if (!v) return;
    Seller.retQ = v.toUpperCase();
    await Seller.findReturn();
  },
  async sPay(btn) {
    const receipt = $('#rcpt').value.trim();
    if (!receipt) { toast('Укажите номер кассового чека'); $('#rcpt').focus(); return; }
    await busy(btn, () => guard(async () => {
      Seller.order = await POST(`/api/seller/orders/${Seller.order.num}/pay`, { receiptNumber: receipt });
      toast('Оплата подтверждена');
      Seller.renderOrder();
    }));
  },
  sRec(t) { Seller.f.recipient = t.dataset.v; Seller.renderOrder(); },
  async sIssue(btn) {
    if (Seller.missing().length) return;
    await busy(btn, () => guard(async () => {
      try { Seller.order = await POST(`/api/seller/orders/${Seller.order.num}/issue`, Seller.f); }
      catch (e) { $('#ierr').innerHTML = msgBox('err', 'Счетчик не выдан', e.message); $('#ierr').scrollIntoView({ block: 'center' }); return; }
      Seller.done = true;
      Seller.renderOrder();
      window.scrollTo(0, 0);
    }));
  },
  sRetFind() { return Seller.findReturn(); },
  async sReturn(btn) {
    const reason = $('#rr').value, comment = $('#rc').value.trim();
    await busy(btn, () => guard(async () => {
      try {
        const r = await POST(`/api/seller/orders/${Seller.ret.num}/return`, { reason, comment, confirmed: $('#rchk').checked });
        toast(`Возврат оформлен, ТУ ${r.tuNumber} разблокировано`);
        Seller.ret = null; Seller.retQ = '';
        Seller.renderReturn();
      } catch (e) { $('#rerr').innerHTML = `<div style="margin-bottom:8px">${msgBox('err', '', e.message)}</div>`; }
    }));
  },
});
Object.assign(Staff.IN, {
  sq(t) { Seller.q = t.value; },
  sRetQ(t) { Seller.retQ = t.value; },
  sF(t) { Seller.f[t.dataset.k] = t.value; Seller.refreshIssue(); },
  sIin(t) { const d = digits(t.value).slice(0, 12); Seller.f.proxyIin = d; t.value = maskIIN(d); Seller.refreshIssue(); },
});
Object.assign(Staff.CH, {
  sChk(t) { Seller.f.checklist[t.dataset.k] = t.checked; Seller.refreshIssue(); },
  sRetChk(t) { $('#rbtn').disabled = !t.checked; },
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'sq') Staff.ACT.sSearch();
  if (e.target.id === 'rq') Staff.ACT.sRetFind();
});
