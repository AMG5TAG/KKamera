# KKamera

A subscription-based native camera app (iOS/Android) that directly uploads photos and videos to FTP, WebDAV, Nextcloud, Google Drive, OneDrive, and Dropbox.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (local 8080 → external :8080 on the dev domain)
- `pnpm --filter @workspace/kkamera run dev` — run the Expo app (web on port from $PORT env; API base URL is `https://$REPLIT_DEV_DOMAIN:8080` via EXPO_PUBLIC_DOMAIN)
- The native apps are built and submitted via EAS (`eas build` / `eas submit`, config in `artifacts/kkamera/eas.json`). The API server is JSON-only and does not serve any web/app HTML.
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run test` — run unit tests (api-server: Node 24 native TS + `node:test`, no extra deps; pure security/billing logic in `artifacts/api-server/test/`)
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- DB schema changes: edit `lib/db/src/schema/`, then `pnpm --filter @workspace/db run generate` to create a versioned migration in `lib/db/drizzle/` (commit it). Migrations auto-apply on API server startup (and via the post-merge hook); `pnpm --filter @workspace/db run migrate` applies them manually. `pnpm --filter @workspace/db run push` remains for throwaway local experiments only — real changes must be a committed migration.
- Required env: `DATABASE_URL` — Postgres connection string
- Required env: `SESSION_SECRET` — JWT signing secret; the AES-256 cloud-credential key is HKDF-derived from it (separate key, ≥32 chars enforced at boot)
- Required env (production): `RESEND_API_KEY` — all outbound email via Resend (no-ops with a warning if unset); optional `EMAIL_FROM` overrides the default `KKamera <noreply@kkamera.app>` sender (domain must be verified in Resend)
- Optional env: `APP_URL` — canonical public origin for OAuth callbacks and email links (defaults to `https://app.kkamera.app`; never the Replit domain)
- Optional env: `PAST_DUE_GRACE_DAYS` — days a past_due subscription keeps access past its last paid period before being blocked (default 14)
- Optional env: OAuth provider creds `GOOGLE_*`/`ONEDRIVE_*`/`DROPBOX_CLIENT_ID|SECRET` for cloud connections
- Required env (native IAP): `REVENUECAT_WEBHOOK_AUTH` (secret) — shared secret the RevenueCat dashboard sends in the webhook `Authorization` header. `POST /api/revenuecat/webhook` fails closed (503) if unset. This is what mirrors App Store / Play subscriptions into `subscriptionsTable`; without it native IAP subscribers get 402 on upload after their trial. The client must call `Purchases.logIn(userId)` (done in `lib/revenuecat.tsx`) so `app_user_id` maps to our numeric userId.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Mobile/Web: Expo (Expo Router 6), React Native
- Billing: App Store / Play in-app purchases via RevenueCat (server mirror through the RevenueCat webhook)

## Where things live

- `artifacts/api-server/` — Express 5 API server
- `artifacts/kkamera/` — Expo app (iOS, Android)
- `lib/db/` — Drizzle schema + migrations (source of truth: `lib/db/src/schema/`)
- `lib/api-spec/` — OpenAPI spec (`openapi.yaml`) + codegen output
- `lib/api-client-react/` — generated React Query hooks + Zod schemas

## Architecture decisions

- JWT-based auth (bcrypt passwords, optional TOTP 2FA via otplib, QR code via qrcode); a 401 from any request signals the client to clear its session
- Cloud connection credentials stored AES-256-GCM encrypted in DB (key HKDF-derived from `SESSION_SECRET`, separate from the JWT secret); legacy raw-key GCM and CBC values still decrypt
- OAuth connect flow uses stateless signed-JWT state with the PKCE verifier encrypted inside it (autoscale-safe, no in-memory store)
- Express runs with `trust proxy` (required behind Replit's proxy for per-client rate limiting)

### Security model (don't regress)
- **SSRF guard** (`lib/ssrf.ts` + `cloudUpload.ts`): user-supplied FTP/WebDAV/Nextcloud hosts are validated against private/loopback/link-local/IPv4-mapped-IPv6 ranges, the resolved IP is pinned (FTP) or re-validated at connect on every redirect (WebDAV agent). Keep this on any new outbound request to a user-controlled host.
- **RevenueCat webhook** (`routes/revenuecat.ts`): shared-secret authenticated (fails closed without `REVENUECAT_WEBHOOK_AUTH`); mirrors IAP entitlements into `subscriptionsTable`; referral milestones are idempotent + row-locked; period-end writes are forward-only (`GREATEST`); stale future-dated EXPIRATION events are ignored.
- **CSP** is enabled and **CORS** allows only the app host (no cookies — bearer only). HTML interpolated into emails goes through `escapeHtml`; upload filenames through `sanitizeFileName`.
- Security/billing pure logic is unit-tested (`artifacts/api-server/test/`) — extend the tests when changing it.
- Production deployment is an API-only server (`/api`); the native apps ship via EAS and talk to it
- Affiliate programme: 5 successful referral signups = 1 free year added to subscription
- App Store / Play in-app purchases (via RevenueCat) handle subscription billing (14-day trial → $25/year)
- Offline upload queue (in-app retry with backoff)

## Product

- Apple Camera-style UI with brand colours #b19870 (primary) and #c3b091 (secondary)
- Dark theme (#0d0b08 background) throughout
- 6-step onboarding wizard (profile → cloud → permissions → plan → affiliate → done)
- Camera screen with photo/video capture and direct cloud upload
- Settings: cloud connections, subscription, 2FA security, affiliate dashboard, feedback

## User preferences

- Brand colours: #b19870 (primary/gold), #c3b091 (secondary)
- Dark background: #0d0b08
- iOS/Android target — Expo managed workflow
- Subscription: 14-day trial then $25/year via App Store / Play (RevenueCat)
- Affiliate: 5 referrals = 1 free year

## Gotchas

- Google Fonts (via `@expo-google-fonts/inter`) may not load in Replit sandbox. Do not block rendering on font load.
- `Platform.OS` can be used at module level safely in Expo Metro bundles.
- API server uses path `/api` — all routes must start with `/api`.
- **Pnpm + Metro stale hash**: `metro.config.js` patches `server.unstable_serverRoot` to the project root (not workspace root) and includes a resolver interceptor that rewrites stale pnpm-hashed paths to stable symlinks. The dev script also clears `/tmp/metro-file-map-*` on each start. Do not remove these guards.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- OpenAPI spec: `lib/api-spec/openapi.yaml`
- DB schema: `lib/db/src/schema/index.ts`
