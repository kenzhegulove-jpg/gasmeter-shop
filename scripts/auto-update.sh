#!/bin/bash
# Автообновление сайта из GitHub: ставит последнюю версию (тег vX.Y.Z), если она новее текущей.
# Запускается таймером systemd каждые 5 минут (deploy/gasmeter-update.timer).
#   scripts/auto-update.sh          — обновить, если сейчас окно обновлений (по умолчанию 20:00–08:00)
#   scripts/auto-update.sh --now    — обновить сразу, без учёта окна (срочное исправление)
#   scripts/auto-update.sh v1.2.0   — установить указанную версию (в т.ч. откат на старую)
# Перед обновлением делается резервная копия БД; если сайт после обновления не отвечает —
# автоматический возврат на предыдущую версию.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/gasmeter}"
WINDOW_START="${UPDATE_WINDOW_START:-20}"   # час начала окна обновлений
WINDOW_END="${UPDATE_WINDOW_END:-8}"        # час окончания окна
HEALTH_URL="http://127.0.0.1:3000/api/health"
LOG_DIR="$APP_DIR/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/update.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG"; }

# Не запускать два обновления одновременно
exec 9>"$LOG_DIR/update.lock"
flock -n 9 || exit 0

cd "$APP_DIR"
git fetch --quiet --tags --force origin

ARG="${1:-}"
if [[ "$ARG" =~ ^v[0-9] ]]; then
  TARGET="$ARG"
  git rev-parse --quiet --verify "refs/tags/$TARGET" >/dev/null || { log "Версия $TARGET не найдена"; exit 1; }
else
  TARGET="$(git tag -l 'v[0-9]*' --sort=-v:refname | head -n1)"
fi
[ -n "$TARGET" ] || exit 0

CURRENT="$(git describe --tags --exact-match 2>/dev/null || echo "без версии")"
[ "$TARGET" = "$CURRENT" ] && exit 0

# Версию, которая уже не запустилась, автоматически повторно не ставим (только явно: auto-update.sh vX.Y.Z)
FAILED="$LOG_DIR/failed-versions"
if [ -z "$ARG" ] || [ "$ARG" = "--now" ]; then
  if [ -f "$FAILED" ] && grep -qx "$TARGET" "$FAILED"; then exit 0; fi
fi

if [ -z "$ARG" ]; then
  HOUR=$((10#$(date +%H)))
  if [ "$WINDOW_START" -gt "$WINDOW_END" ]; then
    { [ "$HOUR" -ge "$WINDOW_START" ] || [ "$HOUR" -lt "$WINDOW_END" ]; } || exit 0
  else
    { [ "$HOUR" -ge "$WINDOW_START" ] && [ "$HOUR" -lt "$WINDOW_END" ]; } || exit 0
  fi
fi

PREV_COMMIT="$(git rev-parse HEAD)"
log "Обновление: $CURRENT → $TARGET"

log "Резервная копия базы перед обновлением"
"$APP_DIR/scripts/backup.sh" >>"$LOG" 2>&1 || { log "ОШИБКА: резервная копия не создана, обновление отменено"; exit 1; }

deploy() {
  git checkout --quiet --force "$1"
  docker compose up -d --build >>"$LOG" 2>&1
}
healthy() {
  for _ in $(seq 1 30); do
    curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1 && return 0
    sleep 5
  done
  return 1
}

if deploy "$TARGET" && healthy; then
  docker image prune -f >/dev/null 2>&1 || true
  if [ -f "$FAILED" ]; then sed -i "/^${TARGET//./\\.}\$/d" "$FAILED"; fi
  log "Готово: работает версия $TARGET"
else
  echo "$TARGET" >>"$FAILED"
  log "ОШИБКА: версия $TARGET не запустилась, возврат на $CURRENT ($PREV_COMMIT). Повторно автоматически ставиться не будет."
  deploy "$PREV_COMMIT" || true
  if healthy; then log "Возврат выполнен, работает $CURRENT"; else log "КРИТИЧНО: сайт не отвечает и после возврата — требуется вмешательство"; fi
  exit 1
fi
