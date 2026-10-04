// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    /** The public base URL of this gatekeeper's routes, set by the deployment. */
    BASE_URL?: string;
    /** Bootstrap token for node enrollment; empty (the default) disables enrollment. */
    FACTORY_ENROLL_TOKEN?: string;
  }

  interface GlobalProps {
    mainModule: typeof import("./worker.js");
    durableNamespaces: "FactoryHubDurableObject" | "FactoryGatekeeper";
  }
}

interface Env extends Cloudflare.Env {}