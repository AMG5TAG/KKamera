import { getUncachableRevenueCatClient } from "./revenueCatClient.js";
import {
  listProjects,
  listWebhookIntegrations,
  createWebhookIntegration,
  updateWebhookIntegration,
  type Project,
  type WebhookIntegration,
} from "@replit/revenuecat-sdk";

// Registers (or updates) the RevenueCat webhook integration that mirrors IAP
// subscription state into our API. The webhook posts to our server with a shared
// secret in the Authorization header; the server (routes/revenuecat.ts) compares
// it byte-for-byte against REVENUECAT_WEBHOOK_AUTH. This script reads that SAME
// secret and sets it as the integration's authorization_header, so the two always
// match. Run it AFTER the secret is set in Replit Secrets and the API redeployed.

const PROJECT_NAME = "KKamera";
const WEBHOOK_NAME = "KKamera API";
const DEFAULT_URL = "https://app.kkamera.app/api/revenuecat/webhook";

async function setupWebhook() {
  const secret = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (!secret || secret.trim().length === 0) {
    throw new Error(
      "REVENUECAT_WEBHOOK_AUTH is not set. Generate one (`openssl rand -hex 32`), " +
      "add it to Replit Secrets, redeploy the API, then run this script again."
    );
  }

  const url = process.env.RC_WEBHOOK_URL?.trim() || DEFAULT_URL;
  const client = await getUncachableRevenueCatClient();

  // Project
  const { data: projects, error: listProjectsError } = await listProjects({ client, query: { limit: 20 } });
  if (listProjectsError) throw new Error("Failed to list projects");
  const project: Project | undefined = projects.items?.find((p) => p.name === PROJECT_NAME);
  if (!project) throw new Error(`Project "${PROJECT_NAME}" not found in RevenueCat`);
  console.log("Project:", project.id);

  // Existing webhook integrations for this project
  const { data: existing, error: listErr } = await listWebhookIntegrations({
    client, path: { project_id: project.id }, query: { limit: 50 },
  });
  if (listErr) throw new Error("Failed to list webhook integrations");
  const match: WebhookIntegration | undefined = existing.items?.find((w) => w.url === url);

  // environment: null → all environments (sandbox AND production) in one integration.
  // event_types: null → all events; our handler ignores the ones it doesn't map.
  const body = {
    name: WEBHOOK_NAME,
    url,
    authorization_header: secret,
    environment: null,
    event_types: null,
  };

  let result: WebhookIntegration;
  if (match) {
    const { data, error } = await updateWebhookIntegration({
      client, path: { project_id: project.id, webhook_integration_id: match.id }, body,
    });
    if (error) throw new Error(`Failed to update webhook integration: ${JSON.stringify(error)}`);
    result = data;
    console.log("Updated existing webhook integration:", result.id);
  } else {
    const { data, error } = await createWebhookIntegration({
      client, path: { project_id: project.id }, body,
    });
    if (error) throw new Error(`Failed to create webhook integration: ${JSON.stringify(error)}`);
    result = data;
    console.log("Created webhook integration:", result.id);
  }

  console.log("\n====================");
  console.log("RevenueCat webhook configured");
  console.log("  integration id:", result.id);
  console.log("  url:           ", result.url);
  console.log("  environment:   ", result.environment ?? "all (sandbox + production)");
  console.log("  event types:   ", result.event_types ?? "all");
  console.log("  auth header:    matches REVENUECAT_WEBHOOK_AUTH (not printed)");
  console.log("====================");
  console.log("\nVerify with:");
  console.log(`  curl -sS -o /dev/null -w "%{http_code}\\n" -X POST ${url} -H 'Content-Type: application/json' -d '{"event":{"type":"TEST"}}'`);
  console.log("  → expect 401 (secret set, header missing). 503 means the server still lacks the secret.");
}

setupWebhook().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
