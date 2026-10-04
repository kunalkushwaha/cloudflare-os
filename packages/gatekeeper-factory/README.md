# Software Factory (gatekeeper-factory)

An auto-provisioned gatekeeper that lets Workshop agents run heavy jobs — builds, test suites,
coding-agent tasks, batch computations — on trusted machines in the user's home lab, while the
Workshop itself stays on Cloudflare.

## Shape

- **`FactoryHubDurableObject`** (`getByName("hub")`): deployment-wide state — the node registry
  (per-node bearer tokens, stored hashed), the WebSocket endpoint each node daemon dials, and every
  job in the deployment. Nodes are household property shared across users, so they and the job
  queue live here rather than in the per-user account DOs.
- **`FactoryGatekeeper`**: the per-workspace facet under the Overseer. Owns only the pending-action
  map the approval queue needs; creates sessions.
- **`FactoryAccount` / `GatekeeperVendor`**: the auto-provisioned account capability and vendor
  (`autoProvisionsAccount`), mirroring `gatekeeper-scheduler`.
- **Default fetch export**: the node-facing HTTP surface — `POST <basePath>/enroll` (exchange the
  deployment enrollment token for a per-node token) and `GET <basePath>/ws` (authenticated,
  hibernatable node WebSocket).

## Job model

A submitted job is created on the hub in `awaiting_approval`; only the approved action moves it to
`queued`, at which point the hub dispatches it to a free online node (targeted via `spec.node` if
given, otherwise any). One job runs per node at a time. Dispatch sets a wall-clock deadline; the
hub's alarm reports jobs whose node died (or whose process hung) as `timed_out`, and expires
submissions nobody approved within seven days. Output streams back over the socket into a bounded
log tail returned in `getJob()` snapshots.

## Node daemon

`packages/factory-node` holds the daemon each machine runs: it enrolls (once, using
`FACTORY_ENROLL_TOKEN`), dials the factory's `/ws` route outbound (no inbound firewall holes), and
executes dispatched command jobs inside its configured project root.

## Configuration

- `FACTORY_ENROLL_TOKEN`: bootstrap enrollment token; empty disables enrollment (set per deployment;
  in dev, add it to the root `.dev.vars`).
- `BASE_URL`: set by the deployment; used only to route the node-facing paths.

## Roadmap

Management UI (node administration, token rotation, per-user dispatch policy), coding-agent job
type (opencode headless with GitHub branch output), and per-node resource granularities are
follow-up phases — see `docs/home-lab-hybrid.md`.