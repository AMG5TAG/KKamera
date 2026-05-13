import { getStripeSync, getUncachableStripeClient } from "./stripeClient.js";
import { db } from "@workspace/db";
import { subscriptionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger.js";

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "STRIPE WEBHOOK ERROR: Payload must be a Buffer. " +
        "Ensure the webhook route is registered BEFORE app.use(express.json())."
      );
    }
    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);

    // Parse the event (already verified above) and mirror into our subscriptionsTable
    try {
      const event = JSON.parse(payload.toString("utf8")) as { type: string; data: { object: any } };
      await WebhookHandlers.handleSubscriptionEvent(event);
    } catch (err) {
      logger.error({ err }, "Subscription DB mirror failed after Stripe webhook");
    }
  }

  static async handleSubscriptionEvent(event: { type: string; data: { object: any } }): Promise<void> {
    const obj = event.data.object;

    switch (event.type) {
      case "checkout.session.completed": {
        if (obj.mode !== "subscription" || !obj.customer || !obj.subscription) break;
        try {
          const stripe = await getUncachableStripeClient();
          const stripeSub = await stripe.subscriptions.retrieve(obj.subscription as string) as any;
          const periodEnd = new Date((stripeSub.current_period_end as number) * 1000);
          await db.update(subscriptionsTable)
            .set({
              stripeSubscriptionId: obj.subscription as string,
              status: "active",
              currentPeriodEnd: periodEnd,
            })
            .where(eq(subscriptionsTable.stripeCustomerId, obj.customer as string));
          logger.info({ customerId: obj.customer }, "Subscription activated via checkout");
        } catch (err) {
          logger.error({ err }, "Failed to activate subscription after checkout");
        }
        break;
      }

      case "customer.subscription.updated": {
        const customerId = obj.customer as string;
        const periodEnd = new Date(obj.current_period_end * 1000);
        const stripeStatus: string = obj.status;
        const status =
          stripeStatus === "active" ? "active"
          : stripeStatus === "trialing" ? "trial"
          : stripeStatus === "past_due" ? "past_due"
          : stripeStatus === "canceled" ? "expired"
          : stripeStatus === "unpaid" ? "past_due"
          : "none";
        await db.update(subscriptionsTable)
          .set({ status, currentPeriodEnd: periodEnd, stripeSubscriptionId: obj.id as string })
          .where(eq(subscriptionsTable.stripeCustomerId, customerId));
        logger.info({ customerId, status }, "Subscription updated");
        break;
      }

      case "customer.subscription.deleted": {
        const customerId = obj.customer as string;
        await db.update(subscriptionsTable)
          .set({ status: "expired" })
          .where(eq(subscriptionsTable.stripeCustomerId, customerId));
        logger.info({ customerId }, "Subscription expired");
        break;
      }

      case "invoice.payment_failed": {
        const customerId = obj.customer as string;
        await db.update(subscriptionsTable)
          .set({ status: "past_due" })
          .where(eq(subscriptionsTable.stripeCustomerId, customerId));
        logger.info({ customerId }, "Subscription payment failed");
        break;
      }

      case "invoice.payment_succeeded": {
        if (obj.billing_reason === "subscription_cycle") {
          const customerId = obj.customer as string;
          const periodEnd = obj.lines?.data?.[0]?.period?.end
            ? new Date(obj.lines.data[0].period.end * 1000)
            : null;
          await db.update(subscriptionsTable)
            .set({ status: "active", ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}) })
            .where(eq(subscriptionsTable.stripeCustomerId, customerId));
          logger.info({ customerId }, "Subscription renewed");
        }
        break;
      }

      default:
        break;
    }
  }
}
