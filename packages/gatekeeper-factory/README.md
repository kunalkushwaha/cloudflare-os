# Software Factory (gatekeeper-factory)

An auto-provisioned gatekeeper that lets Workshop agents run coding agents on the household's
[Brahma](https://github.com/kunalkushwaha/brahma) fleet, while the Workshop itself stays on
Cloudflare. Design: `docs/home-lab-hybrid.md`.

## Shape

- **`FactoryHubDurableObject`** (`getByName("hub")`) holds the deployment-wide state: the pairing
  with the one `factory-bridge` on the home hub machine, the WebSocket that bridge dials out to, and
  every run. The fleet is household property shared across users, so runs live here rather than in
  the per-user account DOs.
- **`FactoryGatekeeper`** is the per-workspace facet under the Overseer. It owns only the
  pending-action map the approval queue needs, and creates sessions.
- **`FactoryAccount` / `GatekeeperVendor`** are the auto-provisioned account capability and vendor
  (`autoProvisionsAccount`), mirroring `gatekeeper-scheduler`.
- **The default fetch export** serves the bridge-facing HTTP surface:
  - `POST <basePath>/pair` exchanges the deployment's single-use pairing secret for a bridge token.
  - `GET <basePath>/bridge` is the authenticated, hibernatable bridge WebSocket
    (`Authorization: Bearer`).

## Run model

A submitted run is created on the hub in `awaiting_approval`. Approval moves it to `dispatching`,
and the hub asks the bridge to start it. The bridge either refuses it against its home policy
(`refused`), or brahma-hub accepts it and its state then mirrors brahma's run status, refreshed
through the bridge whenever the agent reads it. A run approved while the bridge is offline waits in
`dispatching`. It is sent when the bridge reconnects, and retried every minute. Submissions nobody
approves expire after seven days.

The cloud-side checks (`factory-logic.ts`) give the agent immediate, legible errors. The limits that
matter are enforced at home by the bridge, which the cloud cannot override. Every run is read-only
today (Brahma's `read` tier).

Only cancellation is auto-approvable. Starting a run always needs a human.

## Configuration

- `FACTORY_PAIR_SECRET`: the bridge pairing secret, at least 32 characters. Each value pairs once,
  and an empty value disables pairing. Set it per deployment; in dev, add it to the root `.dev.vars`.
- `BASE_URL`: set by the deployment, and used only to route the bridge-facing paths.

## Roadmap

See `docs/home-lab-hybrid.md` §8: a live run card and events in chat, Telegram approvals, household
roles with guardian approval, recipes, and the ship path.
