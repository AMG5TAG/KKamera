import React, { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  CloudUpload,
  FolderLock,
  Cloud,
  Share2,
  ShieldCheck,
  Smartphone,
  Check,
  ArrowRight,
  ArrowUpRight,
  Menu,
  X,
  Camera,
  Lock,
  MapPin,
  ChevronDown,
} from "lucide-react";
import { SiApple, SiGoogleplay } from "react-icons/si";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import logoWordPath from "@assets/Logo_-_Words_-_KoaPOS_-_Slogan_(2)_1778650517669.png";
import workImg1 from "@assets/67eac2a3dbe925471cd2c0b5_67d25de1197ccc6cc3444284_differentty_1778651146730.webp";
import workImg2 from "@assets/BBR_Building_Home_3_LowRes_1778651146730.jpg";
import workImg3 from "@assets/Depositphotos_207274982_l-2015_1778651146731.jpg";
import workImg4 from "@assets/Electrical-Wiring-In-Australia_1778651146731.webp";
import workImg5 from "@assets/istockphoto-155445643-612x612_1778651146731.jpg";
import workImg6 from "@assets/wiring-from-wall_1778651146732.webp";
import personalImg1 from "@assets/360_F_243091137_EpRIVWrSnpAonZ1PsojvdBMDIajooL7s_1778651175697.jpg";
import personalImg2 from "@assets/istockphoto-1402602559-1024x1024_1778651175700.jpg";
import personalImg3 from "@assets/must-take-wedding-photos-bride-groom-walk-clary-prfeiffer-phot_1778651175700.jpg";
import personalImg4 from "@assets/istockphoto-1447123729-612x612_1778651261450.jpg";
import personalImg5 from "@assets/untitled-design-21-67ca5f7ea9843-scaled_1778651261453.webp";
import personalImg6 from "@assets/frenemies-and-toxic-friendships-narrow_1778651282378.jpg";

import { Link } from "wouter";
import { ANDROID_STORE_URL, IOS_STORE_URL, openApp, storeUrlFor } from "@/lib/links";

const workImages = [workImg1, workImg2, workImg3, workImg4, workImg5, workImg6];
const personalImages = [
  personalImg1,
  personalImg2,
  personalImg3,
  personalImg4,
  personalImg5,
  personalImg6,
];

const navLinks = [
  { id: "how-it-works", label: "How it works" },
  { id: "features", label: "Features" },
  { id: "pricing", label: "Pricing" },
  { id: "help", label: "Help" },
  { id: "contact", label: "Contact" },
];

const contactSchema = z.object({
  name: z.string().min(2, "Name is required"),
  email: z.string().email("Valid email is required"),
  subject: z.string().min(1, "Subject is required"),
  message: z.string().min(10, "Message must be at least 10 characters"),
});

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2.5 text-xs font-semibold uppercase tracking-[0.2em] text-primary">
      <span className="h-px w-6 bg-primary/50" />
      {children}
    </span>
  );
}

