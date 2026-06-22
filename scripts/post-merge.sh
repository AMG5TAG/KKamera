#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Apply committed versioned migrations (the same mechanism prod runs on startup),
# so the dev DB stays in lockstep with lib/db/drizzle rather than drifting via push.
pnpm --filter db migrate
