/**
 * Canonical public origin of the deployed app. Every user-facing URL — OAuth
 * callbacks, Stripe checkout redirect + webhook, password-reset links — is built
 * from this, never from the Replit preview domain. Override with the APP_URL env
 * var only if the app is ever hosted somewhere other than app.kkamera.app.
 */
export function getPublicBaseUrl(): string {
  const override = process.env["APP_URL"]?.trim();
  return (override && override.length > 0 ? override : "https://app.kkamera.app").replace(/\/+$/, "");
}

/** Host portion of the public base URL (e.g. "app.kkamera.app"). */
export function getPublicHost(): string {
  try {
    return new URL(getPublicBaseUrl()).host;
  } catch {
    return "app.kkamera.app";
  }
}
