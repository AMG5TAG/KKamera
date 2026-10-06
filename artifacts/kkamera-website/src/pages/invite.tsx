import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Gift, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteShell, StoreButtons } from "@/components/site-shell";
import { detectMobileOS, openApp, storeUrlFor, type MobileOS } from "@/lib/links";

/** Referral codes are uppercase letters/digits (see generateReferralCode in the API). */
function readReferralCode(): string {
  const raw = new URLSearchParams(window.location.search).get("ref") ?? "";
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 32);
}

/**
 * Landing page for invite links (https://app.kkamera.app/auth/register?ref=CODE).
 * Opens the app's sign-up screen with the code prefilled when it's installed;
 * otherwise shows the code to copy and the store links.
 */
export default function Invite() {
  const code = useMemo(readReferralCode, []);
  const [os, setOs] = useState<MobileOS>("other");
  const [copied, setCopied] = useState(false);

  useEffect(() => setOs(detectMobileOS()), []);

  const appPath = code ? `auth/register?ref=${encodeURIComponent(code)}` : "auth/register";

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the code is visible to copy by hand.
    }
  };

  return (
    <SiteShell title="You're invited">
      <section className="container mx-auto max-w-xl px-5 lg:px-8 py-16 md:py-24 text-center">
        <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-primary">
          <Gift className="h-7 w-7" />
        </div>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">You've been invited to KKamera</h1>
        <p className="mt-4 text-lg text-muted-foreground leading-relaxed">
          Snap work photos straight to your business cloud and keep your personal camera roll clean.
          Start with a 24-hour free trial — no payment details needed.
        </p>

        {code && (
          <div className="mt-10 rounded-2xl border border-border bg-card p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Your referral code</p>
            <p className="mt-3 font-mono text-3xl font-bold tracking-widest text-primary break-all">{code}</p>
            <Button variant="outline" size="sm" className="mt-4 rounded-full" onClick={copyCode}>
              {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy code"}
            </Button>
            <p className="mt-4 text-sm text-muted-foreground">
              Enter it when you create your account in the app.
            </p>
          </div>
        )}

        <div className="mt-10 flex flex-col items-center gap-4">
          {os !== "other" && (
            <Button
              size="lg"
              className="rounded-full h-12 px-8 text-base font-semibold"
              onClick={() => openApp(appPath, storeUrlFor(os))}
            >
              <Smartphone /> Open in KKamera
            </Button>
          )}
          <p className="text-sm text-muted-foreground">
            {os === "other" ? "Get KKamera on your phone:" : "Don't have the app yet?"}
          </p>
          <StoreButtons className="justify-center" />
        </div>
      </section>
    </SiteShell>
  );
}
