# KKamera

A subscription-based native camera app (iOS/Android) that directly uploads photos and videos to FTP, WebDAV, Nextcloud, Google Drive, OneDrive, and Dropbox.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (local 8080 → external :8080 on the dev domain)
- `pnpm --filter @workspace/kkamera run dev` — run the Expo app (web on port from $PORT env; API base URL is `https://$REPLIT_DEV_DOMAIN:8080` via EXPO_PUBLIC_DOMAIN)
- The native apps are built and submitted via EAS (`eas build` / `eas submit`, config in `artifacts/kkamera/eas.json`). The API server is a JSON API; its only HTML is the email app-link landing pages and the public legal pages (`/privacy`, `/terms`, `/account-deletion` — see below).
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run test` — run unit tests (api-server: Node 24 native TS + `node:test`, no extra deps; pure security/billing logic in `artifacts/api-server/test/`)
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- DB schema changes: edit `lib/db/src/schema/`, then `pnpm --filter @workspace/db run generate` to create a versioned migration in `lib/db/drizzle/` (commit it). Migrations auto-apply on API server startup (and via the post-merge hook); `pnpm --filter @workspace/db run migrate` applies them manually. `pnpm --filter @workspace/db run push` remains for throwaway local experiments only — real changes must be a committed migration.
- **`NODE_ENV`**: the deployment runs with `NODE_ENV=production` (set in `.replit` `[deployment] run`, and the api-server `start` script defaults to it; `dev` exports `development`). Production means JSON logs (no pino-pretty), CORS without localhost/`*.replit.dev`, and the boot check below.
- **Production boot check** (`artifacts/api-server/src/lib/bootEnv.ts`, imported first by `index.ts`): with `NODE_ENV=production` the server refuses to start, listing every missing var, unless `DATABASE_URL`, `SESSION_SECRET`, `RESEND_API_KEY`, `REVENUECAT_WEBHOOK_AUTH` and `REVENUECAT_SECRET_API_KEY` are all set. `ALLOW_SANDBOX_IAP=true` in production only logs a loud warning (not a crash) so a staging deployment can use it deliberately. Development stays permissive.
- **Graceful shutdown**: on SIGTERM/SIGINT the server stops accepting connections, `/api/readyz` returns 503 (`shutting_down`), in-flight requests get up to `SHUTDOWN_GRACE_MS` (default 25000) to finish (best effort — long uploads may be cut off and are retried by the app's queue), then remaining sockets are closed, the DB pool is ended and the process exits.
- **Public legal pages** (`routes/legal.ts`, content in `lib/legalPages.ts`): `https://app.kkamera.app/privacy`, `/terms` (EULA, incl. auto-renewing subscription disclosure) and `/account-deletion` — static self-contained HTML with a strict per-route CSP, also at `/api/legal/{privacy,terms,account-deletion}`. Text is ported from the app's `app/settings/privacy.tsx` / `terms.tsx` — keep them in sync and bump `LAST_UPDATED` in both. Used as the App Store / Play privacy policy, EULA and account-deletion URLs.
- Required env: `DATABASE_URL` — Postgres connection string
- Required env: `SESSION_SECRET` — JWT signing secret; the AES-256 cloud-credential key is HKDF-derived from it (separate key, ≥32 chars enforced at boot)
  - **Do not rotate `SESSION_SECRET` without a migration plan.** Everything below is keyed on it, so a rotation: signs out every session; makes every stored cloud credential and 2FA (TOTP) secret undecryptable (affected users must reconnect clouds, and 2FA users can only get in with a backup code or support); invalidates every new-format (HMAC'd) backup code; and breaks trial-history matching (`trial_history` HMACs), so previously used emails would get a fresh trial.
- Required env (production): `RESEND_API_KEY` — all outbound email via Resend (no-ops with a warning if unset); optional `EMAIL_FROM` overrides the default `KKamera <noreply@kkamera.app>` sender (domain must be verified in Resend)
- Optional env: `APP_URL` — canonical public origin for OAuth callbacks and email links (defaults to `https://app.kkamera.app`; never the Replit domain)
- Optional env: `PAST_DUE_GRACE_DAYS` — days a past_due subscription keeps access past its last paid period before being blocked (default 14)
- Optional env: OAuth provider creds `GOOGLE_*`/`ONEDRIVE_*`/`DROPBOX_CLIENT_ID|SECRET` for cloud connections
- Required env (native IAP): `REVENUECAT_WEBHOOK_AUTH` (secret) — shared secret the RevenueCat dashboard sends in the webhook `Authorization` header. `POST /api/revenuecat/webhook` fails closed (503) if unset. This is what mirrors App Store / Play subscriptions into `subscriptionsTable`; without it native IAP subscribers get 402 on upload after their trial. The client must call `Purchases.logIn(userId)` (done in `lib/revenuecat.tsx`) so `app_user_id` maps to our numeric userId.
- Required env (production; optional in dev): `REVENUECAT_SECRET_API_KEY` — RevenueCat secret (v1 REST) key used by `POST /api/subscriptions/sync` and TRANSFER-webhook reconciliation to read `GET /v1/subscribers/{userId}`. Sync returns 503 and TRANSFER events are logged-but-unreconciled if unset.
- Optional env: `CRON_SECRET` — bearer secret for `POST /api/internal/send-trial-reminders` (header `Authorization: Bearer $CRON_SECRET`), which sweeps every user whose trial ends within 3 days and emails the "trial ending" reminder. Fails closed (503) if unset. Wire it to any external scheduler (e.g. daily); without it the reminder is still sent opportunistically on the user's next authenticated request (throttled per process; at most once per user via `users.trial_reminder_sent_at`).
- Optional env: `MAX_RECEIVING_UPLOADS` — global cap on upload bodies being streamed to the temp dir at once (default 20); beyond it `/uploads/execute` returns 503 + Retry-After and the app's queue retries
- Optional env: `ALLOW_INSECURE_WEBDAV` — `true` lets WebDAV / Nextcloud connections use plain `http://` server URLs. Default off: such URLs are rejected on create/update (400) and at upload/test time, because Basic auth would send the password in cleartext. `ALLOW_INSECURE_FTP` is the FTP equivalent (plaintext FTP when the server refuses AUTH TLS). Never enable either in production.
- Optional env: `ALLOW_SANDBOX_IAP` — `true` lets RevenueCat SANDBOX purchases (TestFlight / Play test tracks) grant access; default off (sandbox webhook events are acked and ignored, sandbox entitlements are skipped by sync). Sandbox events never complete or reverse referrals either way. Never enable in production (the server logs a loud warning at boot if it is).
- Optional env: `SANDBOX_IAP_USER_IDS` — comma-separated numeric KKamera user ids (e.g. `12,57`) whose sandbox purchases are honoured even with `ALLOW_SANDBOX_IAP` off — both webhook events and `/subscriptions/sync` (a sandbox TRANSFER only when every user on both sides is listed). Safe in production for named tester accounts; other users' sandbox events are still ignored. Malformed entries are ignored; parsed once per process (restart to change). Sandbox purchases never complete or reverse referrals.

## Local development (Mac)

Replit still hosts production (API + Postgres) and its own dev workflow; the commands above are unchanged. To develop the app on a Mac:

- pnpm is pinned via `packageManager` (pnpm 10). A newer global pnpm switches to it automatically; don't regenerate the lockfile with pnpm 11.
- `cp artifacts/kkamera/.env.example artifacts/kkamera/.env.local` and fill in the RevenueCat keys (from `.replit` `[userenv.shared]`). With no `EXPO_PUBLIC_API_URL` the app talks to production (`https://app.kkamera.app`); set it to the Replit dev API or a local API to avoid touching production data.
- The app uses native modules (RevenueCat, document scanner, expo-dev-client), so it runs as a **dev build**, not in Expo Go:
  - iOS: needs Xcode, an iOS Simulator runtime and CocoaPods (`brew install cocoapods`). `pnpm --filter @workspace/kkamera run ios` (first run prebuilds `ios/` and compiles; later runs only need `run start`).
  - Android: needs Android Studio (SDK + emulator, `ANDROID_HOME` set). `pnpm --filter @workspace/kkamera run android`.
  - `ios/` and `android/` are generated from `app.json` (git-ignored). Change native config in `app.json`/config plugins, then `run prebuild`.
- Running the API locally is optional: it needs Postgres (`brew install postgresql@17`) plus `DATABASE_URL` and `SESSION_SECRET` (≥32 chars), then `pnpm --filter @workspace/api-server run dev` (port 8080; migrations auto-apply). Never point a local server at the production database.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Mobile/Web: Expo SDK 57 (Expo Router, React Native 0.86)
- Billing: App Store / Play in-app purchases via RevenueCat (server mirror through the RevenueCat webhook)

## Where things live

- `artifacts/api-server/` — Express 5 API server
- `artifacts/kkamera/` — Expo app (iOS, Android)
- `lib/db/` — Drizzle schema + migrations (source of truth: `lib/db/src/schema/`)
- `lib/api-spec/` — OpenAPI spec (`openapi.yaml`) + codegen output
- `lib/api-client-react/` — generated React Query hooks + Zod schemas

## Architecture decisions

- JWT-based auth (bcrypt passwords, optional TOTP 2FA via otplib, QR code via qrcode). The TOTP secret is stored AES-256-GCM encrypted (legacy plaintext secrets are accepted and re-encrypted on next successful use); each accepted TOTP time step is recorded in `users.totp_last_step` so a code can't be replayed. Backup codes are 10-char Crockford base32 (`XXXXX-XXXXX`, 50 bits), single-use, stored as HMAC-SHA256 under an HKDF-derived key (legacy 8-hex SHA-256 codes still verify); pure logic in `lib/twoFactor.ts`; a 401 from any request signals the client to clear its session, so authenticated endpoints return 400/403 (never 401) for a wrong password or code. Sessions carry a `tv` claim checked against `users.token_version` (bumped by password change/reset, 2FA changes and "sign out all other devices"); accounts lock after repeated failed sign-ins (`failed_login_count` / `login_locked_until`)
- Email verification (code-based, no links — universal links aren't configured): `POST /auth/register` never signs in; it always returns `202 {status:"verification_required", nonce, email}` (same shape/timing for new, pending and already-verified addresses — no enumeration). A 6-digit code is emailed (30-min expiry, 5 wrong tries per code, HMAC-SHA256 under an HKDF-derived key, constant-time compare) and redeemed with `POST /auth/verify-email {nonce, code}`, which verifies the account, applies the password/name of the registration that requested that code, starts the 14-day trial (`grantTrialIfEligible` — the trial is no longer granted at register) and returns `{token, user}`. `POST /auth/resend-verification {nonce}` issues a replacement code (always 200 with a nonce). A correct password on an unverified account gets `403 {code:"email_not_verified", nonce, email}` from `/auth/login` (code emailed). Registering an already-verified address only emails the owner a throttled "someone tried to create an account" notice. A completed password reset also verifies the address. Pure rules in `lib/emailVerification.ts`, DB side in `lib/emailVerificationStore.ts`; app screen `app/auth/verify-email.tsx`
- Cloud connection credentials stored AES-256-GCM encrypted in DB (key HKDF-derived from `SESSION_SECRET`, separate from the JWT secret); legacy raw-key GCM values still decrypt (CBC support was removed)
- OAuth connect flow uses stateless signed-JWT state with the PKCE verifier encrypted inside it (autoscale-safe, no in-memory store); state tokens carry `typ: "oauth-state"` and their own audience, so they and session JWTs (aud `kkamera-session`, no `typ`) can never verify as each other
- Express runs with `trust proxy` (required behind Replit's proxy for per-client rate limiting)

### Security model (don't regress)
- **SSRF guard** (`lib/ssrf.ts` + `cloudUpload.ts`): user-supplied FTP/WebDAV/Nextcloud hosts are validated against private/loopback/link-local/IPv4-mapped-IPv6 ranges, the resolved IP is pinned (FTP, with TLS `servername` set to the original host) or re-validated on every socket by `SafeHttpAgent`/`SafeHttpsAgent` — IP-literal targets, resolved names and the connected `remoteAddress` are all checked, and each WebDAV client's agents are locked to its own host so cross-host redirects fail. Keep this on any new outbound request to a user-controlled host.
- **OAuth connect is device-bound** (`routes/oauth.ts`, `lib/oauthPending.ts`): the callback only creates a *pending* connection (`pending_nonce_hash`, 10-min expiry); it becomes active when the initiating app calls `POST /oauth/complete` with both the nonce from its own initiate response and the one-time code from the redirect. Pending rows are never listed, selectable or uploaded to. Server and app must ship together — older app builds can't complete OAuth.
- **RevenueCat webhook** (`routes/revenuecat.ts`): shared-secret authenticated (fails closed without `REVENUECAT_WEBHOOK_AUTH`); mirrors IAP entitlements into `subscriptionsTable`; referral milestones are idempotent + row-locked; period-end writes are forward-only (`GREATEST`); stale future-dated EXPIRATION events are ignored. Each event id is recorded in `revenuecat_events` in the same transaction that applies it (replays are acknowledged, not re-applied), and events older than `subscriptions.last_event_at` can't downgrade state. `ALLOW_SANDBOX_IAP` (all users) or `SANDBOX_IAP_USER_IDS` (named testers) gates sandbox events, which never touch referrals.
- **TLS for self-hosted clouds** (`lib/tlsPin.ts`, `cloudUpload.ts`): FTPS and WebDAV/Nextcloud over HTTPS fail closed on an untrusted certificate. A connection can opt in with `trustSelfSigned`; then the leaf certificate's SHA-256 is pinned on first successful handshake (`cloud_connections.tls_pin_sha256`, server-only, never returned) and every later socket — FTPS control and data, each WebDAV socket — must match it before credentials or file bytes are sent. If the server presents a CA-valid certificate, the column is set to the `ca-valid` marker instead: CA-valid certificates (e.g. Let's Encrypt renewals) keep working, and a non-CA certificate is then always refused (never trusted as a first use). Changing host, port or `trustSelfSigned` clears the pin.
- **Rate limits** (`lib/rateLimitStore.ts`): security-critical limiters (auth, password reset, 2FA/reauth, account deletion, witness, invites, feedback, connection create, OAuth initiate) use `sharedRateLimit(name, …)` — a Postgres store (`rate_limit_hits`, one upsert per hit, expired rows swept every 5 min) that holds across instances; on a DB error it falls back to per-process memory (logged). Hot-path, load-only limiters (upload execute, subscription sync, connection test) use `localRateLimit` (per-process memory, no DB round trip). Sign-in is throttled in the login handler with one DB round trip per attempt: per address bucket (client IP or IPv6 /64) 10 unsuccessful attempts / 15 min across all accounts, per (account, address) 5 failures / 15 min (cleared on every successful sign-in), plus an account-wide ceiling (50 consecutive failures → at most 15 min), so a stranger can't lock an owner out.
- **Abuse caps**: ≤10 cloud connections per account (manual and OAuth), ≤10 destinations per capture with ≤3 transfers in flight per capture; witness emails need an active subscription and are capped at 30/user/24 h (DB-backed, like referral invites at 50/day).
- **Helmet** is on (global CSP disabled — JSON API; the legal pages set their own strict CSP) and **CORS** allows only the app host (no cookies — bearer only). HTML interpolated into emails goes through `escapeHtml`; upload filenames through `sanitizeFileName`.
- **Email verification is device-bound** (`lib/emailVerification*.ts`, `routes/auth.ts`): each code row stores only sha256(nonce), where the 32-byte nonce is returned solely to the client that requested the code (never emailed), so an attacker who pre-registers a victim's address can't get the victim to redeem a code that applies the attacker's password. Unverified accounts get no session (requireAuth also rejects them), sends are throttled per account (≥60 s apart, ≤5/hour; beyond that the response is unchanged and nothing is sent), stale rows (>24 h) and never-verified accounts (>30 days idle, subscription `none`) are swept opportunistically. Keep every register/resend response identical in shape whether or not the address exists.
- Security/billing pure logic is unit-tested (`artifacts/api-server/test/`) — extend the tests when changing it.
- Production deployment is an API-only server (`/api`); the native apps ship via EAS and talk to it
- Affiliate programme: 5 successful referral signups = 1 free year added to subscription
- App Store / Play in-app purchases (via RevenueCat) handle subscription billing (14-day trial → $30/year)
- Offline upload queue (in-app retry with backoff)

## Product

- Apple Camera-style UI with brand colours #b19870 (primary) and #c3b091 (secondary)
- Dark theme (#0d0b08 background) throughout
- 6-step onboarding wizard (profile → cloud → permissions → plan → affiliate → done)
- Camera screen with photo/video capture and direct cloud upload
- Settings: cloud connections, subscription, 2FA security, affiliate dashboard, feedback

## User preferences

- Company brand: **Koastal Kollective**, website https://www.koastal.com.au (product name stays KKamera; contact development@koastal.com.au). The EAS `owner` in app.json (`koasoft`) is the Expo account name, not branding — don't change it.
- Brand colours: #b19870 (primary/gold), #c3b091 (secondary)
- Dark background: #0d0b08
- iOS/Android target — Expo managed workflow
- Subscription: 14-day trial then $30/year via App Store / Play (RevenueCat)
- Affiliate: 5 referrals = 1 free year

## Gotchas

- Google Fonts (via `@expo-google-fonts/inter`) may not load in Replit sandbox. Do not block rendering on font load.
- `Platform.OS` can be used at module level safely in Expo Metro bundles.
- API server uses path `/api` — all API routes must start with `/api`. Exceptions mounted at the root: the email app-link pages (`routes/appLinks.ts`) and the legal pages (`routes/legal.ts`). The artifact proxy (`artifacts/api-server/.replit-artifact/artifact.toml`) only routes `/api` in dev, so use `/api/legal/...` there.
- **Pnpm + Metro stale hash**: `metro.config.js` keeps Metro's server root at the workspace root (do not force it to the app dir) and includes a resolver interceptor that rewrites stale pnpm-hashed paths to stable symlinks. The dev script also clears `/tmp/metro-file-map-*` on each start, and Metro's cache is disabled when `REPL_ID` is set (Replit only — local and EAS builds keep the cache, otherwise every bundle is a ~10-minute cold build). Do not remove these guards. (The old `@expo/cli` serverRoot patch was dropped in the SDK 57 upgrade.)
- **Expo SDK 57 + iOS 27**: Xcode 27 builds require the UIScene lifecycle; it's enabled with `expo-build-properties` `ios.enableSceneSupport` in `app.json`. `plugins/withPodsDeploymentTarget.js` raises old pods' deployment targets so Xcode 27 accepts them. Keep `expo`, `react` and `react-native` in `dependencies` (not dev) or `expo prebuild` rewrites package.json.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- OpenAPI spec: `lib/api-spec/openapi.yaml`
- DB schema: `lib/db/src/schema/index.ts`
