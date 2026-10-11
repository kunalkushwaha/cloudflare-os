import {
  OBSERVABILITY, bindings, defineGadgetsWorker,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "workshop-backend",
  entrypoint: ".wrangler/validate/src/server.ts",

  // `global_fetch_strictly_public` makes the global fetch() function strictly fetch from
  // the public internet in production, rather than the legacy behavior in which same-zone
  // requests go directly to origin bypassing Cloudflare. This flag is important to protect
  // against SSRF, particularly in the webFetch agent tool, but also generally.
  //
  // When self-hosting with `workerd` stand-alone, it is already the default behavior that the
  // global fetch() function blocks private-network IP addresses or hostnames that resolve to such
  // addresses.
  //
  // Note that `wrangler dev` intentionally reconfigures its global outbound to permit fetching
  // from any address (so local services on localhost stay reachable), so this flag effectively
  // only takes effect in production or when running workerd stand-alone. That's an acceptable
  // tradeoff for dev.
  compatibilityFlags: [
    "allow_irrevocable_stub_storage",
    "global_fetch_strictly_public",

    // The pi-ai inference layer wraps the official provider SDKs (@anthropic-ai/sdk, openai,
    // @google/genai), which need Node compatibility. Puppeteer (used for Gadget PDF exports)
    // also requires Node compatibility. Otherwise, we'd only need nodejs_als.
    "nodejs_compat",
  ],

  // Gatekeeper service bindings: this deployment runs the Software Factory (home-lab bridge) and
  // the Scheduler. Core discovers them generically by the GATEKEEPER_ prefix.
  // The Workers AI binding gives the deployment its free-tier model transport; when CF_AI_GATEWAY
  // is set, the binding also carries gateway traffic without an API token.
  env: {
    // Wrangler will launch a Chrome instance locally to emulate the Browser Run API during
    // local development. Add `remote: true` to use a remote browser running on Cloudflare instead.
    BROWSER: bindings.browser(),

    // All DO classes (UserDurableObject, OverseerDurableObject, AdminSettings, PendingLogin, ...)
    // are reached via ctx.exports and need no explicit durable_objects binding.
    //
    // The KV ids are this home deployment's namespaces (created 2026-10-03). They are resource
    // identifiers, not credentials — a leaked id grants nothing without API auth — but they are
    // account-specific, so a fork deploying its own instance mints its own (`wrangler kv namespace
    // create`) and substitutes its own ids here.
    BLUEPRINTS: bindings.kv({ id: "2c8348e695c347dcbad1aef79195f214" }),
    AVATARS: bindings.kv({ id: "c02719c537bd4dc6a7a05fa7ab451b60" }),
    BLUEPRINT_CONTENT: bindings.r2({ name: "gadgets-blueprint-content" }),
    LOADER: bindings.workerLoader(),

    // RPC goes to the vendors' GatekeeperVendor entrypoint (the named export), matching what the
    // deploy service generates for customer instances; the router's bindings stay entrypoint-less
    // because it forwards whole HTTP requests to the default export.
    GATEKEEPER_FACTORY: bindings.worker({
      worker: "gatekeeper-factory", exportName: "GatekeeperVendor",
    }),
    GATEKEEPER_SCHEDULER: bindings.worker({
      worker: "gatekeeper-scheduler", exportName: "GatekeeperVendor",
    }),
    GATEKEEPER_GITHUB: bindings.worker({
      worker: "gatekeeper-github", exportName: "GatekeeperVendor",
    }),

    // Workers AI: the deployment's model transport (free daily neuron allowance). When
    // CF_AI_GATEWAY is set, this binding is also what carries gateway traffic without an API token.
    WORKERS_AI: bindings.ai(),
  },

  // Only the router is public; the backend is reached through service bindings alone.
  workersDev: false,

  // When deploying to prod, you may want to bundle the frontend as assets on the backend, like so.
  // But it's not the only way to do it.
  //
  // assets: {
  //   notFoundHandling: "single-page-application",
  //   runWorkerFirst: ["/api", "/api/*", "/blueprint-screenshot/*"],
  // },
  // with `ASSETS: bindings.assets()` in `env` and
  // `assetsDirectory: "../workshop-frontend/dist"` in `wrangler`.
  observability: {
    ...OBSERVABILITY,
    // Traces are free during the beta; spans bill against the Logs quota from 2026-10-01,
    // so revisit the sampling rate before then.
    traces: { enabled: true, headSamplingRate: 0.5 },
  },
});

export const wrangler = {
  build: { command: "pnpm run build:worker", watch_dir: "src" },
  kvPreviewIds: { BLUEPRINTS: "gadgets-blueprint-metadata", AVATARS: "gadgets-avatars" },
} satisfies WranglerExtras;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserDurableObject", "OverseerDurableObject"] },
  { tag: "v1", new_sqlite_classes: ["AdminSettings"] },
  // Sign-in via authentication gatekeepers: a short-lived PendingLogin DO bridges each gatekeeper
  // login back to the waiting browser.
  { tag: "v2", new_sqlite_classes: ["PendingLogin"] },
  { tag: "v3", new_sqlite_classes: ["UserDirectoryDurableObject"] },
];
