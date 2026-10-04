// Test worker: the pool's main module must export the DO classes it declares directly, so the
// ctx.exports analyzer does not have to follow the production barrel re-export.
export { default } from "../src/worker.js";
export { FactoryHubDurableObject } from "../src/factory-hub.js";