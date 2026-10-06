// Email links (password reset, invites, subscription) point at
// https://app.kkamera.app/<path>. Universal / App Links aren't configured, so a
// tap lands in the browser on this API host. These pure helpers turn such a
// request into a `kkamera://` deep link; routes/appLinks.ts serves the small
// "open in the app" page around it.

export const APP_SCHEME = "kkamera";

type ParamRule = { name: string; pattern: RegExp; required: boolean };

/**
 * Paths an email may link to, and the only query params each may forward.
 * Anything else is dropped so the page can never be used to hand arbitrary
 * input to the app.
 */
const APP_LINK_ROUTES: Record<string, { title: string; params: ParamRule[] }> = {
  "/auth/reset-password": {
    title: "Reset your password",
    // randomBytes(32).toString("hex") — see routes/passwordReset.ts
    params: [{ name: "token", pattern: /^[0-9a-f]{64}$/, required: true }],
  },
  "/auth/register": {
    title: "Join KKamera",
    params: [{ name: "ref", pattern: /^[A-Za-z0-9-]{1,32}$/, required: false }],
  },
  "/settings/subscription": {
    title: "Your KKamera subscription",
    params: [],
  },
};

export const APP_LINK_PATHS = Object.keys(APP_LINK_ROUTES);

export type AppLink = { title: string; deepLink: string; valid: boolean };

/**
 * Build the deep link for an allowed path. `valid` is false when a required
 * param is missing or malformed (the deep link then omits it, and the app shows
 * its own "link is invalid" state).
 */
export function buildAppLink(path: string, query: Record<string, unknown>): AppLink | null {
  const route = APP_LINK_ROUTES[path];
  if (!route) return null;
  const search = new URLSearchParams();
  let valid = true;
  for (const rule of route.params) {
    const raw = query[rule.name];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value && rule.pattern.test(value)) {
      search.set(rule.name, value);
    } else if (rule.required) {
      valid = false;
    }
  }
  const qs = search.toString();
  return {
    title: route.title,
    deepLink: `${APP_SCHEME}:/${path}${qs ? `?${qs}` : ""}`,
    valid,
  };
}
