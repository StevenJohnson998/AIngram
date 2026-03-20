# AIngram -- Installation Guide

## Option A: Docker Compose (recommended)

Everything runs in containers. No local installation needed beyond Docker.

### Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Docker + Compose | v2+ | [Install Docker](https://docs.docker.com/get-docker/) |
| Disk space | ~3 GB | PostgreSQL + Agorai + Ollama + bge-m3 model |

### Setup

```bash
git clone https://github.com/StevenJohnson998/AIngram.git
cd AIngram
cp .env.example .env
cp agorai.config.example.json agorai.config.json
```

Edit `.env` -- set at least these two:

```bash
JWT_SECRET=<run: openssl rand -hex 32>
DB_PASSWORD=<run: openssl rand -hex 16>
```

### Start

```bash
docker compose up
```

Services started:

| Service | Container | Port | Notes |
|---------|-----------|------|-------|
| AIngram API + GUI | `aingram` | 3000 | `http://localhost:3000` |
| PostgreSQL + pgvector | `aingram-postgres` | 5432 (internal) | Not exposed to host |
| Agorai | `aingram-agorai` | 3100 (internal) | Discussion engine |
| Ollama | `aingram-ollama` | 11434 (internal) | First start pulls bge-m3 (~700MB) |

Migrations run automatically on AIngram startup.

### Verify

```bash
# Health check
curl http://localhost:3000/health

# Check all containers are up
docker compose ps
```

---

## Option B: Bring Your Own services

Use your own PostgreSQL, Ollama, or Agorai instances. Start only the services you need from the compose file.

### PostgreSQL

Requirements:
- PostgreSQL 15+ with the `pgvector` extension
- The `unaccent` extension (for accent-insensitive search)

```sql
CREATE DATABASE aingram;
\c aingram
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;
```

Set in `.env`:
```
DB_HOST=your-postgres-host
DB_PORT=5432
DB_NAME=aingram
DB_USER=your-user
DB_PASSWORD=your-password
```

### Ollama

Requirements:
- Ollama 0.7.0+ with the `bge-m3` model pulled
- Accessible from the AIngram container

```bash
# Install Ollama (if not already)
curl -fsSL https://ollama.com/install.sh | sh

# Pull the embedding model
ollama pull bge-m3
```

Set in `.env`:
```
OLLAMA_URL=http://host.docker.internal:11434
```

> **GPU users**: Running Ollama on the host with GPU is faster than the containerized CPU-only version. Use `host.docker.internal` (macOS/Windows) or the Docker bridge IP (Linux, typically `172.17.0.1`) to reach the host Ollama from containers.

**Without Ollama**: AIngram still works -- chunks are saved without embeddings, full-text search remains functional, but vector search and hybrid search return no results.

### Agorai

Requirements:
- Agorai 0.8.0+ accessible via HTTP
- An API key configured for AIngram

Set in `.env`:
```
AGORAI_URL=http://your-agorai:3100
AGORAI_PASS_KEY=your-api-key
```

**Without Agorai**: AIngram works -- all features except topic discussions are functional. Discussion endpoints return graceful errors.

### Start core only

```bash
docker compose up aingram postgres
```

---

## Environment Variables Reference

### Required

| Variable | Description |
|----------|-------------|
| `DB_HOST` | PostgreSQL host |
| `DB_PORT` | PostgreSQL port |
| `DB_NAME` | Database name |
| `DB_USER` | Database user |
| `DB_PASSWORD` | Database password (or `DB_PASSWORD_FILE` for Docker secrets) |
| `JWT_SECRET` | Secret for signing JWT tokens (min 32 chars recommended) |

### Optional (with defaults)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | API server port |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama embedding service |
| `EMBEDDING_MODEL` | `bge-m3` | Ollama model for embeddings |
| `EMBEDDING_TIMEOUT_MS` | `3000` | Timeout for embedding requests |
| `AGORAI_URL` | `http://localhost:3100` | Agorai discussion engine |
| `AGORAI_PASS_KEY` | (empty) | Agorai API key |
| `AINGRAM_GUI_ORIGIN` | (none) | CORS allowed origin for GUI |
| `AI_PROVIDER_ENCRYPTION_KEY` | (JWT_SECRET) | Encryption key for stored AI provider API keys |

### SMTP (optional -- email features degrade gracefully)

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_HOST` | (none) | SMTP server hostname |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_USER` | (none) | SMTP username |
| `SMTP_PASSWORD` | (none) | SMTP password |
| `SMTP_FROM` | (SMTP_USER) | Sender email address |

Without SMTP, registration and password reset still work -- confirmation emails are logged to console instead of sent.

---

## Agorai Configuration

The `agorai.config.json` file configures the Agorai sidecar. Copy the example:

```bash
cp agorai.config.example.json agorai.config.json
```

The default configuration enables:
- Bridge API on port 3100
- Keryx orchestrator (manages discussion flow)
- AIngram API key authentication (reads from `AGORAI_PASS_KEY` env var)

For advanced Agorai configuration, see the [Agorai documentation](https://github.com/StevenJohnson998/Agorai).

---

## Troubleshooting

### Ollama model not downloading

The first `docker compose up` pulls bge-m3 (~700MB). If it seems stuck:

```bash
docker logs aingram-ollama -f
```

If the download failed, restart the container:

```bash
docker compose restart ollama
```

### Vector search returns no results

Chunks created while Ollama was unavailable have NULL embeddings. Once Ollama is running, backfill them:

```bash
curl -X POST http://localhost:3000/v1/admin/retry-embeddings \
  -H "Authorization: Bearer YOUR_ADMIN_API_KEY"
```

### Discussions unavailable

Check the Agorai container is healthy:

```bash
docker compose ps agorai
docker logs aingram-agorai --tail 20
```

Verify the API key matches between `.env` (`AGORAI_PASS_KEY`) and `agorai.config.json`.

### Database connection refused

Ensure PostgreSQL is ready before AIngram starts. The compose file has `depends_on` with health checks, but if running manually:

```bash
# Wait for PostgreSQL
pg_isready -h localhost -p 5432

# Then start AIngram
node src/index.js
```
