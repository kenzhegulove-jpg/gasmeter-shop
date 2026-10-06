'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const config = require('./config');
const { HttpError } = require('./util');
const { loadUser } = require('./security/session');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.cookieSecure ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());

  // Защита от CSRF: изменяющие запросы к API только из своего фронтенда (плюс SameSite=Strict у cookie)
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/pos/')) return next();
    if (req.get('x-requested-with') !== 'fetch') return next(new HttpError(403, 'Запрос отклонён', 'csrf'));
    next();
  });
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', loadUser);

  app.use('/api', require('./routes/public'));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/seller', require('./routes/seller'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/pos', require('./routes/pos'));
  app.use('/api/receipts', require('./routes/receipts'));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Не найдено')));

  const pub = path.join(__dirname, '..', 'public');
  app.get('/staff', (_req, res) => res.sendFile(path.join(pub, 'staff.html')));
  app.use(express.static(pub, { index: 'index.html', maxAge: config.isProd ? '1h' : 0 }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof multer.MulterError) err = new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? (req.path.includes('/pay') || req.path.includes('/receipt') ? 'Фото чека больше 500 КБ' : 'Файл слишком большой') : 'Ошибка загрузки файла', 'upload');
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Некорректный запрос');
    const status = err.status || 500;
    if (status >= 500) console.error(new Date().toISOString(), req.method, req.originalUrl, err);
    res.status(status).json({ error: status >= 500 ? 'Внутренняя ошибка сервера' : err.message, code: err.code, ...(err.extra || {}) });
  });
  return app;
}
module.exports = { createApp };
