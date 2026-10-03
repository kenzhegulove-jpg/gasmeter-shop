#!/bin/sh
# Ежедневное резервное копирование БД (пример для cron: 0 2 * * * /opt/gasmeter/scripts/backup.sh)
# Хранит копии 30 дней.
set -e
DIR=${BACKUP_DIR:-/opt/gasmeter/backups}
mkdir -p "$DIR"
FILE="$DIR/gasmeter_$(date +%Y%m%d_%H%M).sql.gz"
docker compose -f /opt/gasmeter/docker-compose.yml exec -T db pg_dump -U gasmeter gasmeter | gzip > "$FILE"
find "$DIR" -name 'gasmeter_*.sql.gz' -mtime +30 -delete
echo "Создана копия: $FILE"
