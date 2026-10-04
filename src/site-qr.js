'use strict';
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const config = require('./config');
const { fmtMinutes } = require('./util');

/**
 * Постоянный QR-код сайта: ссылка зашита прямо в код, без сервисов-сокращателей и переадресаций.
 * Код не истекает и не показывает рекламу; меняется только вместе с адресом сайта.
 */
const OPTS = { errorCorrectionLevel: 'H', margin: 2 };
const siteQrSvg = url => QRCode.toString(url, { ...OPTS, type: 'svg', color: { dark: '#000000', light: '#FFFFFF' } });
const siteQrPng = url => QRCode.toBuffer(url, { ...OPTS, width: 2000, color: { dark: '#000000', light: '#FFFFFF' } });

/** Плакат A4 для точки продаж: заголовок, QR-код, адрес сайта и порядок покупки */
async function siteQrPoster(url) {
  const qr = await QRCode.toBuffer(url, { ...OPTS, width: 1200 });
  const F = path.join(__dirname, '..', 'assets', 'fonts');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'QR-код сайта' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
    doc.registerFont('r', path.join(F, 'DejaVuSans.ttf')).registerFont('b', path.join(F, 'DejaVuSans-Bold.ttf'));
    const W = doc.page.width;
    doc.rect(0, 0, W, 150).fill('#0ABAB5');
    doc.fillColor('#FFFFFF').font('b').fontSize(30).text('Счетчики газа', 50, 40, { width: W - 100, align: 'center' });
    doc.font('r').fontSize(16).text('по специальной цене для населения', 50, 85, { width: W - 100, align: 'center' });
    const size = 330;
    doc.image(qr, (W - size) / 2, 190, { width: size });
    doc.fillColor('#17212B').font('b').fontSize(22).text(url.replace(/^https?:\/\//, ''), 50, 540, { width: W - 100, align: 'center' });
    doc.font('r').fontSize(13).fillColor('#67737D').text('Наведите камеру телефона на QR-код', 50, 575, { width: W - 100, align: 'center' });
    const steps = ['Выберите счетчик на сайте', 'Введите ИИН владельца ТУ и последние 6 цифр номера ТУ', 'Выберите эту точку выдачи и оформите заказ', 'Оплатите на кассе по QR-коду заказа и получите счетчик'];
    let y = 615;
    steps.forEach((s, i) => {
      doc.circle(95, y + 9, 13).fill('#0ABAB5');
      doc.fillColor('#FFFFFF').font('b').fontSize(13).text(String(i + 1), 82, y + 2, { width: 26, align: 'center' });
      doc.fillColor('#17212B').font('r').fontSize(14).text(s, 120, y, { width: W - 170 });
      y += 46;
    });
    doc.font('r').fontSize(10).fillColor('#67737D').text(`Возьмите с собой удостоверение личности. Неоплаченный заказ отменяется через ${fmtMinutes(config.orderTtlMin)}.`, 50, 805, { width: W - 100, align: 'center' });
    doc.end();
  });
}

module.exports = { siteQrSvg, siteQrPng, siteQrPoster };
