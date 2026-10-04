import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Vendor ID used in log fields and log components for this gatekeeper. */
export const VENDOR_ID = "factory";

/** Bounded observability fields emitted by the Software Factory gatekeeper. */
export type FactoryObservabilityFields = {
  vendorId: string;
  jobId?: string;
  nodeId?: string;
};

/** Ambient observability context for one Factory operation. */
export const obsContext = createObservabilityContext<FactoryObservabilityFields>();