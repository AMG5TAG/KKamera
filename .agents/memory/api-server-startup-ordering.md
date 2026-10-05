---
name: API server startup ordering — listen before migrations
description: Why the API server must call app.listen() before awaiting DB migrations, and what production failure it prevents.
---

## The Rule

`app.listen(port)` must be called **before** `await runAppMigrations()` in `artifacts/api-server/src/index.ts`.

## Why

The autoscale (Cloud Run) deployer waits ~60 seconds for the container to open its ports. If `app.listen()` is called after migrations, and the production DB connection is slow to establish (cold-start latency, pg pool handshake), the process never binds to port 8080 within the timeout. The deployer kills the process (`SIGTERM`), no port opens, and the deployment fails with "not all artifact ports opened within timeout".

Symptoms: 
- `not all artifact ports opened within timeout expected=[8080 24623] detected=1`
- Zero log output from the API server (crash before pino logs)
- `healthcheck /api returned status 500` (proxy returns 500 because nothing listens on 8080)

## How to Apply

The current `artifacts/api-server/src/index.ts` already has the correct ordering:
```
app.listen(port, callback);           // bind immediately — health check passes
runAppMigrations().catch(logError);   // run migrations in background
```

Migrations are idempotent and guarded by a Postgres advisory lock. Brief window where schema might not be fully up to date is acceptable vs. deployment failing every time.

## Also Fixed

`lib/db/src/index.ts` — added `connectionTimeoutMillis: 10_000` to the pg Pool so a slow DB fails fast (10s) instead of hanging indefinitely.
