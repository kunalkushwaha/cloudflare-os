import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, defineGadgetsWorker,
  type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-factory",
  entrypoint: ".wrangler/validate/src/worker.ts",

  // The bridge dials the WebSocket route over the public origin; nothing here fetches out.
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],

  // FACTORY_PAIR_SECRET is set as a Worker secret in production (empty = pairing disabled).
  // In dev, run-dev-server.ts injects it from the root .dev.vars.

  // The bridge reaches this gatekeeper through the router's public origin; it has no URL of its own.
  workersDev: false,

  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["FactoryHubDurableObject", "FactoryGatekeeper"] },
];