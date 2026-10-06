import { Link } from "wouter";
import { SiteShell } from "@/components/site-shell";

export default function NotFound() {
  return (
    <SiteShell title="Page not found">
      <section className="container mx-auto max-w-xl px-5 lg:px-8 py-24 text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">404</p>
        <h1 className="mt-3 text-3xl md:text-4xl font-bold tracking-tight">Page not found</h1>
        <p className="mt-4 text-lg text-muted-foreground">
          The page you're looking for doesn't exist or has moved.
        </p>
        <Link
          href="/"
          className="mt-8 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground px-6 h-12 font-semibold hover:opacity-90 transition-opacity"
        >
          Go to the homepage
        </Link>
      </section>
    </SiteShell>
  );
}
