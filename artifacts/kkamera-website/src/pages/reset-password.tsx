import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SiteShell } from "@/components/site-shell";
import { detectMobileOS, openApp, type MobileOS } from "@/lib/links";

/**
 * Landing page for the password-reset email (/auth/reset-password?token=…).
 * The email links to APP_URL, which is the same deployment as the API, so the
 * form posts to /api/auth/reset-password same-origin. The request carries only
 * the one-time token from the link — no session or cookies.
 */
export default function ResetPassword() {
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token") ?? "");
  const [os, setOs] = useState<MobileOS>("other");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setOs(detectMobileOS());
    // Keep the one-time token out of the address bar and history once read.
    if (token) window.history.replaceState(null, "", window.location.pathname);
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (new TextEncoder().encode(password).length > 72) { setError("Password is too long."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }

    setBusy(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) { setDone(true); return; }
      const body = await res.json().catch(() => null) as { message?: string } | null;
      setError(body?.message ?? "Couldn't reset your password. Please try again.");
    } catch {
      setError("Couldn't reach KKamera. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SiteShell title="Reset your password">
      <section className="container mx-auto max-w-md px-5 lg:px-8 py-16 md:py-24">
        <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-primary">
          {done ? <CheckCircle2 className="h-7 w-7" /> : <KeyRound className="h-7 w-7" />}
        </div>

        {done ? (
          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight">Password updated</h1>
            <p className="mt-4 text-lg text-muted-foreground">
              You can now sign in to KKamera with your new password. Any other devices have been signed out.
            </p>
            {os !== "other" && (
              <Button size="lg" className="mt-8 rounded-full h-12 px-8" onClick={() => openApp("auth/login", null)}>
                Open KKamera
              </Button>
            )}
          </div>
        ) : !token ? (
          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight">Link not valid</h1>
            <p className="mt-4 text-lg text-muted-foreground">
              This reset link is incomplete. In the KKamera app, tap "Forgot password?" to get a new one.
            </p>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <h1 className="text-3xl font-bold tracking-tight text-center">Choose a new password</h1>
            <div className="space-y-2">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password" type="password" autoComplete="new-password" className="h-11"
                value={password} onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm new password</Label>
              <Input
                id="confirm" type="password" autoComplete="new-password" className="h-11"
                value={confirm} onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" size="lg" className="w-full rounded-full h-12" disabled={busy}>
              {busy ? "Saving…" : "Set new password"}
            </Button>
            <p className="text-center text-sm text-muted-foreground">At least 8 characters.</p>
          </form>
        )}
      </section>
    </SiteShell>
  );
}
