import { getUncachableRevenueCatClient } from "./revenueCatClient.js";
import {
  listProjects, createProject,
  listApps, createApp,
  listAppPublicApiKeys,
  listProducts, createProduct,
  listEntitlements, createEntitlement, attachProductsToEntitlement,
  listOfferings, createOffering, updateOffering,
  listPackages, createPackages, attachProductsToPackage,
  type App, type Product, type Project, type Entitlement, type Offering, type Package, type CreateProductData,
} from "@replit/revenuecat-sdk";

const PROJECT_NAME = "KKamera";
const PRODUCT_IDENTIFIER = "kkamera_annual";
const PLAY_STORE_PRODUCT_IDENTIFIER = "kkamera_annual:annual";
const PRODUCT_DISPLAY_NAME = "KKamera Annual";
const PRODUCT_USER_FACING_TITLE = "KKamera — Annual";
const PRODUCT_DURATION = "P1Y";

const APP_STORE_APP_NAME = "KKamera iOS";
const APP_STORE_BUNDLE_ID = "com.kkamera.app";
const PLAY_STORE_APP_NAME = "KKamera Android";
const PLAY_STORE_PACKAGE_NAME = "com.kkamera.app";

const ENTITLEMENT_IDENTIFIER = "pro";
const ENTITLEMENT_DISPLAY_NAME = "Pro Access";

const OFFERING_IDENTIFIER = "default";
const OFFERING_DISPLAY_NAME = "Default Offering";

const PACKAGE_IDENTIFIER = "$rc_annual";
const PACKAGE_DISPLAY_NAME = "Annual Subscription";

// $25/year = 25_000_000 micros
const PRODUCT_PRICES = [
  { amount_micros: 25_000_000, currency: "USD" },
  { amount_micros: 22_990_000, currency: "EUR" },
  { amount_micros: 19_990_000, currency: "GBP" },
];

type TestStorePricesResponse = { object: string; prices: { amount_micros: number; currency: string }[] };

