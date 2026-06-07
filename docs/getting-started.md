# Getting started

Bring up the backing services — **Medplum** (FHIR system of record, `:8103`), the
**Medplum app** (web UI, `:3005`), and **Watchman** (identity index, `:8084`) — on
your machine.

These run as Docker containers; **PostgreSQL and Redis run natively on the host**
and the containers reach them via `host.docker.internal`. Server config is a
mounted file: [`config/medplum.config.json`](../config/medplum.config.json). The
web UI needs no config — its image is built with the API URL pointed at
`http://localhost:8103/`.

## Prerequisites

- **Docker** (Docker Desktop, OrbStack, or colima). On a low-RAM machine, cap
  Docker's memory at ~2–3 GB (Docker Desktop → Settings → Resources) — the stack
  fits comfortably (~1.3 GB in use).
- **Bun** (for the `atomic-healthcare` CLI).
- **PostgreSQL** running natively on `:5432` (e.g. `brew install postgresql@17 && brew services start postgresql@17`).
- **Redis** running natively on `:6379` (e.g. `brew install redis`).

## One-time host setup

The containers expect a password-protected Redis and a `medplum` database. Do this
once per machine.

**1. Redis password.** Medplum authenticates to Redis with the password `medplum`,
so native Redis must require one. Add to `redis.conf` (Homebrew:
`/opt/homebrew/etc/redis.conf`):

```
requirepass medplum
```

Then `brew services restart redis`. Verify: `redis-cli -a medplum ping` → `PONG`.

**2. Postgres role + database.** As your Postgres superuser:

```sql
CREATE ROLE medplum LOGIN SUPERUSER PASSWORD 'medplum';
CREATE DATABASE medplum OWNER medplum;
\c medplum
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
```

Verify: `PGPASSWORD=medplum psql -h localhost -U medplum -d medplum -c '\conninfo'`.

> `SUPERUSER` is for local convenience (lets Medplum manage extensions without
> friction). Tighten for any shared/real deployment.

## Run

```bash
bun install
make run-backing-services        # Medplum + Watchman; blocks until both are healthy
```

First boot runs Medplum's migrations (~a minute). The target waits on container
healthchecks, so when it returns, the stack is ready.

## Verify

```bash
curl http://localhost:8103/healthcheck      # {"ok":true,"postgres":true,"redis":true}
curl -o /dev/null -w '%{http_code}\n' http://localhost:8084/ping   # 200
```

**Log in as an employee** (the default super-admin created on first boot):

```bash
curl -X POST http://localhost:8103/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"medplum_admin"}'
```

A `login` id + `code` in the response means the credentials are valid.

**Or log in via the web UI:** open **http://localhost:3005** (the Medplum app,
started as part of `run-backing-services`) and sign in with the same credentials.

> A dedicated non-admin **staff** login (a `Practitioner` user with a scoped
> AccessPolicy) is a follow-up — create it from the app: Project Admin → invite.

## Manage

```bash
make status                 # container status + health
make logs                   # follow logs
make stop-backing-services  # stop and remove containers (host pg/redis untouched)
make run-backing-services PROFILE=mail   # also start the mail catcher (mailpit :8025)
```

Data lives in the host's Postgres (`medplum` db) and a named Docker volume
(`medplum_binary`), so it survives container restarts.
