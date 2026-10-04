'use strict';
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { shortName, fmtMoney, noticeText } = require('./util');
const { regionName } = require('./regions');

const FONT = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf');
const FONT_B = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');
const fmtDT = (d, lang) => new Date(d).toLocaleString(lang === 'kk' ? 'kk-KZ' : 'ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const qrPayload = o => `QGA:${o.num}:${o.token}`;

const PDF_TEXT = {
  ru: {
    title: n => `Заказ № ${n}`,
    created: (a, b) => `Оформлен ${a}. Оплатить до ${b} — после этого заказ отменяется.`,
    qr: 'Покажите QR-код на кассе при оплате и продавцу при получении счётчика. Возьмите с собой удостоверение личности. Если счётчик получает представитель — нужна доверенность.',
    product: 'Товар', price: 'Цена', priceVal: p => `${p} тенге с НДС`, owner: 'Владелец ТУ', tu: 'Номер ТУ', addr: 'Адрес установки', point: 'Точка выдачи',
  },
  kk: {
    title: n => `№ ${n} тапсырыс`,
    created: (a, b) => `Рәсімделген уақыты: ${a}. ${b} дейін төлеңіз, одан кейін тапсырыс жойылады.`,
    qr: 'Төлеу кезінде кассада және есептегішті алу кезінде сатушыға QR-кодты көрсетіңіз. Өзіңізбен бірге жеке куәлігіңізді алыңыз. Егер есептегішті өкіл алса, сенімхат қажет.',
    product: 'Тауар', price: 'Баға', priceVal: p => `${p} теңге, ҚҚС-пен`, owner: 'ТШ иесі', tu: 'ТШ нөмірі', addr: 'Орнату мекенжайы', point: 'Беру нүктесі',
  },
};

/** PDF заказа: номер, QR-код, состав, точка выдачи, текст уведомления. lang: 'ru' | 'kk' */
async function orderPdf(o, lang = 'ru') {
  if (lang !== 'kk') lang = 'ru';
  const L = PDF_TEXT[lang];
  const qr = await QRCode.toBuffer(qrPayload(o), { errorCorrectionLevel: 'M', margin: 1, width: 360 });
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: L.title(o.num) } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('r', FONT).registerFont('b', FONT_B);

    doc.font('b').fontSize(22).fillColor('#17212B').text(L.title(o.num));
    doc.font('r').fontSize(10).fillColor('#67737D').text(L.created(fmtDT(o.created_at, lang), fmtDT(o.expires_at, lang)));
    doc.moveDown(0.8);
    const y = doc.y;
    doc.image(qr, 50, y, { width: 170 });
    doc.font('r').fontSize(10).fillColor('#17212B').text(L.qr, 240, y + 10, { width: 300 });
    doc.y = y + 185;
    doc.x = 50;

    const rows = [
      [L.product, o.product_name],
      [L.price, L.priceVal(fmtMoney(o.price))],
      [L.owner, shortName(o.owner_name, o.is_legal)],
      [L.tu, o.tu_number],
      [L.addr, o.address],
      [L.point, `${regionName(o.point_region, lang)}, ${o.point_address}${o.point_hours ? ', ' + o.point_hours : ''}`],
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
    const text = noticeText(o, lang);
    const h = doc.font('r').fontSize(10).heightOfString(text, { width: 475 }) + 20;
    doc.roundedRect(50, ny, 495, h, 6).strokeColor('#C98A06').lineWidth(1).stroke();
    doc.fillColor('#17212B').text(text, 60, ny + 10, { width: 475 });
    doc.end();
  });
}

const orderQrSvg = o => QRCode.toString(qrPayload(o), { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#17212B', light: '#FFFFFF' } });

module.exports = { orderPdf, orderQrSvg, qrPayload };