async function seedRevenueCat() {
  const client = await getUncachableRevenueCatClient();

  // Project
  let project: Project;
  const { data: existingProjects, error: listProjectsError } = await listProjects({ client, query: { limit: 20 } });
  if (listProjectsError) throw new Error("Failed to list projects");
  const existingProject = existingProjects.items?.find((p) => p.name === PROJECT_NAME);
  if (existingProject) {
    console.log("Project already exists:", existingProject.id);
    project = existingProject;
  } else {
    const { data: newProject, error } = await createProject({ client, body: { name: PROJECT_NAME } });
    if (error) throw new Error("Failed to create project");
    console.log("Created project:", newProject.id);
    project = newProject;
  }

  // Apps
  const { data: apps, error: listAppsError } = await listApps({ client, path: { project_id: project.id }, query: { limit: 20 } });
  if (listAppsError || !apps || apps.items.length === 0) throw new Error("No apps found in project");

  let testApp: App | undefined = apps.items.find((a) => a.type === "test_store");
  let appStoreApp: App | undefined = apps.items.find((a) => a.type === "app_store");
  let playStoreApp: App | undefined = apps.items.find((a) => a.type === "play_store");

  if (!testApp) throw new Error("No test store app found — check your RevenueCat project setup");
  console.log("Test Store app:", testApp.id);

  if (!appStoreApp) {
    const { data: newApp, error } = await createApp({
      client, path: { project_id: project.id },
      body: { name: APP_STORE_APP_NAME, type: "app_store", app_store: { bundle_id: APP_STORE_BUNDLE_ID } },
    });
    if (error) throw new Error("Failed to create App Store app");
    appStoreApp = newApp;
    console.log("Created App Store app:", appStoreApp.id);
  } else {
    console.log("App Store app:", appStoreApp.id);
  }

  if (!playStoreApp) {
    const { data: newApp, error } = await createApp({
      client, path: { project_id: project.id },
      body: { name: PLAY_STORE_APP_NAME, type: "play_store", play_store: { package_name: PLAY_STORE_PACKAGE_NAME } },
    });
    if (error) throw new Error("Failed to create Play Store app");
    playStoreApp = newApp;
    console.log("Created Play Store app:", playStoreApp.id);
  } else {
    console.log("Play Store app:", playStoreApp.id);
  }

  // Products
  const { data: existingProducts, error: listProductsError } = await listProducts({ client, path: { project_id: project.id }, query: { limit: 100 } });
  if (listProductsError) throw new Error("Failed to list products");

  const ensureProduct = async (targetApp: App, label: string, identifier: string, isTestStore: boolean): Promise<Product> => {
    const existing = existingProducts.items?.find((p) => p.store_identifier === identifier && p.app_id === targetApp.id);
    if (existing) { console.log(`${label} product exists:`, existing.id); return existing; }
    const body: CreateProductData["body"] = {
      store_identifier: identifier,
      app_id: targetApp.id,
      type: "subscription",
      display_name: PRODUCT_DISPLAY_NAME,
    };
    if (isTestStore) {
      body.subscription = { duration: PRODUCT_DURATION };
      body.title = PRODUCT_USER_FACING_TITLE;
    }
    const { data: created, error } = await createProduct({ client, path: { project_id: project.id }, body });
    if (error) throw new Error(`Failed to create ${label} product`);
    console.log(`Created ${label} product:`, created.id);
    return created;
  };

  const testProduct = await ensureProduct(testApp, "Test Store", PRODUCT_IDENTIFIER, true);
  const iosProduct = await ensureProduct(appStoreApp, "App Store", PRODUCT_IDENTIFIER, false);
  const androidProduct = await ensureProduct(playStoreApp, "Play Store", PLAY_STORE_PRODUCT_IDENTIFIER, false);

  // Test store prices
  const { data: _priceData, error: priceError } = await client.post<TestStorePricesResponse>({
    url: "/projects/{project_id}/products/{product_id}/test_store_prices",
    path: { project_id: project.id, product_id: testProduct.id },
    body: { prices: PRODUCT_PRICES },
  });
  if (priceError) {
    if (typeof priceError === "object" && "type" in priceError && (priceError as any).type === "resource_already_exists") {
      console.log("Test store prices already set");
    } else {
      throw new Error("Failed to set test store prices");
    }
  } else {
    console.log("Test store prices set: $25 USD / €22.99 EUR / £19.99 GBP");
  }

  // Entitlement
  let entitlement: Entitlement | undefined;
  const { data: existingEntitlements, error: listEntErr } = await listEntitlements({ client, path: { project_id: project.id }, query: { limit: 20 } });
  if (listEntErr) throw new Error("Failed to list entitlements");
  const existingEnt = existingEntitlements.items?.find((e) => e.lookup_key === ENTITLEMENT_IDENTIFIER);
  if (existingEnt) {
    console.log("Entitlement exists:", existingEnt.id);
    entitlement = existingEnt;
  } else {
    const { data: newEnt, error } = await createEntitlement({ client, path: { project_id: project.id }, body: { lookup_key: ENTITLEMENT_IDENTIFIER, display_name: ENTITLEMENT_DISPLAY_NAME } });
    if (error) throw new Error("Failed to create entitlement");
    console.log("Created entitlement:", newEnt.id);
    entitlement = newEnt;
  }

  const { error: attachEntErr } = await attachProductsToEntitlement({
    client, path: { project_id: project.id, entitlement_id: entitlement.id },
    body: { product_ids: [testProduct.id, iosProduct.id, androidProduct.id] },
  });
  if (attachEntErr && (attachEntErr as any).type !== "unprocessable_entity_error") {
    throw new Error("Failed to attach products to entitlement");
  }
  console.log("Products attached to entitlement");

  // Offering
  let offering: Offering | undefined;
  const { data: existingOfferings, error: listOffErr } = await listOfferings({ client, path: { project_id: project.id }, query: { limit: 20 } });
  if (listOffErr) throw new Error("Failed to list offerings");
  const existingOff = existingOfferings.items?.find((o) => o.lookup_key === OFFERING_IDENTIFIER);
  if (existingOff) {
    console.log("Offering exists:", existingOff.id);
    offering = existingOff;
  } else {
    const { data: newOff, error } = await createOffering({ client, path: { project_id: project.id }, body: { lookup_key: OFFERING_IDENTIFIER, display_name: OFFERING_DISPLAY_NAME } });
    if (error) throw new Error("Failed to create offering");
    console.log("Created offering:", newOff.id);
    offering = newOff;
  }
  if (!offering.is_current) {
    const { error } = await updateOffering({ client, path: { project_id: project.id, offering_id: offering.id }, body: { is_current: true } });
    if (error) throw new Error("Failed to set offering as current");
    console.log("Set offering as current");
  }

  // Package
  let pkg: Package | undefined;
  const { data: existingPkgs, error: listPkgErr } = await listPackages({ client, path: { project_id: project.id, offering_id: offering.id }, query: { limit: 20 } });
  if (listPkgErr) throw new Error("Failed to list packages");
  const existingPkg = existingPkgs.items?.find((p) => p.lookup_key === PACKAGE_IDENTIFIER);
  if (existingPkg) {
    console.log("Package exists:", existingPkg.id);
    pkg = existingPkg;
  } else {
    const { data: newPkg, error } = await createPackages({ client, path: { project_id: project.id, offering_id: offering.id }, body: { lookup_key: PACKAGE_IDENTIFIER, display_name: PACKAGE_DISPLAY_NAME } });
    if (error) throw new Error("Failed to create package");
    console.log("Created package:", newPkg.id);
    pkg = newPkg;
  }

  const { error: attachPkgErr } = await attachProductsToPackage({
    client, path: { project_id: project.id, package_id: pkg.id },
    body: { products: [
      { product_id: testProduct.id, eligibility_criteria: "all" },
      { product_id: iosProduct.id, eligibility_criteria: "all" },
      { product_id: androidProduct.id, eligibility_criteria: "all" },
    ]},
  });
  if (attachPkgErr && !(attachPkgErr as any).message?.includes("Cannot attach product")) {
    throw new Error("Failed to attach products to package");
  }
  console.log("Products attached to package");

  // API keys
  const { data: testKeys } = await listAppPublicApiKeys({ client, path: { project_id: project.id, app_id: testApp.id } });
  const { data: iosKeys } = await listAppPublicApiKeys({ client, path: { project_id: project.id, app_id: appStoreApp.id } });
  const { data: androidKeys } = await listAppPublicApiKeys({ client, path: { project_id: project.id, app_id: playStoreApp.id } });

  console.log("\n====================");
  console.log("RevenueCat setup complete!");
  console.log("Project ID:", project.id);
  console.log("  REVENUECAT_PROJECT_ID=" + project.id);
  console.log("  REVENUECAT_TEST_STORE_APP_ID=" + testApp.id);
  console.log("  REVENUECAT_APPLE_APP_STORE_APP_ID=" + appStoreApp.id);
  console.log("  REVENUECAT_GOOGLE_PLAY_STORE_APP_ID=" + playStoreApp.id);
  console.log("  EXPO_PUBLIC_REVENUECAT_TEST_API_KEY=" + (testKeys?.items.map((k) => k.key).join(", ") ?? "N/A"));
  console.log("  EXPO_PUBLIC_REVENUECAT_IOS_API_KEY=" + (iosKeys?.items.map((k) => k.key).join(", ") ?? "N/A"));
  console.log("  EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY=" + (androidKeys?.items.map((k) => k.key).join(", ") ?? "N/A"));
  console.log("====================");
  console.log("\nCopy the env vars above into Replit Secrets.");
}

seedRevenueCat().catch(console.error);
