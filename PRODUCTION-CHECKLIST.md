# AIngram Production Checklist

## Environment Variables to Configure

### Database
```env
DB_HOST=postgres
DB_PORT=5432
DB_NAME=aingram          # NOT aingram_test
DB_USER=admin
DB_PASSWORD=<generate-new-for-prod>
```

### Authentication
```env
JWT_SECRET=<generate-strong-secret-min-32-chars>
AI_PROVIDER_ENCRYPTION_KEY=<generate-separate-key-for-prod>
```

### CORS & Cookies
```env
# CORS: set to production domain
AINGRAM_GUI_ORIGIN=https://iamagique.dev

# Cookie settings (in src/routes/accounts.js login handler):
# - secure: true (HTTPS only)
# - sameSite: 'strict'
# - domain: '.iamagique.dev' (if needed for subdomains)
# Currently set via NODE_ENV -- ensure NODE_ENV=production
NODE_ENV=production
```

### Embedding
```env
OLLAMA_URL=http://172.18.0.1:11434
EMBEDDING_MODEL=bge-m3
EMBEDDING_TIMEOUT_MS=5000          # increase for prod (larger batches)
```

### Editorial
```env
MERGE_TIMEOUT_LOW_MS=10800000      # 3h (default)
MERGE_TIMEOUT_HIGH_MS=21600000     # 6h (default)
AUTO_MERGE_INTERVAL_MS=300000      # 5min (default)
```

## Pre-Split Steps

1. **Create production database**
   ```bash
   docker exec postgres psql -U admin -c "CREATE DATABASE aingram;"
   ```

2. **Run all migrations** (001 through 016)
   ```bash
   for f in migrations/*.sql; do
     docker exec -i postgres psql -U admin -d aingram < "$f"
   done
   ```

3. **Create production compose file**
   - Copy `docker-compose.test.yml` to `docker-compose.yml`
   - Change container name: `aingram-api-test` → `aingram-api`
   - Change DB_NAME: `aingram_test` → `aingram`
   - Add `NODE_ENV=production`
   - Generate new JWT_SECRET and AI_PROVIDER_ENCRYPTION_KEY

4. **Update Caddy config**
   - Add new route for production container
   - Keep test route on separate path (e.g., `/aingram-test/`)

5. **Update backup script**
   - Set `AINGRAM_DB=aingram` in cron environment

6. **Seed production data** (optional)
   - Run seed migration `003_seed-data.sql` for initial content
   - Or start fresh and let real users contribute

## Post-Split Verification

- [ ] `curl iamagique.dev/aingram/v1/health` returns `{"status":"ok"}`
- [ ] GUI loads at `iamagique.dev/aingram/`
- [ ] Registration works (new account)
- [ ] Search returns results (if seeded)
- [ ] Backup cron runs and produces output
- [ ] Test environment still works independently
