// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    /** The public base URL of this gatekeeper's routes, set by the deployment. */
    BASE_URL?: string;
    /** Single-use secret the bridge pairs with; empty (the default) disables pairing. */
    FACTORY_PAIR_SECRET?: string;
  }

  interface GlobalProps {
    mainModule: typeof import("./worker.js");
    durableNamespaces: "FactoryHubDurableObject" | "FactoryGatekeeper";
  }
}

interface Env extends Cloudflare.Env {}