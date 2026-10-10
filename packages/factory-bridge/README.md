# factory-bridge

Connects the Workshop's Software Factory to a [Brahma](https://github.com/kunalkushwaha/brahma)
fleet. It runs on the home hub machine, next to `brahma-hub`, and:

- **dials out** to the Workshop over a WebSocket. Nothing at home listens, and no tunnel is needed.
- **answers the Workshop's requests** (list machines, start, read, and cancel runs) by calling
  brahma-hub's REST API on the LAN.
- **enforces the home ceilings** in `bridge.json`: which machines and repositories, which models,
  how much per run and per day, and a `paused` switch. The cloud cannot exceed them.
- **holds the Brahma token**, which never leaves the house.

Two rules hold regardless of policy. Every run starts at Brahma's `read` tier, because writable
tiers wait for node confinement (Brahma D-23). And the Workshop sees only runs the bridge started
itself, so runs you start from Telegram or `brahmactl` stay yours alone. See
`docs/home-lab-hybrid.md` for the design.

## Setup

Node ≥ 23 (type stripping is used directly). From the repo root, on the hub machine:

1. **Issue a Brahma service token** for the bridge (audits as `service`, not as you):

   ```sh
   brahma-hub -issue-token workshop-bridge -scopes read,operate -service > ~/.factory-bridge/brahma-token
   chmod 600 ~/.factory-bridge/brahma-token
   ```

2. **Write `~/.factory-bridge/bridge.json`.** Relative paths resolve next to it, and unknown keys are
   refused:

   ```json
   {
     "server": "https://os.example.com",
     "brahma": {
       "hub": "https://192.168.1.10:8443",
       "caCertFile": "fleet-ca.pem",
       "tokenFile": "brahma-token"
     },
     "policy": {
       "paused": false,
       "repos": ["my-app"],
       "nodes": ["linux-box"],
       "maxBudgetUsd": 2,
       "maxWallSeconds": 3600,
       "dailyBudgetUsd": 10
     }
   }
   ```

   `brahma.hub` must be the address the hub's certificate was issued for (its `listen` address).
   `caCertFile` is the fleet CA (`brahma-hub -fingerprint` identifies it). Add `"models": [...]` to
   allow only those models.

3. **Check it** without touching the Workshop:

   ```sh
   node packages/factory-bridge/src/main.ts check
   ```

4. **Pair it.** Set a long random secret (at least 32 characters) on the Workshop as
   `FACTORY_PAIR_SECRET` (`wrangler secret put FACTORY_PAIR_SECRET` for `gatekeeper-factory`), then
   on the hub machine:

   ```sh
   FACTORY_PAIR_SECRET=<the same secret> node packages/factory-bridge/src/main.ts pair
   ```

   Each secret pairs once. Pairing again (for example on a new machine) needs a new secret, and it
   disconnects the old bridge.

5. **Run it:**

   ```sh
   node packages/factory-bridge/src/main.ts run
   ```

## Operating it

- **Pause:** set `"paused": true` in `bridge.json`. It takes effect on the next request, with no
  restart: no run starts, but reads and cancellations still work.
- **Change limits:** edit `bridge.json`; it is re-read on every request. A broken file makes the
  bridge refuse everything until it is fixed.
- **Revoke:** stop the bridge, or revoke its Brahma token on the hub. Either cuts the Workshop off
  completely.
- **State:** `state.json` (mode 0600, next to the config) holds the bridge token, which Workshop run
  started which Brahma run, and the budget committed per day.

Run it under a service manager: a systemd unit on Linux or a launchd `LaunchAgent` on macOS.
Reconnects with backoff are built in. If the Workshop refuses the token (after re-pairing
elsewhere), the bridge exits with a message instead of retrying forever.
