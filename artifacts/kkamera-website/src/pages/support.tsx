import type React from "react";
import { Link } from "wouter";
import { ArrowRight, CreditCard, LifeBuoy, Mail, ShieldCheck, Trash2 } from "lucide-react";
import { SiteShell, MailLink } from "@/components/site-shell";

function Card({ icon: Icon, title, children }: { icon: typeof Mail; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-2 space-y-3 leading-relaxed text-foreground/80">{children}</div>
    </div>
  );
}

export default function Support() {
  return (
    <SiteShell title="Support">
      <section className="container mx-auto max-w-4xl px-5 lg:px-8 py-14 md:py-20">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Support</h1>
        <p className="mt-4 text-lg text-muted-foreground max-w-2xl">
          Need a hand with KKamera? Here's how to get help and manage your account.
        </p>

        <div className="mt-10 grid gap-5 md:grid-cols-2">
          <Card icon={Mail} title="Contact us">
            <p>Email <MailLink subject="KKamera — support" /> and we'll get back to you.</p>
            <p>
              In the app you can also send feedback or a bug report from Settings → Support → Feedback &amp; Bug Reports.
            </p>
          </Card>

          <Card icon={CreditCard} title="Subscription & billing">
            <p>
              KKamera starts with a 24-hour free trial, then is billed through the Apple App Store or Google Play.
            </p>
            <p>
              To cancel or change your plan, use your App Store or Google Play subscription settings. Deleting the app or
              your account does not cancel a store subscription. Refunds are handled by Apple or Google.
            </p>
          </Card>

          <Card icon={Trash2} title="Delete your account">
            <p>
              In the app, go to Settings → Privacy &amp; Security → Delete Account. This permanently deletes your account,
              cloud connections and upload history.
            </p>
            <p>
              Can't get into the app? Email <MailLink subject="KKamera — account deletion request" /> from your account's
              email address and we'll delete it for you.
            </p>
          </Card>

          <Card icon={LifeBuoy} title="Uploads not arriving?">
            <p>
              Check the cloud connection in Settings → Cloud, make sure your storage has free space, and look at the upload
              history for an error message. Uploads made offline are queued and retried automatically.
            </p>
          </Card>
        </div>

        <div className="mt-10 flex flex-col sm:flex-row gap-4">
          <Link href="/privacy" className="inline-flex items-center gap-2 font-medium text-primary hover:underline">
            <ShieldCheck className="h-4 w-4" /> Privacy Policy <ArrowRight className="h-4 w-4" />
          </Link>
          <Link href="/terms" className="inline-flex items-center gap-2 font-medium text-primary hover:underline">
            Terms of Service <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </SiteShell>
  );
}
