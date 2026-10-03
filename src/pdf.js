'use strict';
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { shortName, fmtMoney, noticeText } = require('./util');

const FONT = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf');
const FONT_B = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');
const fmtDT = d => new Date(d).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const qrPayload = o => `QGA:${o.num}:${o.token}`;

/** PDF заказа: номер, QR-код, состав, точка выдачи, текст уведомления */
async function orderPdf(o) {
  const qr = await QRCode.toBuffer(qrPayload(o), { errorCorrectionLevel: 'M', margin: 1, width: 360 });
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Заказ № ${o.num}` } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('r', FONT).registerFont('b', FONT_B);

    doc.font('b').fontSize(22).fillColor('#17212B').text(`Заказ № ${o.num}`);
    doc.font('r').fontSize(10).fillColor('#67737D').text(`Оформлен ${fmtDT(o.created_at)}. Оплатить до ${fmtDT(o.expires_at)} — после этого заказ отменяется.`);
    doc.moveDown(0.8);
    const y = doc.y;
    doc.image(qr, 50, y, { width: 170 });
    doc.font('r').fontSize(10).fillColor('#17212B').text('Покажите QR-код на кассе при оплате и продавцу при получении счётчика. Возьмите с собой удостоверение личности. Если счётчик получает представитель — нужна доверенность.', 240, y + 10, { width: 300 });
    doc.y = y + 185;
    doc.x = 50;

    const rows = [
      ['Товар', o.product_name],
      ['Цена', `${fmtMoney(o.price)} тенге с НДС`],
      ['Владелец ТУ', shortName(o.owner_name, o.is_legal)],
      ['Номер ТУ', o.tu_number],
      ['Адрес установки', o.address],
      ['Точка выдачи', `${o.point_region}, ${o.point_address}${o.point_hours ? ', ' + o.point_hours : ''}`],
    ];
    for (const [k, v] of rows) {
      const top = doc.y;
      doc.font('r').fontSize(10).fillColor('#67737D').text(k, 50, top, { width: 130 });
      doc.font('r').fontSize(11).fillColor('#17212B').text(v, 190, top, { width: 355 });
      doc.y = Math.max(doc.y, top + 14) + 6;
      doc.moveTo(50, doc.y - 3).lineTo(545, doc.y - 3).strokeColor('#E3E7EA').lineWidth(0.5).stroke();
    }
    doc.moveDown(1);
    const ny = doc.y;
    const text = noticeText(o);
    const h = doc.font('r').fontSize(10).heightOfString(text, { width: 475 }) + 20;
    doc.roundedRect(50, ny, 495, h, 6).strokeColor('#C98A06').lineWidth(1).stroke();
    doc.fillColor('#17212B').text(text, 60, ny + 10, { width: 475 });
    doc.end();
  });
}

const orderQrSvg = o => QRCode.toString(qrPayload(o), { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#17212B', light: '#FFFFFF' } });

module.exports = { orderPdf, orderQrSvg, qrPayload };
