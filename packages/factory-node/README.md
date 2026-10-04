# factory-node

The Software Factory node daemon. Run it on a home-lab machine (Linux, Windows, or Mac); it
registers the machine with the Workshop's `gatekeeper-factory` and executes dispatched command
jobs. The daemon only dials *out* — no inbound firewall holes, works behind NAT.

## Setup (per machine)

Node ≥ 23 (type stripping is used directly). From the repo root:

```sh
FACTORY_ENROLL_TOKEN=<deployment enrollment token> \
  node packages/factory-node/src/main.ts \
  --server https://os.example.com \
  --node-id linux-desktop \
  --label "Linux desktop" \
  --capabilities node,python,docker
```

First run exchanges `FACTORY_ENROLL_TOKEN` (or `--enroll-token`) for this node's own bearer token
and stores it at `~/.factory-node/<node-id>.json` (mode 0600). Later runs need only `--server` and
`--node-id`.

Flags:

| Flag | Meaning |
|---|---|
| `--server` | Workshop origin, for example `http://localhost:8787` in dev. |
| `--node-id` | Stable node ID (lowercase letters, digits, hyphens). |
| `--label` | Display label; defaults to the node ID. |
| `--capabilities` | Comma-separated toolchain list, purely informational for now. |
| `--work-root` | Root all job working directories resolve under (default `~/factory-projects`). |
| `--state-file` | Where the token persists (default `~/.factory-node/<node-id>.json`). |
| `--enroll-token` | Bootstrap token; also read from `FACTORY_ENROLL_TOKEN`. |

## Job execution model

- One job at a time per node; commands run as argv (no shell) inside `--work-root`.
- Output streams back over the socket (bounded budget, tail preserved).
- Timeouts kill the process (SIGTERM, then SIGKILL); cancellation does the same.
- The daemon holds no cloud credentials; it only ever talks to the Workshop origin.

## Keeping it running

Run it under your platform's service manager: systemd unit on Linux, `nssm`/Task Scheduler on
Windows, a launchd `LaunchAgent` on macOS. Reconnects with backoff are built in, so it survives
sleeps and restarts.