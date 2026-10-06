/* Кабинет сотрудника: вход, смена пароля, маршрутизация по ролям */
'use strict';
const Staff = { me: null, policy: null, ACT: {}, IN: {}, CH: {} };
const render = html => { $('#app').innerHTML = html; tickDeadlines(); };
const logoStaff = sub => `<a class="logo" href="/staff"><span class="logo-mark">${ic('flame', 20)}</span><span class="logo-text">Счетчики газа<small>${esc(sub)}</small></span></a>`;

/* ---------- Вход ---------- */
function vLogin(msg) {
  return `<div class="login-wrap"><div class="login">
    <div style="display:flex;justify-content:center;margin-bottom:18px">${logoStaff('Вход для сотрудников')}</div>
    <div class="card">
      <h1 class="title" style="margin-bottom:4px">Вход в кабинет</h1>
      <p class="muted sm" style="margin-bottom:18px">Для продавцов и администраторов</p>
      <div class="field"><label for="lg">Логин</label><input class="input" id="lg" autocomplete="username" autocapitalize="off"></div>
      <div class="field"><label for="pw">Пароль</label><input class="input" id="pw" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="cp">Код с картинки</label>
        <div class="captcha"><div class="captcha-img" id="capBox"></div><button class="iconbtn" data-act="captcha" aria-label="Обновить код">${ic('refresh', 20)}</button></div>
        <input class="input" id="cp" autocomplete="off" autocapitalize="off" placeholder="Введите символы"></div>
      <div id="lerr">${msg ? msgBox('info', '', msg) : ''}</div>
      <button class="btn block" id="loginBtn" data-act="login" style="margin-top:6px">Войти</button>
    </div>
    <div style="text-align:center;margin-top:14px"><a class="btn ghost sm" href="/">${ic('back', 16)}На сайт продажи</a></div>
  </div></div>`;
}
async function showLogin(msg) {
  render(vLogin(msg));
  $('#lg').focus();
  await loadCaptcha('#capBox', '#cp');
}