export default function Home() {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  // Only phones/tablets should ever see the "Launch app" button.
  const [isHandheld, setIsHandheld] = useState(false);
  const mobileOS = useRef<"ios" | "android" | "other">("other");
  const { toast } = useToast();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const ua = navigator.userAgent || "";
    // iPadOS reports as "MacIntel" but exposes touch points.
    const isIpadOS =
      navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    const isIOS = /iPhone|iPad|iPod/i.test(ua) || isIpadOS;
    const isAndroid = /Android/i.test(ua);
    const isOtherHandheld = /Mobi|Windows Phone|BlackBerry|IEMobile|Opera Mini|Tablet|PlayBook|Silk/i.test(ua);
    mobileOS.current = isIOS ? "ios" : isAndroid ? "android" : "other";
    setIsHandheld(isIOS || isAndroid || isOtherHandheld);
  }, []);

  // Try to open the installed app; if nothing takes over, fall back to the store.
  const launchApp = () => {
    setIsMobileMenuOpen(false);
    const store = storeUrlFor(mobileOS.current);
    // No store for other handhelds (there's no web app) — show the download section.
    if (!store) {
      scrollTo("download");
      return;
    }
    openApp("", store);
  };

  const form = useForm<z.infer<typeof contactSchema>>({
    resolver: zodResolver(contactSchema),
    defaultValues: { name: "", email: "", subject: "", message: "" },
  });

  const onSubmit = (data: z.infer<typeof contactSchema>) => {
    const subject = encodeURIComponent(data.subject);
    const body = encodeURIComponent(
      `Name: ${data.name}\nEmail: ${data.email}\n\nMessage:\n${data.message}`
    );
    window.location.href = `mailto:development@koastal.com.au?subject=${subject}&body=${body}`;
    toast({
      title: "Opening your email client",
      description: "We've prepared your message.",
    });
    form.reset();
  };

  const scrollTo = (id: string) => {
    setIsMobileMenuOpen(false);
    const element = document.getElementById(id);
    if (element) element.scrollIntoView({ behavior: "smooth" });
  };

  // The free trial lives in the native phone apps (there is no desktop app), so
  // send phone/tablet visitors straight to their store; on desktop, take them to
  // the download section that shows both the iOS and Android options.
  const goToAppStore = () => {
    setIsMobileMenuOpen(false);
    if (mobileOS.current === "ios") {
      window.location.href = IOS_STORE_URL;
    } else if (mobileOS.current === "android") {
      window.location.href = ANDROID_STORE_URL;
    } else {
      scrollTo("download");
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground overflow-x-hidden font-sans antialiased">
      {/* ================= Header ================= */}
      <header
        className={`fixed top-0 w-full z-50 transition-all duration-300 ${
          scrolled
            ? "bg-background/85 backdrop-blur-xl border-b border-border shadow-[0_1px_20px_-8px_rgba(0,0,0,0.15)]"
            : "bg-transparent border-b border-transparent"
        }`}
      >
        <div className="container mx-auto px-5 lg:px-8 h-[72px] flex items-center justify-between">
          <button
            className="flex items-center cursor-pointer"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            aria-label="Back to top"
          >
            <img src={logoWordPath} alt="KKamera" className="h-9 md:h-10 w-auto" />
          </button>

          <nav className="hidden md:flex items-center gap-1">
            {navLinks.map((link) => (
              <button
                key={link.id}
                onClick={() => scrollTo(link.id)}
                className="px-3.5 py-2 text-sm font-medium text-muted-foreground hover:text-foreground rounded-full hover:bg-muted transition-colors"
              >
                {link.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            {isHandheld && (
              <Button
                onClick={launchApp}
                className="font-semibold rounded-full px-4 md:px-5 shadow-sm shadow-primary/25"
              >
                Launch app
              </Button>
            )}
            <Button
              onClick={() => scrollTo("pricing")}
              className="hidden md:inline-flex font-semibold rounded-full px-5 shadow-sm shadow-primary/25"
              variant={isHandheld ? "outline" : "default"}
            >
              Get started
            </Button>

            <button
              className="md:hidden p-2 -mr-2 text-foreground"
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              aria-label="Toggle menu"
            >
              {isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
            </button>
          </div>
        </div>

        {isMobileMenuOpen && (
          <div className="md:hidden bg-background/95 backdrop-blur-xl border-b border-border shadow-lg py-4 px-5 flex flex-col gap-1">
            {navLinks.map((link) => (
              <button
                key={link.id}
                onClick={() => scrollTo(link.id)}
                className="text-left font-medium p-3 hover:bg-muted rounded-lg transition-colors"
              >
                {link.label}
              </button>
            ))}
            <div className="h-px bg-border my-2" />
            {isHandheld && (
              <Button
                className="w-full justify-center rounded-full"
                onClick={launchApp}
              >
                Launch app
              </Button>
            )}
            <Button
              variant={isHandheld ? "outline" : "default"}
              className="w-full justify-center rounded-full mt-1"
              onClick={() => scrollTo("pricing")}
            >
              Get started
            </Button>
          </div>
        )}
      </header>

      <main>
        {/* ================= Hero ================= */}
        <section className="relative overflow-hidden pt-32 pb-20 lg:pt-40 lg:pb-28 px-5 lg:px-8">
          {/* Subtle grid backdrop instead of gradient blobs */}
          <div
            className="absolute inset-0 -z-10 opacity-[0.4] pointer-events-none"
            style={{
              backgroundImage:
                "linear-gradient(to right, hsl(var(--border)/0.6) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--border)/0.6) 1px, transparent 1px)",
              backgroundSize: "56px 56px",
              maskImage:
                "radial-gradient(ellipse 80% 60% at 50% 0%, black 40%, transparent 100%)",
              WebkitMaskImage:
                "radial-gradient(ellipse 80% 60% at 50% 0%, black 40%, transparent 100%)",
            }}
          />

          <div className="container mx-auto max-w-6xl grid lg:grid-cols-[1.05fr_0.95fr] gap-14 lg:gap-10 items-center">
            {/* Left: copy */}
            <div className="min-w-0 text-center lg:text-left">
              <motion.h1
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.05 }}
                className="font-display font-semibold tracking-[-0.02em] text-[2.15rem] leading-[1.05] sm:text-6xl sm:leading-[1.02] lg:text-[4.3rem] text-foreground"
              >
                Keep your work
                <br />
                off your
                <br />
                <span className="relative inline-block whitespace-nowrap text-primary">
                  personal phone
                  <svg
                    className="absolute -bottom-2 left-0 w-full"
                    height="10"
                    viewBox="0 0 300 10"
                    fill="none"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M2 7C60 3 120 2 180 4C220 5 260 6 298 4"
                      stroke="hsl(var(--primary))"
                      strokeWidth="3"
                      strokeLinecap="round"
                      opacity="0.5"
                    />
                  </svg>
                </span>
                .
              </motion.h1>

              <motion.p
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.12 }}
                className="mt-7 text-lg text-muted-foreground leading-relaxed max-w-xl mx-auto lg:mx-0"
              >
                KKamera sends every work photo and video straight to your secure
                business cloud — never your camera roll. Your job sites stay
                organised, your family photos stay private.
              </motion.p>

              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.18 }}
                className="mt-9 flex flex-col sm:flex-row items-center lg:justify-start justify-center gap-3"
              >
                <Button
                  size="lg"
                  className="w-full sm:w-auto text-base h-13 px-7 py-3.5 rounded-full font-semibold shadow-lg shadow-primary/25"
                  onClick={goToAppStore}
                >
                  Start free trial <ArrowRight className="ml-1.5 h-4.5 w-4.5" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="lg"
                      variant="outline"
                      className="w-full sm:w-auto text-base h-13 px-7 py-3.5 rounded-full font-semibold border-border bg-card hover:bg-muted"
                    >
                      Download now <ChevronDown className="ml-1.5 h-4.5 w-4.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="center" className="w-60 rounded-2xl p-2">
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                      Native apps launching soon
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled
                      className="rounded-xl py-2.5 gap-3 opacity-100 data-[disabled]:opacity-100"
                    >
                      <SiApple className="h-5 w-5 text-foreground" />
                      <div className="flex flex-col leading-tight">
                        <span className="font-medium text-foreground">App Store</span>
                        <span className="text-[11px] text-muted-foreground">
                          iPhone &amp; iPad
                        </span>
                      </div>
                      <span className="ml-auto rounded-full bg-primary/12 text-primary text-[10px] font-semibold px-2 py-0.5">
                        Soon
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled
                      className="rounded-xl py-2.5 gap-3 opacity-100 data-[disabled]:opacity-100"
                    >
                      <SiGoogleplay className="h-5 w-5 text-foreground" />
                      <div className="flex flex-col leading-tight">
                        <span className="font-medium text-foreground">Google Play</span>
                        <span className="text-[11px] text-muted-foreground">
                          Android devices
                        </span>
                      </div>
                      <span className="ml-auto rounded-full bg-primary/12 text-primary text-[10px] font-semibold px-2 py-0.5">
                        Soon
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </motion.div>

              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.6, delay: 0.28 }}
                className="mt-8 flex flex-wrap items-center lg:justify-start justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground"
              >
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck className="h-4 w-4 text-primary" /> Secure cloud storage
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Smartphone className="h-4 w-4 text-primary" /> iOS &amp; Android
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="h-4 w-4 text-primary" /> Aussie-owned
                </span>
              </motion.div>
            </div>

            {/* Right: phone mockup */}
            <motion.div
              initial={{ opacity: 0, y: 30, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.7, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
              className="relative min-w-0 flex justify-center lg:justify-end"
            >
              {/* Soft panel behind the phone */}
              <div className="absolute inset-0 m-auto h-[80%] w-[86%] rounded-[2.5rem] bg-gradient-to-br from-accent to-muted -z-10 rotate-3" />

              <div className="relative w-[290px] sm:w-[320px]">
                {/* Physical side buttons */}
                <div className="absolute left-[-2px] top-[104px] h-8 w-1 rounded-l-md bg-ink" />
                <div className="absolute left-[-2px] top-[148px] h-12 w-1 rounded-l-md bg-ink" />
                <div className="absolute right-[-2px] top-[128px] h-16 w-1 rounded-r-md bg-ink" />
                {/* Phone frame */}
                <div className="relative rounded-[2.75rem] bg-ink p-3 shadow-2xl shadow-black/25 ring-1 ring-black/10">
                  <div className="relative rounded-[2.1rem] overflow-hidden bg-card">
                    {/* Dynamic island */}
                    <div className="absolute left-1/2 top-2.5 z-20 h-5 w-20 -translate-x-1/2 rounded-full bg-ink" />
                    {/* Status bar */}
                    <div className="flex items-center justify-between px-6 pt-2.5 pb-1">
                      <span className="text-[11px] font-semibold text-foreground/75">
                        9:41
                      </span>
                      <div className="flex items-center gap-1.5">
                        <div className="flex items-end gap-[1.5px]">
                          <span className="h-1.5 w-[3px] rounded-[1px] bg-foreground/50" />
                          <span className="h-2 w-[3px] rounded-[1px] bg-foreground/60" />
                          <span className="h-2.5 w-[3px] rounded-[1px] bg-foreground/70" />
                        </div>
                        <div className="relative h-2.5 w-5 rounded-[3px] border border-foreground/45">
                          <span className="absolute inset-[1.5px] right-1.5 rounded-[1px] bg-foreground/60" />
                        </div>
                      </div>
                    </div>
                    {/* App bar */}
                    <div className="flex items-center justify-between px-4 pt-2 pb-3 bg-card">
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
                          <Cloud className="h-4.5 w-4.5" />
                        </div>
                        <div className="leading-tight">
                          <div className="text-[13px] font-semibold text-foreground">
                            Business Cloud
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            326 files · synced
                          </div>
                        </div>
                      </div>
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-[11px] font-bold">
                        JM
                      </div>
                    </div>

                    {/* Gallery */}
                    <div className="grid grid-cols-3 gap-1 px-2 pb-2">
                      {workImages.map((src, i) => (
                        <div
                          key={i}
                          className="aspect-square overflow-hidden rounded-md"
                        >
                          <img
                            src={src}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        </div>
                      ))}
                    </div>

                    {/* Camera dock */}
                    <div className="flex items-center justify-between gap-2 px-3 py-3 border-t border-border bg-muted/50">
                      <div className="text-[11px] font-medium text-muted-foreground">
                        Tap to capture
                      </div>
                      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md shadow-primary/30">
                        <Camera className="h-5 w-5" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Floating "uploaded" chip */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.7 }}
                  className="absolute -left-6 top-24 rounded-xl bg-card border border-border shadow-xl px-3.5 py-2.5 flex items-center gap-2.5"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/12 text-primary">
                    <CloudUpload className="h-4 w-4" />
                  </div>
                  <div className="leading-tight">
                    <div className="text-[11px] font-semibold text-foreground">
                      Uploaded to cloud
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      Not saved to camera roll
                    </div>
                  </div>
                </motion.div>

                {/* Floating "personal untouched" chip */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.9 }}
                  className="absolute -right-4 bottom-16 rounded-xl bg-ink text-ink-foreground shadow-xl px-3.5 py-2.5 flex items-center gap-2.5"
                >
                  <Lock className="h-4 w-4 text-primary" />
                  <div className="text-[11px] font-semibold">
                    Personal gallery
                    <br />
                    <span className="font-normal text-ink-foreground/70">
                      stays private
                    </span>
                  </div>
                </motion.div>
              </div>
            </motion.div>
          </div>
        </section>

        {/* ================= Trust strip ================= */}
        <section className="border-y border-border bg-muted/40 px-5 lg:px-8">
          <div className="container mx-auto max-w-6xl py-7 flex flex-col md:flex-row items-center gap-x-8 gap-y-4">
            <p className="text-sm font-medium text-muted-foreground shrink-0">
              Built for the trades that shoot all day
            </p>
            <div className="flex flex-wrap justify-center gap-2.5">
              {[
                "Plumbing",
                "Electrical",
                "Construction",
                "HVAC",
                "Roofing",
                "Landscaping",
                "Photographers",
                "Videographers",
                "IT Professional",
                "Tournament Directors",
              ].map((trade) => (
                <span
                  key={trade}
                  className="rounded-full border border-border bg-card px-3.5 py-1.5 text-sm font-medium text-foreground/80"
                >
                  {trade}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* ================= Problem / Solution ================= */}
        <section id="problem-solution" className="py-24 lg:py-28 px-5 lg:px-8">
          <div className="container mx-auto max-w-6xl">
            <div className="max-w-2xl mb-14">
              <Eyebrow>The problem</Eyebrow>
              <h2 className="mt-4 font-display font-semibold tracking-[-0.02em] text-3xl md:text-5xl leading-[1.05] text-foreground">
                Work photos shouldn't live next to your family memories.
              </h2>
              <p className="mt-5 text-lg text-muted-foreground leading-relaxed">
                Every job site snap, wiring close-up and receipt ends up buried in
                the same camera roll as your holidays and kids. KKamera draws a
                clean line between the two.
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-6 lg:gap-8">
              {/* Before */}
              <motion.div
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5 }}
                className="rounded-2xl border border-border bg-card p-6 md:p-8"
              >
                <div className="flex items-center gap-2.5 mb-5">
                  <span className="rounded-full bg-destructive/10 text-destructive text-xs font-semibold uppercase tracking-wider px-3 py-1">
                    Before
                  </span>
                  <span className="text-sm text-muted-foreground">
                    One messy camera roll
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {[
                    workImg1,
                    personalImg1,
                    workImg2,
                    personalImg2,
                    personalImg3,
                    workImg3,
                    workImg4,
                    personalImg4,
                    personalImg5,
                    workImg5,
                    workImg6,
                    personalImg6,
                  ].map((src, i) => (
                    <div
                      key={i}
                      className="aspect-square overflow-hidden rounded-md grayscale-[0.15]"
                    >
                      <img src={src} alt="" className="h-full w-full object-cover" />
                    </div>
                  ))}
                </div>
                <p className="mt-5 text-sm text-muted-foreground">
                  Job sites, receipts, wiring and weddings — all jumbled together
                  and impossible to find later.
                </p>
              </motion.div>

              {/* After */}
              <motion.div
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: 0.12 }}
                className="rounded-2xl border-2 border-primary/25 bg-card p-6 md:p-8 shadow-xl shadow-primary/5 relative"
              >
                <div className="flex items-center gap-2.5 mb-5">
                  <span className="rounded-full bg-primary/12 text-primary text-xs font-semibold uppercase tracking-wider px-3 py-1">
                    With KKamera
                  </span>
                  <span className="text-sm text-muted-foreground">
                    Two separate places
                  </span>
                </div>

                <div className="space-y-4">
                  <div>
                    <div className="flex items-center gap-1.5 mb-2 text-xs font-semibold uppercase tracking-wider text-primary">
                      <Cloud className="h-3.5 w-3.5" /> Business Cloud
                    </div>
                    <div className="grid grid-cols-6 gap-1.5">
                      {workImages.map((src, i) => (
                        <div
                          key={i}
                          className="aspect-square overflow-hidden rounded-md ring-1 ring-primary/15"
                        >
                          <img
                            src={src}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <Lock className="h-3.5 w-3.5" /> Personal Gallery
                    </div>
                    <div className="grid grid-cols-6 gap-1.5">
                      {personalImages.map((src, i) => (
                        <div
                          key={i}
                          className="aspect-square overflow-hidden rounded-md ring-1 ring-border"
                        >
                          <img
                            src={src}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <p className="mt-5 text-sm font-medium text-foreground inline-flex items-center gap-2">
                  <Check className="h-4 w-4 text-primary" />
                  Clean separation. Zero clutter. Complete privacy.
                </p>
              </motion.div>
            </div>
          </div>
        </section>

        {/* ================= Features ================= */}
        <section id="features" className="py-24 lg:py-28 px-5 lg:px-8 bg-muted/40 border-y border-border">
          <div className="container mx-auto max-w-6xl">
            <div className="max-w-2xl mb-14">
              <Eyebrow>Features</Eyebrow>
              <h2 className="mt-4 font-display font-semibold tracking-[-0.02em] text-3xl md:text-5xl leading-[1.05] text-foreground">
                Everything you need to manage work media.
              </h2>
              <p className="mt-5 text-lg text-muted-foreground leading-relaxed">
                Purpose-built for tradespeople and professionals who live and die
                by visual documentation.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {[
                {
                  icon: CloudUpload,
                  title: "Instant upload",
                  desc: "Photos and videos go straight to your business cloud the moment you take them.",
                },
                {
                  icon: FolderLock,
                  title: "Gallery stays personal",
                  desc: "Your family memories are never touched. We never save to your local camera roll.",
                },
                {
                  icon: Cloud,
                  title: "Business cloud account",
                  desc: "All your work media organised, searchable and secure in one dedicated place.",
                },
                {
                  icon: Share2,
                  title: "Share with clients",
                  desc: "Send professional links to clients and colleagues — no more giant email attachments.",
                },
                {
                  icon: ShieldCheck,
                  title: "Complete privacy",
                  desc: "Personal photos never mix with work, keeping your private life fully protected.",
                },
                {
                  icon: Smartphone,
                  title: "Works everywhere",
                  desc: "Native apps for iOS and Android, plus a web portal to access files from any device.",
                },
              ].map((feature, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.45, delay: (i % 3) * 0.08 }}
                  className="group relative rounded-2xl border border-border bg-card p-7 transition-all hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5 hover:-translate-y-0.5"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                    <feature.icon className="h-6 w-6" />
                  </div>
                  <h3 className="mt-5 text-lg font-semibold text-foreground">
                    {feature.title}
                  </h3>
                  <p className="mt-2 text-muted-foreground leading-relaxed">
                    {feature.desc}
                  </p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* ================= How it works (dark) ================= */}
        <section
          id="how-it-works"
          className="py-24 lg:py-32 px-5 lg:px-8 bg-ink text-ink-foreground"
        >
          <div className="container mx-auto max-w-6xl">
            <div className="max-w-2xl mb-16">
              <span className="inline-flex items-center gap-2.5 text-xs font-semibold uppercase tracking-[0.2em] text-primary">
                <span className="h-px w-6 bg-primary/60" />
                How it works
              </span>
              <h2 className="mt-4 font-display font-semibold tracking-[-0.02em] text-3xl md:text-5xl leading-[1.05]">
                Three steps. Then it stays out of your way.
              </h2>
            </div>

            <div className="grid md:grid-cols-3 gap-6 lg:gap-8">
              {[
                {
                  step: "01",
                  title: "Take the photo",
                  desc: "Open KKamera and shoot your work photos or videos, just like your normal camera.",
                },
                {
                  step: "02",
                  title: "It auto-uploads",
                  desc: "Files sync instantly to your secure business cloud account over Wi-Fi or mobile data.",
                },
                {
                  step: "03",
                  title: "Stay clean",
                  desc: "Nothing lands on your camera roll. Your personal gallery stays completely clutter-free.",
                },
              ].map((item, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 24 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: i * 0.15 }}
                  className="relative rounded-2xl border border-white/10 bg-white/[0.03] p-8"
                >
                  <div className="font-display text-5xl font-semibold text-primary/90">
                    {item.step}
                  </div>
                  <h3 className="mt-4 text-xl font-semibold">{item.title}</h3>
                  <p className="mt-2.5 text-ink-foreground/70 leading-relaxed">
                    {item.desc}
                  </p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* ================= Pricing ================= */}
        <section id="pricing" className="py-24 lg:py-28 px-5 lg:px-8">
          <div className="container mx-auto max-w-6xl grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            <div>
              <Eyebrow>Pricing</Eyebrow>
              <h2 className="mt-4 font-display font-semibold tracking-[-0.02em] text-3xl md:text-5xl leading-[1.05] text-foreground">
                One simple plan. Everything included.
              </h2>
              <p className="mt-5 text-lg text-muted-foreground leading-relaxed">
                No tiers, no per-photo fees, no surprises. Start with a free trial
                and keep your work and life separated from day one.
              </p>
              <ul className="mt-8 space-y-3.5">
                {[
                  "Unlimited photo & video uploads",
                  "Secure business cloud storage",
                  "Instant auto-sync from the app",
                  "Client sharing links",
                  "iOS, Android & web portal access",
                ].map((item, i) => (
                  <li key={i} className="flex items-center gap-3">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-primary shrink-0">
                      <Check className="h-3.5 w-3.5" />
                    </span>
                    <span className="text-foreground/90">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <motion.div
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="relative rounded-3xl border border-border bg-card p-8 md:p-10 shadow-2xl shadow-primary/5"
            >
              <span className="absolute top-6 right-6 rounded-full bg-primary/12 text-primary text-xs font-semibold px-3 py-1">
                Free trial
              </span>
              <h3 className="text-lg font-semibold text-foreground">
                Professional Plan
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Full access to KKamera cloud storage
              </p>

              <div className="mt-6 flex items-end gap-1.5">
                <span className="font-display text-6xl font-semibold tracking-tight text-foreground">
                  $30
                </span>
                <span className="mb-2 text-muted-foreground">/ year</span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                That's about $2.50 a month, billed annually.
              </p>

              <Button
                size="lg"
                className="mt-8 w-full h-13 text-base rounded-full font-semibold shadow-lg shadow-primary/25"
                onClick={goToAppStore}
              >
                Start free trial <ArrowRight className="ml-1.5 h-4.5 w-4.5" />
              </Button>
              <p className="mt-4 text-center text-xs text-muted-foreground">
                No credit card required to start · Cancel anytime
              </p>
            </motion.div>
          </div>
        </section>

        {/* ================= Download ================= */}
        <section
          id="download"
          className="py-20 px-5 lg:px-8 bg-muted/40 border-y border-border"
        >
          <div className="container mx-auto max-w-4xl text-center">
            <Eyebrow>Get the app</Eyebrow>
            <h2 className="mt-4 font-display font-semibold tracking-[-0.02em] text-2xl md:text-4xl text-foreground">
              Coming soon to iOS &amp; Android
            </h2>
            <p className="mt-3 text-muted-foreground max-w-lg mx-auto">
              Native apps are on the way. In the meantime, log in to the web portal
              to access your business cloud.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
              {[
                { icon: SiApple, top: "Download on the", bottom: "App Store" },
                { icon: SiGoogleplay, top: "Get it on", bottom: "Google Play" },
              ].map(({ icon: Icon, top, bottom }, i) => (
                <div key={i} className="relative group">
                  <button className="h-16 px-7 w-60 rounded-2xl bg-card border border-border hover:border-primary/40 transition-colors flex items-center gap-4">
                    <Icon className="w-7 h-7 text-foreground" />
                    <div className="text-left flex flex-col">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground leading-none">
                        {top}
                      </span>
                      <span className="text-lg font-semibold leading-tight text-foreground">
                        {bottom}
                      </span>
                    </div>
                  </button>
                  <span className="absolute -top-2.5 -right-2.5 bg-primary text-primary-foreground text-[10px] font-bold px-2.5 py-1 rounded-full shadow-sm">
                    Soon
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ================= Help / FAQ ================= */}
        <section id="help" className="py-24 lg:py-28 px-5 lg:px-8">
          <div className="container mx-auto max-w-5xl grid lg:grid-cols-[0.8fr_1.2fr] gap-12 lg:gap-16">
            <div>
              <Eyebrow>Help &amp; setup</Eyebrow>
              <h2 className="mt-4 font-display font-semibold tracking-[-0.02em] text-3xl md:text-4xl leading-[1.08] text-foreground">
                Everything you need to get started.
              </h2>
              <p className="mt-5 text-muted-foreground leading-relaxed">
                Still stuck? Our team is one message away — head to the{" "}
                <button
                  onClick={() => scrollTo("contact")}
                  className="text-primary font-medium hover:underline"
                >
                  contact form
                </button>{" "}
                and we'll sort it out.
              </p>
            </div>

            <Accordion type="single" collapsible className="w-full space-y-3">
              {[
                {
                  q: "How do I set up KKamera?",
                  a: (
                    <ol className="list-decimal pl-5 space-y-1.5">
                      <li>Download the app from your app store.</li>
                      <li>Sign in with your professional account.</li>
                      <li>Grant camera permissions when prompted.</li>
                      <li>
                        Start shooting — your photos automatically upload to the
                        business cloud.
                      </li>
                    </ol>
                  ),
                },
                {
                  q: "How does the automatic upload work?",
                  a: "The moment you take a photo or video within the KKamera app, it's securely transmitted to your business cloud over your mobile or Wi-Fi connection. Nothing is saved locally to your device's camera roll.",
                },
                {
                  q: "Where are my business photos stored?",
                  a: "All media is stored on secure, enterprise-grade cloud servers. You can access your full gallery anytime by logging into the KKamera web portal from any computer or device.",
                },
                {
                  q: "Can I access my photos from a computer?",
                  a: "Yes. Click \"Log in\" at the top of the site to open the web portal, where you can view, download, organise and share all your uploaded media.",
                },
                {
                  q: "Is my personal gallery affected?",
                  a: "Not at all. KKamera operates in its own secure sandbox and never accesses, views or modifies your personal camera roll. Your family photos stay completely separate from your work documentation.",
                },
                {
                  q: "How do I share photos with clients?",
                  a: "From the web portal or the app, select specific photos, albums or videos and generate a secure sharing link. Text or email that link to clients — no more giant attachments.",
                },
              ].map((item, i) => (
                <AccordionItem
                  key={i}
                  value={`item-${i}`}
                  className="rounded-xl border border-border bg-card px-5 data-[state=open]:border-primary/30 transition-colors"
                >
                  <AccordionTrigger className="text-left font-semibold text-base hover:no-underline py-5">
                    {item.q}
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground leading-relaxed pb-5">
                    {item.a}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>

        {/* ================= Contact ================= */}
        <section
          id="contact"
          className="py-24 lg:py-28 px-5 lg:px-8 bg-muted/40 border-t border-border"
        >
          <div className="container mx-auto max-w-2xl">
            <div className="text-center mb-12">
              <Eyebrow>Contact</Eyebrow>
              <h2 className="mt-4 font-display font-semibold tracking-[-0.02em] text-3xl md:text-5xl leading-[1.05] text-foreground">
                Get in touch.
              </h2>
              <p className="mt-4 text-lg text-muted-foreground">
                Questions or need a hand? We're here to help.
              </p>
            </div>

            <div className="rounded-2xl bg-card border border-border p-6 md:p-9 shadow-xl shadow-black/5">
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
                  <div className="grid md:grid-cols-2 gap-5">
                    <FormField
                      control={form.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-foreground font-medium">
                            Name
                          </FormLabel>
                          <FormControl>
                            <Input
                              placeholder="John Doe"
                              {...field}
                              className="bg-background h-12 rounded-xl"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="email"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-foreground font-medium">
                            Email
                          </FormLabel>
                          <FormControl>
                            <Input
                              placeholder="john@example.com"
                              type="email"
                              {...field}
                              className="bg-background h-12 rounded-xl"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="subject"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-foreground font-medium">
                          Subject
                        </FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          defaultValue={field.value}
                        >
                          <FormControl>
                            <SelectTrigger className="bg-background h-12 rounded-xl">
                              <SelectValue placeholder="Select a subject" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="General Enquiry">
                              General Enquiry
                            </SelectItem>
                            <SelectItem value="Technical Support">
                              Technical Support
                            </SelectItem>
                            <SelectItem value="Billing">Billing</SelectItem>
                            <SelectItem value="Feature Request">
                              Feature Request
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="message"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-foreground font-medium">
                          Message
                        </FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="How can we help you?"
                            className="resize-none bg-background rounded-xl min-h-[140px] p-4"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <Button
                    type="submit"
                    size="lg"
                    className="w-full h-13 text-base rounded-full font-semibold shadow-md"
                  >
                    Send message <ArrowUpRight className="ml-1.5 h-4.5 w-4.5" />
                  </Button>
                </form>
              </Form>
            </div>
          </div>
        </section>
      </main>

      {/* ================= Footer ================= */}
      <footer className="bg-ink text-ink-foreground pt-16 pb-10 px-5 lg:px-8">
        <div className="container mx-auto max-w-6xl">
          <div className="grid md:grid-cols-4 gap-10 md:gap-12 pb-12">
            <div className="md:col-span-2">
              <img
                src={logoWordPath}
                alt="KKamera"
                className="h-9 w-auto mb-5 brightness-0 invert opacity-90"
              />
              <p className="text-ink-foreground/70 text-lg max-w-sm leading-relaxed">
                Keep your work and life in their place. Cloud-based photography,
                built for the trades.
              </p>
              <a
                href="mailto:development@koastal.com.au"
                className="mt-5 inline-block text-primary hover:underline font-medium"
              >
                development@koastal.com.au
              </a>
            </div>

            <div>
              <h4 className="font-semibold uppercase tracking-wider text-xs text-ink-foreground/50 mb-5">
                Product
              </h4>
              <ul className="space-y-3">
                {[
                  { id: "how-it-works", label: "How it works" },
                  { id: "features", label: "Features" },
                  { id: "pricing", label: "Pricing" },
                  { id: "download", label: "Get the app" },
                ].map((l) => (
                  <li key={l.id}>
                    <button
                      onClick={() => scrollTo(l.id)}
                      className="text-ink-foreground/70 hover:text-primary transition-colors text-sm"
                    >
                      {l.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h4 className="font-semibold uppercase tracking-wider text-xs text-ink-foreground/50 mb-5">
                Support
              </h4>
              <ul className="space-y-3">
                <li>
                  <button
                    onClick={() => scrollTo("help")}
                    className="text-ink-foreground/70 hover:text-primary transition-colors text-sm"
                  >
                    Help &amp; setup
                  </button>
                </li>
                <li>
                  <button
                    onClick={() => scrollTo("contact")}
                    className="text-ink-foreground/70 hover:text-primary transition-colors text-sm"
                  >
                    Contact us
                  </button>
                </li>
                <li>
                  <Link
                    href="/support"
                    className="text-ink-foreground/70 hover:text-primary transition-colors text-sm"
                  >
                    Account &amp; billing
                  </Link>
                </li>
              </ul>
            </div>
          </div>

          <div className="pt-8 border-t border-white/10 flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-ink-foreground/50 text-sm">
              © 2026 Koastal. All rights reserved.
            </p>
            <div className="flex gap-6">
              <Link
                href="/privacy"
                className="text-ink-foreground/50 hover:text-primary transition-colors text-sm"
              >
                Privacy Policy
              </Link>
              <Link
                href="/terms"
                className="text-ink-foreground/50 hover:text-primary transition-colors text-sm"
              >
                Terms of Service
              </Link>
            </div>
          </div>
          <div className="mt-6 text-center text-sm text-ink-foreground/50">
            Proudly Australian. 🇦🇺 Designed, Hosted and Maintained by{" "}
            <a
              href="https://www.koastal.com.au"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline font-medium"
            >
              Koastal Kollective – Website Design, Software and App Development
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
