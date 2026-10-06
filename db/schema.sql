-- Схема БД сайта контролируемой продажи счётчиков газа.
-- Скрипт идемпотентен: выполняется при каждом запуске сервера.

CREATE TABLE IF NOT EXISTS points (
  id          serial PRIMARY KEY,
  region      text NOT NULL,
  address     text NOT NULL,
  hours       text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id                   serial PRIMARY KEY,
  role                 text NOT NULL CHECK (role IN ('admin', 'seller')),
  full_name            text NOT NULL,
  login                text NOT NULL,
  password_hash        text NOT NULL,
  point_id             int REFERENCES points(id),
  blocked              boolean NOT NULL DEFAULT false,
  must_change_password boolean NOT NULL DEFAULT true,
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  failed_logins        int NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_has_point CHECK (role = 'admin' OR point_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS users_login_uq ON users (lower(login));

CREATE TABLE IF NOT EXISTS password_history (
  id            bigserial PRIMARY KEY,
  user_id       int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_history_user ON password_history (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   text PRIMARY KEY,
  user_id      int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text
);

CREATE TABLE IF NOT EXISTS products (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  price       numeric(12,2) NOT NULL CHECK (price > 0),
  specs       jsonb NOT NULL DEFAULT '[]',
  active      boolean NOT NULL DEFAULT true,
  sort        int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_photos (
  id         serial PRIMARY KEY,
  product_id int NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  position   int NOT NULL CHECK (position BETWEEN 0 AND 3),
  mime       text NOT NULL,
  data       bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, position)
);

CREATE TABLE IF NOT EXISTS tu_imports (
  id          serial PRIMARY KEY,
  user_id     int REFERENCES users(id),
  folder      text,
  files       int NOT NULL DEFAULT 0,
  rows_read   int NOT NULL DEFAULT 0,
  added       int NOT NULL DEFAULT 0,
  duplicates  int NOT NULL DEFAULT 0,
  errors      int NOT NULL DEFAULT 0,
  details     jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tu_records (
  tu_number   text PRIMARY KEY,
  tu_last6    char(6) NOT NULL,
  iin         char(12) NOT NULL,
  owner_name  text NOT NULL,
  address     text NOT NULL,
  branch      text NOT NULL DEFAULT '',
  issued_at   timestamptz,
  gas_flow    numeric(14,3),
  is_legal    boolean NOT NULL DEFAULT false,
  source_file text,
  import_id   int REFERENCES tu_imports(id),
  loaded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tu_records_iin_last6 ON tu_records (iin, tu_last6);
CREATE INDEX IF NOT EXISTS tu_records_loaded ON tu_records (loaded_at DESC);

CREATE SEQUENCE IF NOT EXISTS order_num_seq START 100001;

CREATE TABLE IF NOT EXISTS orders (
  num            bigint PRIMARY KEY DEFAULT nextval('order_num_seq'),
  token          text NOT NULL,
  product_id     int NOT NULL REFERENCES products(id),
  product_name   text NOT NULL,
  tu_number      text NOT NULL REFERENCES tu_records(tu_number),
  point_id       int NOT NULL REFERENCES points(id),
  price          numeric(12,2) NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending', 'paid', 'issued', 'returned', 'cancelled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  buyer_ip       text,
  paid_at        timestamptz,
  paid_by        int REFERENCES users(id),
  paid_source    text,
  receipt_number text,
  issued_at      timestamptz,
  issued_by      int REFERENCES users(id),
  serial_number  text,
  recipient      text CHECK (recipient IN ('owner', 'proxy')),
  proxy_number   text,
  proxy_date     date,
  proxy_iin      char(12),
  checklist      jsonb,
  returned_at    timestamptz,
  returned_by    int REFERENCES users(id),
  return_reason  text,
  return_comment text,
  cancelled_at   timestamptz
);
-- Правило «одно ТУ — один счётчик»: не более одного активного заказа на ТУ.
CREATE UNIQUE INDEX IF NOT EXISTS orders_one_active_per_tu ON orders (tu_number) WHERE status IN ('pending', 'paid', 'issued');
-- Один серийный номер не может числиться выданным дважды.
CREATE UNIQUE INDEX IF NOT EXISTS orders_serial_issued ON orders (upper(serial_number)) WHERE status = 'issued';
CREATE INDEX IF NOT EXISTS orders_status_created ON orders (status, created_at);
CREATE INDEX IF NOT EXISTS orders_point ON orders (point_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_created ON orders (created_at DESC);

-- Счётчики неудачных попыток и блокировки (проверка покупателя, вход сотрудников).
CREATE TABLE IF NOT EXISTS attempt_locks (
  kind         text NOT NULL,
  key          text NOT NULL,
  failed       int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, key)
);

CREATE TABLE IF NOT EXISTS check_log (
  id         bigserial PRIMARY KEY,
  iin        text,
  ip         text,
  result     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS check_log_created ON check_log (created_at DESC);

CREATE TABLE IF NOT EXISTS captchas (
  id          uuid PRIMARY KEY,
  answer_hash text NOT NULL,
  expires_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial PRIMARY KEY,
  user_id    int REFERENCES users(id),
  action     text NOT NULL,
  entity     text,
  entity_id  text,
  details    jsonb,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log (created_at DESC);

-- ===== v1.2.0: настройки, остатки по точкам, реестр продаж =====

-- Настройки, которые администратор меняет в кабинете (ключ → значение)
CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by int REFERENCES users(id)
);

-- Остаток товара на точке (физически на складе точки, включая забронированные)
CREATE TABLE IF NOT EXISTS stock (
  point_id   int NOT NULL REFERENCES points(id),
  product_id int NOT NULL REFERENCES products(id),
  on_hand    int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (point_id, product_id)
);

-- Движение остатков: приход, корректировка, выдача, возврат
CREATE TABLE IF NOT EXISTS stock_moves (
  id         bigserial PRIMARY KEY,
  point_id   int NOT NULL REFERENCES points(id),
  product_id int NOT NULL REFERENCES products(id),
  delta      int NOT NULL,
  balance    int NOT NULL,
  reason     text NOT NULL CHECK (reason IN ('receipt', 'correction', 'issue', 'return')),
  order_num  bigint,
  user_id    int REFERENCES users(id),
  comment    text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_moves_created ON stock_moves (created_at DESC);
CREATE INDEX IF NOT EXISTS stock_moves_order ON stock_moves (order_num) WHERE order_num IS NOT NULL;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS return_to_stock boolean;
CREATE INDEX IF NOT EXISTS orders_issued_at ON orders (issued_at DESC) WHERE issued_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_point_product_active ON orders (point_id, product_id) WHERE status IN ('pending', 'paid');

-- ===== v1.3.0: роль «Финансист», фото кассового чека =====
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'seller', 'finance'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS seller_has_point;
ALTER TABLE users ADD CONSTRAINT seller_has_point CHECK (role <> 'seller' OR point_id IS NOT NULL);

-- Фото кассового чека (JPEG не более 500 КБ), одно на заказ
CREATE TABLE IF NOT EXISTS receipt_photos (
  order_num   bigint PRIMARY KEY REFERENCES orders(num),
  mime        text NOT NULL,
  data        bytea NOT NULL,
  size        int NOT NULL,
  uploaded_by int REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
