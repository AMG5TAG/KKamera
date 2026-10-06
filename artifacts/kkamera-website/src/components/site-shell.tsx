import React, { useEffect } from "react";
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import { SiApple, SiGoogleplay } from "react-icons/si";
import logoWordPath from "@assets/Logo_-_Words_-_KoaPOS_-_Slogan_(2)_1778650517669.png";
import { ANDROID_STORE_URL, COMPANY_URL, CONTACT_EMAIL, IOS_STORE_URL } from "@/lib/links";

/** Header + footer for the secondary pages (legal, support, invite). */
export function SiteShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} — KKamera`;
    window.scrollTo(0, 0);
  }, [title]);

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground font-sans antialiased">
      <header className="border-b border-border bg-background/90 backdrop-blur-md">
        <div className="container mx-auto max-w-6xl px-5 lg:px-8 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center" aria-label="KKamera home">
            <img src={logoWordPath} alt="KKamera" className="h-8 w-auto" />
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-primary transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> Back to home
          </Link>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <SiteFooter />
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="bg-ink text-ink-foreground py-10 px-5 lg:px-8">
      <div className="container mx-auto max-w-6xl flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex flex-col items-center md:items-start gap-2">
          <p className="text-ink-foreground/50 text-sm">© 2026 Koastal. All rights reserved.</p>
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline text-sm font-medium">
            {CONTACT_EMAIL}
          </a>
        </div>
        <nav className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm">
          <Link href="/support" className="text-ink-foreground/60 hover:text-primary transition-colors">Support</Link>
          <Link href="/privacy" className="text-ink-foreground/60 hover:text-primary transition-colors">Privacy Policy</Link>
          <Link href="/terms" className="text-ink-foreground/60 hover:text-primary transition-colors">Terms of Service</Link>
          <a href={COMPANY_URL} target="_blank" rel="noopener noreferrer" className="text-ink-foreground/60 hover:text-primary transition-colors">
            Koastal Kollective
          </a>
        </nav>
      </div>
    </footer>
  );
}

export function StoreButtons({ className = "" }: { className?: string }) {
  return (
    <div className={`flex flex-col sm:flex-row gap-3 ${className}`}>
      <a
        href={IOS_STORE_URL}
        className="inline-flex items-center justify-center gap-2.5 rounded-full bg-ink text-ink-foreground px-6 h-12 font-semibold hover:opacity-90 transition-opacity"
      >
        <SiApple className="h-5 w-5" /> App Store
      </a>
      <a
        href={ANDROID_STORE_URL}
        className="inline-flex items-center justify-center gap-2.5 rounded-full bg-ink text-ink-foreground px-6 h-12 font-semibold hover:opacity-90 transition-opacity"
      >
        <SiGoogleplay className="h-5 w-5" /> Google Play
      </a>
    </div>
  );
}

/** Layout for long-form legal text. */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <SiteShell title={title}>
      <article className="container mx-auto max-w-3xl px-5 lg:px-8 py-14 md:py-20">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">{title}</h1>
        <p className="mt-3 text-sm italic text-muted-foreground">Last updated: {updated}</p>
        <div className="mt-10 space-y-9">{children}</div>
      </article>
    </SiteShell>
  );
}

export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-primary mb-3">{title}</h2>
      <div className="space-y-4 leading-relaxed text-foreground/85">{children}</div>
    </section>
  );
}

export function B({ children }: { children: React.ReactNode }) {
  return <strong className="font-semibold text-foreground">{children}</strong>;
}

export function MailLink({ subject }: { subject: string }) {
  return (
    <a
      href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`}
      className="text-primary hover:underline font-medium"
    >
      {CONTACT_EMAIL}
    </a>
  );
}
