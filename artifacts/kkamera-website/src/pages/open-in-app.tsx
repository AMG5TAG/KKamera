import { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteShell, StoreButtons } from "@/components/site-shell";
import { detectMobileOS, openApp, storeUrlFor, type MobileOS } from "@/lib/links";

/**
 * Landing page for app screens linked from emails (e.g. /settings/subscription).
 * The app is native-only, so this hands off to it via the kkamera:// scheme.
 */
export default function OpenInApp({ appPath, title, body }: { appPath: string; title: string; body: string }) {
  const [os, setOs] = useState<MobileOS>("other");
  useEffect(() => setOs(detectMobileOS()), []);

  return (
    <SiteShell title={title}>
      <section className="container mx-auto max-w-xl px-5 lg:px-8 py-16 md:py-24 text-center">
        <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-primary">
          <Smartphone className="h-7 w-7" />
        </div>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">{title}</h1>
        <p className="mt-4 text-lg text-muted-foreground leading-relaxed">{body}</p>
        <div className="mt-10 flex flex-col items-center gap-4">
          {os !== "other" ? (
            <Button
              size="lg"
              className="rounded-full h-12 px-8 text-base font-semibold"
              onClick={() => openApp(appPath, storeUrlFor(os))}
            >
              <Smartphone /> Open KKamera
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">Open KKamera on your phone, or get the app:</p>
          )}
          {os === "other" && <StoreButtons className="justify-center" />}
        </div>
      </section>
    </SiteShell>
  );
}
