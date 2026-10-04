import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-github",
  entrypoint: ".wrangler/validate/src/github.ts",

  // Facet instances of this gatekeeper's DOs route their outbound fetches through the backend's
  // entrypoint binding, which proxies them (see GatekeeperVendor.fetch) — so the worker must have
  // no URL of its own: the router is the only public door.
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
  workersDev: false,
  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "GitHubGatekeeperImpl"] },
];