/* ---------- Пароль: требования и форма ---------- */
const PW_TESTS = [
  ['len', (v, P) => v.length >= P.minLength && v.length <= P.maxLength, P => `от ${P.minLength} до ${P.maxLength} символов`],
  ['case', v => /[A-ZА-ЯЁӘҒҚҢӨҰҮҺІ]/.test(v) && /[a-zа-яёәғқңөұүһі]/.test(v), () => 'заглавная и строчная буквы'],
  ['digit', v => /\d/.test(v), () => 'хотя бы одна цифра'],
  ['special', v => /[^\p{L}\p{N}\s]/u.test(v), () => 'хотя бы один спецсимвол: ! @ # $ % и т. п.'],
  ['space', v => v.length > 0 && !/\s/.test(v), () => 'без пробелов'],
  ['login', (v, P, login) => v.length > 0 && !(login && login.length >= 3 && v.toLowerCase().includes(login.toLowerCase())), () => 'не содержит логин'],
  ['repeat', v => v.length > 0 && !/(.)\1\1/u.test(v), () => 'не более двух одинаковых символов подряд'],
];
function pwRulesHTML() {
  const P = Staff.policy;
  return `<ul class="pw-rules" id="pwRules">${PW_TESTS.map(([k, , label]) => `<li data-k="${k}">${label(P)}</li>`).join('')}
    </ul>
    <p class="muted sm" style="margin:-6px 0 14px">Новый пароль не должен совпадать с ${P.history} предыдущими. Пароль действует ${P.maxAgeDays} дней, затем система попросит его сменить.</p>`;
}
function updatePwRules() {
  const v = $('#np')?.value || '', login = ($('#nl')?.value || Staff.me?.login || '').trim();
  let ok = true;
  PW_TESTS.forEach(([k, test]) => { const pass = test(v, Staff.policy, login); ok = ok && pass; $(`#pwRules li[data-k="${k}"]`)?.classList.toggle('ok', pass); });
  const same = v && v === ($('#np2')?.value || '');
  const b = $('#credBtn');
  if (b && b.dataset.forced === '1') b.disabled = !(ok && same && $('#op').value);
  return ok && same;
}
function credForm(forced) {
  const u = Staff.me;
  return `<div class="card">
    <h2 class="h3">${forced ? 'Задайте новый пароль' : 'Сменить логин и пароль'}</h2>
    ${forced ? msgBox('warn', u.passwordExpired ? 'Срок действия пароля истёк' : 'Первый вход в систему', u.passwordExpired ? 'Для продолжения работы задайте новый пароль.' : 'Временный пароль нужно заменить на свой.') + '<div style="height:12px"></div>' : ''}
    <div class="field"><label for="nl">Логин</label><input class="input" id="nl" value="${esc(u.login)}" autocomplete="username" autocapitalize="off" data-in="pwcheck"></div>
    <div class="field"><label for="op">${forced ? 'Текущий (временный) пароль' : 'Текущий пароль'}</label><input class="input" id="op" type="password" autocomplete="current-password" data-in="pwcheck"></div>
    <div class="field-grid"><div class="field"><label for="np">Новый пароль</label><input class="input" id="np" type="password" autocomplete="new-password" data-in="pwcheck"></div>
    <div class="field"><label for="np2">Повторите пароль</label><input class="input" id="np2" type="password" autocomplete="new-password" data-in="pwcheck"></div></div>
    ${pwRulesHTML()}
    <div id="perr"></div>
    <button class="btn block" id="credBtn" data-act="saveCreds" data-forced="${forced ? 1 : 0}" ${forced ? 'disabled' : ''}>Сохранить</button>
  </div>`;
}
function showForcedChange() {
  render(`<div class="login-wrap"><div class="login" style="max-width:480px">
    <div style="display:flex;justify-content:center;margin-bottom:18px">${logoStaff(Staff.me.fullName)}</div>
    ${credForm(true)}
    <div style="text-align:center;margin-top:14px"><button class="btn ghost sm" data-act="logout">${ic('logout', 16)}Выйти</button></div></div></div>`);
  $('#op').focus();
}
async function saveCreds(btn) {
  const forced = btn.dataset.forced === '1';
  const body = { currentPassword: $('#op').value };
  const nl = $('#nl').value.trim(), np = $('#np').value, np2 = $('#np2').value;
  const err = (t, list) => { $('#perr').innerHTML = `<div class="msg err" style="margin:0 0 12px">${ic('alert', 20)}<div>${esc(t)}${list ? `<ul class="err-list">${list.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div></div>`; };
  if (!body.currentPassword) return err('Укажите текущий пароль');
  if (nl !== Staff.me.login) body.newLogin = nl;
  if (np || np2 || forced) {
    if (!updatePwRules()) return err(np !== np2 ? 'Пароли не совпадают' : 'Пароль не соответствует требованиям');
    body.newPassword = np;
  }
  if (!body.newLogin && !body.newPassword) return err('Измените логин или задайте новый пароль');
  await busy(btn, async () => {
    try { await POST('/api/auth/change-credentials', body); }
    catch (e) { return err(e.message.replace(/^Пароль не соответствует требованиям: .*/, 'Пароль не соответствует требованиям:'), e.data?.errors); }
    toast('Данные для входа сохранены');
    await boot();
  });
}

/* ---------- Запуск ---------- */
async function boot() {
  closeModal();
  if (!Staff.policy) Staff.policy = await GET('/api/auth/password-policy');
  try { Staff.me = await GET('/api/auth/me'); }
  catch (e) { if (e.status === 401) return showLogin(); throw e; }
  if (Staff.me.mustChangePassword) return showForcedChange();
  if (Staff.me.role === 'seller') return Seller.start();
  if (Staff.me.role === 'admin' || Staff.me.role === 'finance') return Admin.start();
}
/** Обработка истёкшей сессии в любом запросе */
async function guard(fn) {
  try { return await fn(); }
  catch (e) {
    if (e.status === 401) { await showLogin('Сессия завершена. Войдите снова.'); return; }
    if (e.code === 'must_change_password') { await boot(); return; }
    throw e;
  }
}

Object.assign(Staff.ACT, {
  captcha() { return loadCaptcha('#capBox', '#cp'); },
  async login(btn) {
    const body = { login: $('#lg').value.trim(), password: $('#pw').value, captchaId: $('#capBox').dataset.id, captchaText: $('#cp').value.trim() };
    if (!body.login || !body.password) { $('#lerr').innerHTML = `<div style="margin-bottom:12px">${msgBox('err', '', 'Введите логин и пароль')}</div>`; return; }
    if (!body.captchaText) { $('#lerr').innerHTML = `<div style="margin-bottom:12px">${msgBox('err', '', 'Введите код с картинки')}</div>`; return; }
    await busy(btn, async () => {
      try { await POST('/api/auth/login', body); }
      catch (e) {
        $('#lerr').innerHTML = `<div style="margin-bottom:12px">${msgBox('err', '', e.message)}</div>`;
        $('#pw').value = '';
        await loadCaptcha('#capBox', '#cp');
        return;
      }
      await boot();
    });
  },
  async logout() { await POST('/api/auth/logout').catch(() => {}); Staff.me = null; showLogin(); },
  saveCreds,
});
Object.assign(Staff.IN, { pwcheck: () => updatePwRules() });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && ['lg', 'pw', 'cp'].includes(e.target.id)) $('#loginBtn')?.click(); });

window.addEventListener('DOMContentLoaded', () => {
  bindEvents(Staff.ACT, Staff.IN, Staff.CH);
  boot().catch(e => render(`<div class="login-wrap"><div class="login">${msgBox('err', 'Не удалось загрузить кабинет', e.message)}</div></div>`));
});
