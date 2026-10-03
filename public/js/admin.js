/* Кабинет администратора */
'use strict';
const ATABS = [['reports', 'Отчеты', 'chart'], ['points', 'Точки продаж', 'store'], ['sellers', 'Продавцы', 'users'], ['products', 'Товары', 'box'], ['tu', 'База ТУ', 'db'], ['audit', 'Журнал', 'doc'], ['profile', 'Профиль', 'key']];
const ACTIONS = {
  login: 'Вход', login_locked: 'Блокировка входа', change_credentials: 'Смена логина/пароля', order_paid: 'Подтверждена оплата', order_issued: 'Выдан счетчик',
  order_returned: 'Возврат', point_create: 'Создана точка', point_update: 'Изменена точка', seller_create: 'Создан продавец', seller_update: 'Изменен продавец',
  seller_block: 'Продавец заблокирован', seller_unblock: 'Продавец разблокирован', seller_reset_password: 'Сброс пароля продавца', product_create: 'Создан товар',
  product_update: 'Изменен товар', product_photo_add: 'Добавлено фото', product_photo_delete: 'Удалено фото', tu_import: 'Загрузка базы ТУ', report_export: 'Выгрузка отчета',
};
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Almaty' });
const daysAgo = n => new Date(Date.now() - n * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Almaty' });

const Admin = {
  tab: 'reports', from: daysAgo(29), to: today(), tuQ: '', tuPage: 0, importRes: null,
  points: [], products: [], sellers: [], regions: null,
  async start() { this.tab = 'reports'; await this.show(); },

  shell(title, actions, content) {
    return `<div class="admin"><aside class="side">${logoStaff('Администратор')}
      ${ATABS.map(([k, l, i]) => `<button class="nav ${this.tab === k ? 'on' : ''}" data-act="aTab" data-t="${k}">${ic(i, 20)}${l}</button>`).join('')}
      <div class="spacer"></div><button class="nav" data-act="logout">${ic('logout', 20)}Выйти</button></aside>
      <main class="amain"><div class="ahead"><h1>${title}</h1><div class="btn-row">${actions || ''}</div></div>${content}</main></div>`;
  },
  async show() {
    await guard(async () => {
      const v = { reports: this.vReports, points: this.vPoints, sellers: this.vSellers, products: this.vProducts, tu: this.vTU, audit: this.vAudit, profile: this.vProfile }[this.tab];
      render(await v.call(this));
    });
  },
  err: t => `<div class="msg err" style="margin:0 0 12px">${ic('alert', 20)}<span>${esc(t)}</span></div>`,
  async regionList() { if (!this.regions) this.regions = (await GET('/api/points')).regions; return this.regions; },

  /* ----- Отчеты ----- */
  async vReports() {
    const r = await GET(`/api/admin/reports/summary?from=${this.from}&to=${this.to}`);
    const k = r.kpi, max = Math.max(1, ...r.byPoint.map(x => x.issued));
    return this.shell('Отчеты', `<div class="date-range"><input type="date" data-ch="aFrom" value="${this.from}" max="${today()}" aria-label="С"><span class="muted">—</span><input type="date" data-ch="aTo" value="${this.to}" max="${today()}" aria-label="По"></div>
      <a class="btn sm sec" href="/api/admin/reports/export.xlsx?from=${this.from}&to=${this.to}">${ic('download', 18)}Выгрузить в Excel</a>`, `
      <div class="kpis">
        <div class="kpi"><span>Заказов оформлено</span><b>${k.total}</b></div>
        <div class="kpi"><span>Счетчиков выдано</span><b>${k.issued}</b></div>
        <div class="kpi"><span>Оплачено, ждут выдачи</span><b>${k.paid}</b></div>
        <div class="kpi"><span>Возвратов</span><b>${k.returned}</b></div>
        <div class="kpi"><span>Отменено без оплаты</span><b>${k.cancelled}</b></div>
        <div class="kpi"><span>Выручка, ₸</span><b>${fmt(k.revenue)}</b></div></div>
      <h2 class="h3" style="margin-top:8px">Продажи по точкам</h2>
      <div class="table-wrap"><table><thead><tr><th>Точка продаж</th><th class="num">Заказов</th><th>Выдано</th><th class="num">Возвратов</th><th class="num">Выручка, ₸</th></tr></thead><tbody>
        ${r.byPoint.map(x => `<tr><td><b style="font-weight:600">${esc(x.region)}</b><div class="muted sm">${esc(x.address)}</div></td><td class="num">${x.total}</td><td><div style="display:flex;align-items:center;gap:10px"><div class="bar" style="flex:1"><i style="width:${x.issued / max * 100}%"></i></div><span>${x.issued}</span></div></td><td class="num">${x.returned}</td><td class="num">${fmt(x.revenue)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">За выбранный период заказов нет</td></tr>'}
      </tbody></table></div>
      <h2 class="h3" style="margin-top:20px">Последние заказы</h2>
      <div class="table-wrap"><table><thead><tr><th>№ заказа</th><th>Дата</th><th>Номер ТУ</th><th>Товар</th><th>Точка</th><th>Серийный №</th><th>Статус</th></tr></thead><tbody>
        ${r.recent.map(o => `<tr><td>${o.num}</td><td style="white-space:nowrap">${fmtDT(o.created_at)}</td><td style="white-space:nowrap">${esc(o.tu_number)}</td><td>${esc(o.product_name)}</td><td>${esc(o.point_region)}</td><td style="white-space:nowrap">${esc(o.serial_number || '—')}</td><td>${pill(o.status)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Нет заказов</td></tr>'}
      </tbody></table></div>`);
  },

  /* ----- Точки ----- */
  async vPoints() {
    this.points = await GET('/api/admin/points');
    return this.shell('Точки продаж', `<button class="btn sm" data-act="aPointEdit" data-id="">${ic('plus', 18)}Добавить точку</button>`, `
      <div class="table-wrap"><table><thead><tr><th>Регион</th><th>Адрес</th><th>Режим работы</th><th class="num">Продавцов</th><th>Статус</th><th></th></tr></thead><tbody>
      ${this.points.map(p => `<tr><td>${esc(p.region)}</td><td>${esc(p.address)}</td><td>${esc(p.hours)}</td><td class="num">${p.sellers}</td><td>${p.active ? '<span class="pill active">Работает</span>' : '<span class="pill free">Закрыта</span>'}</td>
        <td><div class="td-actions"><button class="btn sm line" data-act="aPointEdit" data-id="${p.id}">${ic('edit', 16)}Изменить</button></div></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Добавьте первую точку продаж</td></tr>'}
      </tbody></table></div>`);
  },
  async pointModal(id) {
    const R = await this.regionList();
    const p = this.points.find(x => x.id === Number(id)) || { region: '', address: '', hours: 'Пн–Пт 9:00–18:00', active: true };
    const opt = r => `<option ${p.region === r ? 'selected' : ''}>${esc(r)}</option>`;
    openModal(`<div class="sheet-head"><h2>${id ? 'Изменить точку' : 'Новая точка продаж'}</h2><button class="iconbtn" data-act="closeModal" aria-label="Закрыть">${ic('x', 22)}</button></div>
      <div class="field"><label for="mr">Город или область</label><select class="input" id="mr"><option value="">Выберите</option><optgroup label="Города республиканского значения">${R.cities.map(opt).join('')}</optgroup><optgroup label="Области">${R.oblasts.map(opt).join('')}</optgroup></select></div>
      <div class="field"><label for="ma">Адрес</label><input class="input" id="ma" value="${esc(p.address)}" placeholder="Улица, дом, офис" maxlength="300"></div>
      <div class="field"><label for="mh">Режим работы</label><input class="input" id="mh" value="${esc(p.hours)}" maxlength="100"></div>
      <label class="switch" style="margin-bottom:18px"><input type="checkbox" id="mact" ${p.active ? 'checked' : ''}>Точка работает и доступна покупателям</label>
      <div id="merr"></div><button class="btn block" data-act="aPointSave" data-id="${id || ''}">Сохранить</button>`);
  },

  /* ----- Продавцы ----- */
  async vSellers() {
    [this.sellers, this.points] = await Promise.all([GET('/api/admin/sellers'), GET('/api/admin/points')]);
    return this.shell('Продавцы', `<button class="btn sm" data-act="aSellerEdit" data-id="">${ic('plus', 18)}Добавить продавца</button>`, `
      <div class="table-wrap"><table><thead><tr><th>ФИО</th><th>Логин</th><th>Точка продаж</th><th>Последний вход</th><th>Статус</th><th></th></tr></thead><tbody>
      ${this.sellers.map(s => `<tr><td><b style="font-weight:600">${esc(s.full_name)}</b></td><td>${esc(s.login)}</td><td>${esc(s.point_region || '')}<div class="muted sm">${esc(s.point_address || '')}</div></td><td style="white-space:nowrap">${s.last_login_at ? fmtDT(s.last_login_at) : '<span class="muted">не входил</span>'}</td>
        <td>${s.blocked ? '<span class="pill blocked">Заблокирован</span>' : s.locked ? '<span class="pill pending">Вход заблокирован на 60 мин</span>' : s.must_change_password ? '<span class="pill pending">Ждет смены пароля</span>' : '<span class="pill active">Активен</span>'}</td>
        <td><div class="td-actions"><button class="btn sm line" data-act="aSellerEdit" data-id="${s.id}" aria-label="Изменить" title="Изменить">${ic('edit', 16)}</button>
          <button class="btn sm line" data-act="aSellerReset" data-id="${s.id}" title="Сбросить пароль">${ic('key', 16)}</button>
          <button class="btn sm ${s.blocked ? 'sec' : 'line'}" data-act="aSellerBlock" data-id="${s.id}" data-b="${s.blocked ? 0 : 1}">${ic(s.blocked ? 'unlock' : 'lock', 16)}${s.blocked ? 'Разблокировать' : 'Заблокировать'}</button></div></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Продавцов пока нет</td></tr>'}
      </tbody></table></div>`);
  },
  sellerModal(id) {
    const s = this.sellers.find(x => x.id === Number(id)) || { full_name: '', login: '', point_id: null };
    openModal(`<div class="sheet-head"><h2>${id ? 'Изменить продавца' : 'Новый продавец'}</h2><button class="iconbtn" data-act="closeModal" aria-label="Закрыть">${ic('x', 22)}</button></div>
      <div class="field"><label for="sf">ФИО</label><input class="input" id="sf" value="${esc(s.full_name)}" maxlength="200"></div>
      <div class="field"><label for="sl">Логин</label><input class="input" id="sl" value="${esc(s.login)}" autocomplete="off" autocapitalize="off" maxlength="32"><span class="muted sm">3–32 символа: латинские буквы, цифры, точка, дефис, подчеркивание</span></div>
      <div class="field"><label for="spt">Точка продаж</label><select class="input" id="spt"><option value="">Выберите точку</option>${this.points.filter(p => p.active).map(p => `<option value="${p.id}" ${s.point_id === p.id ? 'selected' : ''}>${esc(p.region)}, ${esc(p.address)}</option>`).join('')}</select></div>
      ${id ? '' : msgBox('info', '', 'Система создаст временный пароль. Продавец сменит его при первом входе на собственный, соответствующий требованиям к паролю.') + '<div style="height:14px"></div>'}
      <div id="merr"></div><button class="btn block" data-act="aSellerSave" data-id="${id || ''}">Сохранить</button>`);
  },
  showTempPassword(title, login, pass) {
    openModal(`<div class="sheet-head"><h2>${esc(title)}</h2><button class="iconbtn" data-act="closeModal" aria-label="Закрыть">${ic('x', 22)}</button></div>
      <p>Логин: <b>${esc(login)}</b>. Временный пароль:</p>
      <div class="temp-pass">${esc(pass)}</div>
      ${msgBox('warn', 'Пароль показывается один раз', 'Передайте его продавцу лично. При первом входе система потребует задать новый пароль.')}
      <button class="btn block" style="margin-top:16px" data-act="closeModal">Готово</button>`);
  },

  /* ----- Товары ----- */
  async vProducts() {
    this.products = await GET('/api/admin/products');
    return this.shell('Товарные карточки', `<button class="btn sm" data-act="aProdEdit" data-id="">${ic('plus', 18)}Добавить товар</button>`, `
      <div class="agrid">${this.products.map(p => `<div class="acard"><div class="pimg">${productImg(p)}</div><div class="pbody"><b style="font-weight:600">${esc(p.name)}</b>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><span class="price">${fmt(p.price)} ₸</span>${p.active ? '<span class="pill active">В продаже</span>' : '<span class="pill free">Скрыт</span>'}</div>
        <span class="muted sm">${p.photos.length} фото из 4</span>
        <button class="btn sm line" data-act="aProdEdit" data-id="${p.id}">${ic('edit', 16)}Редактировать</button></div></div>`).join('') || '<div class="card muted">Добавьте первый товар</div>'}</div>`);
  },
  slotsHTML(p) {
    if (!p.id) return '<p class="muted sm">Фото можно добавить после сохранения товара.</p>';
    return `<div class="photo-slots">${[0, 1, 2, 3].map(i => p.photos.includes(i)
      ? `<div class="slot filled"><img src="/api/products/${p.id}/photos/${i}?v=${Date.now()}" alt=""><button class="rm" data-act="aPhotoRm" data-id="${p.id}" data-pos="${i}" aria-label="Удалить фото">${ic('x', 14)}</button></div>`
      : `<label class="slot">${ic('image', 24)}<input type="file" accept="image/jpeg,image/png,image/webp" data-ch="aPhoto" data-id="${p.id}"></label>`).join('')}</div>
      <span class="muted sm">JPG, PNG или WEBP до 5 МБ. Первое фото — главное в каталоге.</span>`;
  },
  prodModal(id) {
    const p = this.products.find(x => x.id === Number(id)) || { name: '', description: '', price: 54000, active: true, specs: [], photos: [], sort: 0 };
    const specs = p.specs.length ? p.specs : [['', '']];
    openModal(`<div class="sheet-head"><h2>${id ? 'Редактировать товар' : 'Новый товар'}</h2><button class="iconbtn" data-act="closeModal" aria-label="Закрыть">${ic('x', 22)}</button></div>
      <div class="field"><label for="pn2">Название</label><input class="input" id="pn2" value="${esc(p.name)}" maxlength="200"></div>
      <div class="field"><label for="pd2">Описание</label><textarea class="input" id="pd2" rows="3" maxlength="3000">${esc(p.description)}</textarea></div>
      <div class="field-grid"><div class="field"><label for="pp2">Цена, ₸ с НДС</label><input class="input" id="pp2" inputmode="numeric" value="${p.price}"></div>
        <div class="field"><label for="ps2">Порядок в каталоге</label><input class="input" id="ps2" inputmode="numeric" value="${p.sort}"></div></div>
      <div class="field"><span class="lbl">Характеристики</span><div id="specs">${specs.map(([k, v]) => `<div class="spec-row"><input class="input" placeholder="Параметр" value="${esc(k)}"><input class="input" placeholder="Значение" value="${esc(v)}"><button class="iconbtn" data-act="aSpecRm" aria-label="Удалить">${ic('x', 18)}</button></div>`).join('')}</div>
        <button class="btn sm ghost" data-act="aSpecAdd" style="align-self:flex-start">${ic('plus', 16)}Добавить характеристику</button></div>
      <div class="field"><span class="lbl">Фото, до 4 шт.</span><div id="slots">${this.slotsHTML(p)}</div></div>
      <label class="switch" style="margin-bottom:18px"><input type="checkbox" id="pa2" ${p.active ? 'checked' : ''}>Показывать в каталоге</label>
      <p class="muted sm" style="margin:-8px 0 14px">Новая цена применяется к новым заказам; в оформленных заказах цена сохраняется.</p>
      <div id="merr"></div><button class="btn block" data-act="aProdSave" data-id="${id || ''}">Сохранить</button>`, { wide: true });
  },
  async refreshSlots(id) {
    this.products = await GET('/api/admin/products');
    $('#slots').innerHTML = this.slotsHTML(this.products.find(x => x.id === Number(id)));
  },

  /* ----- База ТУ ----- */
  async vTU() {
    const [list, imports] = await Promise.all([GET(`/api/admin/tu?q=${encodeURIComponent(this.tuQ)}&page=${this.tuPage}`), GET('/api/admin/tu/imports')]);
    const r = this.importRes;
    return this.shell('База технических условий', '', `
      <div class="card" style="margin-bottom:16px">
        <div class="drop"><span class="ico">${ic('folder', 28)}</span><b>Загрузка базы ТУ из папки</b>
          <span class="muted sm" style="max-width:56ch">Укажите папку с выгрузками реестра ТУ из 1С (файлы .xlsx). В базу добавляются только новые записи — повторно загруженные ТУ пропускаются.</span>
          <label class="btn sm">${ic('folder', 18)}Выбрать папку<input type="file" webkitdirectory directory multiple data-ch="aFolder" class="hide"></label>
          ${imports[0] ? `<span class="muted sm">Последняя загрузка: ${fmtDT(imports[0].created_at)}, ${esc(imports[0].user_name || '')}</span>` : ''}</div>
        <div id="impRes">${r ? this.importHTML(r) : ''}</div>
      </div>
      <div class="toolbar"><label class="search">${ic('search', 18)}<input id="tuq" data-in="aTuQ" value="${esc(this.tuQ)}" placeholder="ИИН, номер ТУ или ФИО" aria-label="Поиск по базе ТУ"></label><span class="muted sm">Найдено: ${list.total}</span></div>
      <div class="table-wrap"><table><thead><tr><th>Номер ТУ</th><th>ИИН/БИН</th><th>ФИО / наименование</th><th>Адрес объекта</th><th>Загружено</th><th>Статус</th></tr></thead><tbody>
        ${list.rows.map(t => `<tr><td style="white-space:nowrap">${esc(t.tu_number)}</td><td style="white-space:nowrap">${maskIIN(t.iin)}</td><td>${esc(t.owner_name)}${t.is_legal ? ' <span class="tag">юрлицо</span>' : ''}</td><td>${esc(t.address)}<div class="muted sm">${esc(t.branch)}</div></td><td>${fmtDate(t.loaded_at)}</td>
          <td>${t.order_status === 'pending' ? '<span class="pill pending">В заказе</span>' : t.order_status ? '<span class="pill blocked">Счетчик куплен</span>' : '<span class="pill free">Свободно</span>'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Ничего не найдено</td></tr>'}
      </tbody></table>
      ${list.total > 50 ? `<div class="pager"><span class="muted sm">${list.page * 50 + 1}–${Math.min(list.total, list.page * 50 + 50)} из ${list.total}</span>
        <button class="btn sm line" data-act="aTuPage" data-d="-1" ${list.page ? '' : 'disabled'}>${ic('back', 16)}</button><button class="btn sm line" data-act="aTuPage" data-d="1" ${(list.page + 1) * 50 < list.total ? '' : 'disabled'}>${ic('chev', 16)}</button></div>` : ''}</div>
      ${imports.length ? `<h2 class="h3" style="margin-top:20px">История загрузок</h2><div class="table-wrap"><table><thead><tr><th>Дата</th><th>Папка</th><th class="num">Файлов</th><th class="num">Строк</th><th class="num">Добавлено</th><th class="num">Дублей</th><th class="num">Ошибок</th><th>Кто загрузил</th></tr></thead><tbody>
        ${imports.map(i => `<tr><td style="white-space:nowrap">${fmtDT(i.created_at)}</td><td>${esc(i.folder)}</td><td class="num">${i.files}</td><td class="num">${i.rows_read}</td><td class="num">${i.added}</td><td class="num">${i.duplicates}</td><td class="num">${i.errors}</td><td>${esc(i.user_name || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}`);
  },
  importHTML(r) {
    const errs = r.details.flatMap(d => d.error ? [`${d.file}: ${d.error}`] : (d.errors || []).map(e => `${d.file}, строка ${e.row}${e.number ? ` (${e.number})` : ''}: ${e.reason}`));
    return `${msgBox(r.errors ? 'warn' : 'ok', 'База обновлена', `Папка «${r.folder}»`)}
      <div class="stats3"><div><b>${r.files}</b><span>файлов обработано</span></div><div><b>${r.added}</b><span>новых записей добавлено</span></div><div><b>${r.duplicates}</b><span>дублей пропущено</span></div></div>
      ${errs.length ? `<details class="imp"><summary>Строки с ошибками: ${r.errors} (не загружены)</summary><ul class="err-list sm">${errs.slice(0, 100).map(e => `<li>${esc(e)}</li>`).join('')}</ul></details>` : ''}`;
  },

  /* ----- Журнал ----- */
  async vAudit() {
    const rows = await GET('/api/admin/audit');
    return this.shell('Журнал действий', '', `<p class="muted sm" style="margin-bottom:12px">Последние 200 действий сотрудников.</p>
      <div class="table-wrap"><table><thead><tr><th>Дата</th><th>Сотрудник</th><th>Действие</th><th>Объект</th><th>Подробности</th><th>IP</th></tr></thead><tbody>
      ${rows.map(a => `<tr><td style="white-space:nowrap">${fmtDT(a.created_at)}</td><td>${esc(a.user_name || '—')}${a.login ? `<div class="muted sm">${esc(a.login)}</div>` : ''}</td><td>${esc(ACTIONS[a.action] || a.action)}</td>
        <td class="sm">${esc(a.entity || '')} ${esc(a.entity_id || '')}</td><td class="sm">${a.details ? esc(Object.entries(a.details).map(([k, v]) => `${k}: ${v}`).join(', ')) : ''}</td><td class="sm">${esc(a.ip || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Записей нет</td></tr>'}
      </tbody></table></div>`);
  },

  async vProfile() {
    return this.shell('Профиль', '', `<div style="max-width:560px"><div class="card" style="margin-bottom:12px"><div class="person"><span class="avatar">${esc(Staff.me.fullName[0])}</span><div><b>${esc(Staff.me.fullName)}</b><div class="muted sm">Администратор, логин ${esc(Staff.me.login)}</div></div></div></div>${credForm(false)}</div>`);
  },
};

Object.assign(Staff.ACT, {
  aTab(t) { Admin.tab = t.dataset.t; return Admin.show().then(() => window.scrollTo(0, 0)); },
  aPointEdit(t) { return Admin.pointModal(t.dataset.id); },
  async aPointSave(btn) {
    const body = { region: $('#mr').value, address: $('#ma').value.trim(), hours: $('#mh').value.trim(), active: $('#mact').checked };
    if (!body.region || !body.address) { $('#merr').innerHTML = Admin.err('Укажите регион и адрес'); return; }
    await busy(btn, () => guard(async () => {
      try { btn.dataset.id ? await PUT(`/api/admin/points/${btn.dataset.id}`, body) : await POST('/api/admin/points', body); }
      catch (e) { $('#merr').innerHTML = Admin.err(e.message); return; }
      closeModal(); toast('Точка продаж сохранена'); Admin.show();
    }));
  },
  aSellerEdit(t) { Admin.sellerModal(t.dataset.id); },
  async aSellerSave(btn) {
    const body = { fullName: $('#sf').value.trim(), login: $('#sl').value.trim(), pointId: Number($('#spt').value) || 0 };
    if (!body.fullName || !body.login || !body.pointId) { $('#merr').innerHTML = Admin.err('Заполните ФИО, логин и точку продаж'); return; }
    await busy(btn, () => guard(async () => {
      let r;
      try { r = btn.dataset.id ? await PUT(`/api/admin/sellers/${btn.dataset.id}`, body) : await POST('/api/admin/sellers', body); }
      catch (e) { $('#merr').innerHTML = Admin.err(e.message); return; }
      await Admin.show();
      if (r.tempPassword) Admin.showTempPassword('Продавец создан', body.login, r.tempPassword); else { closeModal(); toast('Данные продавца сохранены'); }
    }));
  },
  async aSellerBlock(t) {
    const block = t.dataset.b === '1';
    if (block && !confirm('Заблокировать продавца? Его текущие сеансы будут завершены.')) return;
    await guard(async () => { await POST(`/api/admin/sellers/${t.dataset.id}/block`, { blocked: block }); toast(block ? 'Продавец заблокирован' : 'Продавец разблокирован'); Admin.show(); });
  },
  async aSellerReset(t) {
    const s = Admin.sellers.find(x => x.id === Number(t.dataset.id));
    if (!confirm(`Сбросить пароль продавца ${s.full_name}? Будет создан временный пароль.`)) return;
    await guard(async () => { const r = await POST(`/api/admin/sellers/${s.id}/reset-password`); await Admin.show(); Admin.showTempPassword('Пароль сброшен', s.login, r.tempPassword); });
  },
  aProdEdit(t) { Admin.prodModal(t.dataset.id); },
  aSpecAdd() { $('#specs').insertAdjacentHTML('beforeend', `<div class="spec-row"><input class="input" placeholder="Параметр"><input class="input" placeholder="Значение"><button class="iconbtn" data-act="aSpecRm" aria-label="Удалить">${ic('x', 18)}</button></div>`); },
  aSpecRm(t) { t.closest('.spec-row').remove(); },
  async aProdSave(btn) {
    const specs = $$('#specs .spec-row').map(r => [...r.querySelectorAll('input')].map(i => i.value.trim())).filter(([k]) => k);
    const body = { name: $('#pn2').value.trim(), description: $('#pd2').value.trim(), price: digits($('#pp2').value), sort: Number(digits($('#ps2').value)) || 0, active: $('#pa2').checked, specs };
    if (!body.name || !Number(body.price)) { $('#merr').innerHTML = Admin.err('Укажите название и цену'); return; }
    await busy(btn, () => guard(async () => {
      let r;
      try { r = btn.dataset.id ? await PUT(`/api/admin/products/${btn.dataset.id}`, body) : await POST('/api/admin/products', body); }
      catch (e) { $('#merr').innerHTML = Admin.err(e.message); return; }
      await Admin.show();
      if (!btn.dataset.id && r.id) { Admin.prodModal(r.id); toast('Товар создан — добавьте фото'); } else { closeModal(); toast('Товар сохранен'); }
    }));
  },
  async aPhotoRm(t) { await guard(async () => { await DEL(`/api/admin/products/${t.dataset.id}/photos/${t.dataset.pos}`); await Admin.refreshSlots(t.dataset.id); }); },
  aTuPage(t) { Admin.tuPage = Math.max(0, Admin.tuPage + Number(t.dataset.d)); return Admin.show(); },
});
let tuTimer;
Object.assign(Staff.IN, {
  aTuQ(t) { clearTimeout(tuTimer); tuTimer = setTimeout(async () => { Admin.tuQ = t.value.trim(); Admin.tuPage = 0; await Admin.show(); const n = $('#tuq'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 400); },
});
Object.assign(Staff.CH, {
  aFrom(t) { Admin.from = t.value || daysAgo(29); if (Admin.from > Admin.to) Admin.to = Admin.from; return Admin.show(); },
  aTo(t) { Admin.to = t.value || today(); if (Admin.to < Admin.from) Admin.from = Admin.to; return Admin.show(); },
  async aPhoto(t) {
    const file = t.files[0]; if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast('Файл больше 5 МБ');
    const fd = new FormData(); fd.append('photo', file);
    await guard(async () => {
      try { await api('POST', `/api/admin/products/${t.dataset.id}/photos`, fd); }
      catch (e) { toast(e.message); }
      await Admin.refreshSlots(t.dataset.id);
    });
  },
  async aFolder(t) {
    const files = [...t.files].filter(f => /\.xlsx$/i.test(f.name) && !f.name.startsWith('~$'));
    if (!files.length) { toast('В папке нет файлов .xlsx'); t.value = ''; return; }
    if (files.length > 50) { toast('Не более 50 файлов за одну загрузку'); t.value = ''; return; }
    const fd = new FormData();
    fd.append('folder', (t.files[0].webkitRelativePath || '').split('/')[0] || 'Папка');
    files.forEach(f => fd.append('files', f, f.name));
    $('#impRes').innerHTML = `<div class="loading">Загрузка и проверка ${files.length} файл(ов)…</div>`;
    await guard(async () => {
      try { Admin.importRes = await api('POST', '/api/admin/tu/import', fd); }
      catch (e) { $('#impRes').innerHTML = msgBox('err', 'Загрузка не выполнена', e.message); return; }
      toast(Admin.importRes.added ? `Добавлено записей: ${Admin.importRes.added}` : 'Новых записей нет');
      await Admin.show();
    });
  },
});
