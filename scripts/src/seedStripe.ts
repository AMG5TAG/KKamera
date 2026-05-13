import { getUncachableStripeClient } from "./stripeClient.js";

async function seedStripe() {
  const stripe = await getUncachableStripeClient();

  console.log("Checking for existing KKamera Annual product...");
  const existing = await stripe.products.search({ query: "name:'KKamera Annual' AND active:'true'" });

  if (existing.data.length > 0) {
    const product = existing.data[0]!;
    console.log("Product already exists:", product.id);
    const prices = await stripe.prices.list({ product: product.id, active: true });
    for (const p of prices.data) {
      console.log(`  Price: ${p.id} — ${p.unit_amount ? "$" + (p.unit_amount / 100).toFixed(2) : "?"} / ${(p.recurring?.interval ?? "one_time")}`);
    }
    return;
  }

  const product = await stripe.products.create({
    name: "KKamera Annual",
    description: "Full access to KKamera — unlimited uploads to FTP, WebDAV, Google Drive, OneDrive, and Dropbox.",
    metadata: { app: "kkamera", plan: "annual" },
  });
  console.log("Created product:", product.id);

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: 2500,
    currency: "usd",
    recurring: { interval: "year" },
  });
  console.log("Created price:", price.id, "— $25.00/year");

  console.log("\n====================");
  console.log("Stripe setup complete!");
  console.log("  STRIPE_PRICE_ID=" + price.id);
  console.log("====================");
  console.log("\nAdd STRIPE_PRICE_ID to Replit Secrets.");
}

seedStripe().catch(console.error);
