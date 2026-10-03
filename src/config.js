'use strict';
try { process.loadEnvFile(); } catch { /* .env не обязателен */ }

const env = process.env;
const isProd = env.NODE_ENV === 'production';

const config = {
  isProd,
  // Только для автотестов: капча принимает код TEST. В production не включается.
  testMode: env.NODE_ENV === 'test',
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL || 'postgres://gm:gm@localhost:5432/gasmeter',
  secret: env.APP_SECRET || '',
  trustProxy: env.TRUST_PROXY || 'loopback',
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,

  // Срок брони неоплаченного заказа, минут (по умолчанию 2 часа)
  orderTtlMin: Number(env.ORDER_TTL_MIN || 120),

  // Проверка покупателя (ИИН + последние 6 цифр номера ТУ)
  check: { iinMaxFails: 5, ipMaxFails: Number(env.CHECK_IP_MAX_FAILS || 30), lockMin: 60, ticketMin: 15 },

  // Вход сотрудников
  login: { maxFails: 5, ipMaxFails: Number(env.LOGIN_IP_MAX_FAILS || 30), lockMin: 60, sessionHours: 10, idleMin: 60 },

  // Политика паролей
  password: {
    minLength: Number(env.PASSWORD_MIN_LENGTH || 10),
    maxLength: 64,
    history: 3,
    maxAgeDays: Number(env.PASSWORD_MAX_AGE_DAYS || 90),
    bcryptCost: 12,
  },

  // Открытые вопросы ТЗ (раздел 12) — настраиваются без изменения кода
  allowLegalEntities: env.ALLOW_LEGAL_ENTITIES !== 'false',
  maxGasFlow: env.MAX_GAS_FLOW ? Number(env.MAX_GAS_FLOW) : null,

  posApiKey: env.POS_API_KEY || '',

  admin: { login: env.ADMIN_LOGIN || 'admin', password: env.ADMIN_INITIAL_PASSWORD || '' },
};

if (!config.secret || config.secret.length < 32) {
  if (isProd) throw new Error('APP_SECRET должен быть задан (не менее 32 символов)');
  config.secret = 'dev-secret-do-not-use-in-production-0123456789';
}

module.exports = config;
