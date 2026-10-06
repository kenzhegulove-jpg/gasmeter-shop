/* Сжатие фото на устройстве (фото кассового чека) */
'use strict';
/**
 * Сжатие фото (например, кассового чека) в JPEG не больше maxBytes.
 * Уменьшает размер стороны до 1600 px, затем подбирает качество и при необходимости уменьшает изображение дальше.
 */
async function compressImage(file, maxBytes = 500 * 1024) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Не удалось открыть фото. Сфотографируйте чек еще раз.')); i.src = url; });
    let scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    for (let attempt = 0; attempt < 8; attempt++) {
      const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
      for (const q of [0.85, 0.75, 0.65, 0.55, 0.45]) {
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
        if (blob && blob.size <= maxBytes) return blob;
      }
      scale *= 0.75;
    }
    throw new Error('Не удалось сжать фото до 500 КБ');
  } finally { URL.revokeObjectURL(url); }
}
