# Deploy ZeroInc with Docker

Production-ready deployment using Docker Compose with PostgreSQL.

## Prerequisites

- **Docker** 20.10+ with Compose V2 (`docker compose`)
- **2 GB RAM** minimum (4 GB recommended for multiple agents)
- A server or VPS with a public IP (or localhost for testing)

## Quick Install (One Command)

```bash
curl -fsSL https://raw.githubusercontent.com/agentxagi/zero-inc/master/install.sh | bash
```

This will:
1. Clone the repository
2. Generate secure secrets
3. Build Docker images
4. Start all services
5. Run a health check

Open **http://localhost:3100** when done.

## Manual Setup

### 1. Clone and configure

```bash
git clone https://github.com/agentxagi/zero-inc.git
cd zero-inc
cp .env.example .env
```

### 2. Edit `.env` — set required secrets

```bash
# Generate secrets
openssl rand -base64 32   # paste as BETTER_AUTH_SECRET
openssl rand -base64 24   # paste as POSTGRES_PASSWORD
```

Edit `.env` and set at minimum:

| Variable | Description | Example |
|----------|-------------|---------|
| `BETTER_AUTH_SECRET` | Session signing key (required) | `a1B2c3...` |
| `POSTGRES_PASSWORD` | Database password (required) | `xYz789...` |
| `PAPERCLIP_PUBLIC_URL` | Your public URL | `https://zeroinc.example.com` |

### 3. Start

```bash
docker compose up -d
```

### 4. Verify

```bash
docker compose ps          # both services should be "healthy"
curl http://localhost:3100/api/health
```

## Configuration Reference

See [.env.example](../.env.example) for all variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `BETTER_AUTH_SECRET` | _(required)_ | BetterAuth session signing key |
| `POSTGRES_PASSWORD` | _(required)_ | PostgreSQL password |
| `POSTGRES_USER` | `zeroinc` | PostgreSQL user |
| `POSTGRES_DB` | `zeroinc` | Database name |
| `PAPERCLIP_PUBLIC_URL` | `http://localhost:3100` | External URL for auth callbacks |
| `PAPERCLIP_PORT` | `3100` | Host port |
| `PAPERCLIP_DEPLOYMENT_MODE` | `authenticated` | `authenticated` or `open` |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | `private` or `public` |
| `OPENAI_API_KEY` | _(empty)_ | Required for OpenAI/Codex agents |
| `ANTHROPIC_API_KEY` | _(empty)_ | Required for Claude agents |

## Useful Commands

```bash
# Logs
docker compose logs -f          # all services
docker compose logs -f server   # server only
docker compose logs -f db       # database only

# Management
docker compose ps               # service status
docker compose restart server   # restart server
docker compose down             # stop everything
docker compose up -d            # start again

# Updates
git pull
docker compose build
docker compose up -d

# Database backup
docker compose exec db pg_dump -U zeroinc zeroinc > backup.sql

# Database restore
cat backup.sql | docker compose exec -T db psql -U zeroinc zeroinc
```

## Reverse Proxy (nginx)

For production with HTTPS, put nginx in front:

```nginx
server {
    listen 443 ssl;
    server_name zeroinc.example.com;

    ssl_certificate     /etc/ssl/certs/zeroinc.pem;
    ssl_certificate_key /etc/ssl/private/zeroinc.key;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Remember to set `PAPERCLIP_PUBLIC_URL=https://zeroinc.example.com` in `.env`.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `docker compose build` fails | Ensure Docker has enough disk space (`docker system df`) |
| Server not responding | Check logs: `docker compose logs server` |
| DB connection refused | Ensure `POSTGRES_PASSWORD` in `.env` matches what was used initially |
| Health check fails | On first run, DB migration takes time. Wait 30-60s |
| Port 3100 in use | Change `PAPERCLIP_PORT` in `.env` |
