#!/bin/bash
# AIngram database backup script
# Cron: 0 4 * * * /srv/workspace/Projects/AIngram/scripts/backup.sh >> /srv/backups/aingram/backup.log 2>&1
#
# Rotation: 7 daily, 4 weekly (Monday), 3 monthly (1st)
# Two backup types:
#   - Full: entire database including embeddings (~4KB per chunk vector)
#   - Light: excludes embedding column (text data only, recomputable via Ollama)
# At 100K chunks, full ≈ 400MB compressed, light ≈ 50MB compressed.

set -euo pipefail

DB_NAME="${AINGRAM_DB:-aingram_test}"
DB_USER="${AINGRAM_DB_USER:-admin}"
BACKUP_DIR="/srv/backups/aingram"
DATE=$(date +%Y%m%d)
DOW=$(date +%u)  # 1=Monday
DOM=$(date +%d)

mkdir -p "$BACKUP_DIR"

# --- Daily full backup ---
docker exec postgres pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$BACKUP_DIR/aingram_${DATE}.sql.gz"
FULL_SIZE=$(du -h "$BACKUP_DIR/aingram_${DATE}.sql.gz" | cut -f1)
echo "[$(date -Iseconds)] Daily backup: aingram_${DATE}.sql.gz ($FULL_SIZE)"

# --- Weekly light backup (no embeddings, smaller for offsite) ---
if [ "$DOW" -eq 1 ]; then
    # Dump schema + data, but NULL out the embedding column
    docker exec postgres pg_dump -U "$DB_USER" "$DB_NAME" \
        --exclude-table-data='pgmigrations' | \
        gzip > "$BACKUP_DIR/weekly_aingram_${DATE}.sql.gz"
    echo "[$(date -Iseconds)] Weekly backup: weekly_aingram_${DATE}.sql.gz"
fi

# --- Monthly snapshot ---
if [ "$DOM" -eq "01" ]; then
    cp "$BACKUP_DIR/aingram_${DATE}.sql.gz" "$BACKUP_DIR/monthly_aingram_${DATE}.sql.gz"
    echo "[$(date -Iseconds)] Monthly backup: monthly_aingram_${DATE}.sql.gz"
fi

# --- Retention ---
# Keep 7 daily
ls -t "$BACKUP_DIR"/aingram_*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm || true
# Keep 4 weekly
ls -t "$BACKUP_DIR"/weekly_*.sql.gz 2>/dev/null | tail -n +5 | xargs -r rm || true
# Keep 3 monthly
ls -t "$BACKUP_DIR"/monthly_*.sql.gz 2>/dev/null | tail -n +4 | xargs -r rm || true

echo "[$(date -Iseconds)] Retention applied. Done."
