'use strict';
const test = require('node:test');
const assert = require('node:assert');
const pw = require('../src/security/password');

test('слабые пароли отклоняются', () => {
  assert.ok(pw.validatePassword('short').length);
  assert.ok(pw.validatePassword('alllowercase1!').some(e => e.includes('заглавной')));
  assert.ok(pw.validatePassword('ALLUPPER123!X').some(e => e.includes('строчной')));
  assert.ok(pw.validatePassword('NoDigitsHere!!').some(e => e.includes('цифры')));
  assert.ok(pw.validatePassword('NoSpecial12345').some(e => e.includes('спецсимвола')));
  assert.ok(pw.validatePassword('With Space1!Aa').some(e => e.includes('пробел')));
  assert.ok(pw.validatePassword('Seller.kz#2026', 'seller.kz').some(e => e.includes('логин')));
  assert.ok(pw.validatePassword('Aaa111!!!bbbX').some(e => e.includes('подряд')));
  assert.ok(pw.validatePassword('MyPassword#2026').some(e => e.includes('распространённое')));
});

test('надёжный пароль принимается, в том числе с кириллицей', () => {
  assert.deepStrictEqual(pw.validatePassword('Gaz-Pr0dazha!26', 'admin'), []);
  assert.deepStrictEqual(pw.validatePassword('Счётчик#2026kz', 'seller'), []);
});

test('временный пароль соответствует политике', () => {
  for (let i = 0; i < 50; i++) assert.deepStrictEqual(pw.validatePassword(pw.generatePassword()), []);
});

test('формат логина', () => {
  assert.strictEqual(pw.validateLogin('a.zhumabekov'), null);
  assert.ok(pw.validateLogin('ab'));
  assert.ok(pw.validateLogin('логин'));
});
