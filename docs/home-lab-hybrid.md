# Hybrid Home Lab v3: a family Software Factory that is usable and secure

Workshop is the **Chief of Staff** (the brain: conversation, planning, family accounts, approvals).
[Brahma](https://github.com/kunalkushwaha/brahma) (`/home/kunal/work/brahma`) is the **factory floor**
(dispatch, worktrees, budgets, event capture, audit chain). v3 keeps v2's split and changes how the
two connect, how work is approved, and who may ask for what. v2 and v1 are summarized at the end.

## 1. Principles

1. **Friction proportional to risk.** An approval asked too often is rubber-stamped, and then it
   protects nothing. Ask rarely, ask in plain language, ask the right person.
2. **Approve an envelope, not a command.** A human approves a *mission* — repo, node, budget, time,
   kind of work — and the agent works freely inside it. Capability leasing, as everywhere else in
   this platform.
3. **Named recipes, not raw commands.** The unit of work has a name and a known risk. Raw argv is
   break-glass, owner-only.
4. **Hard ceilings live at home.** Workshop decides *who may ask* and *what to show them*; Brahma and
   the bridge enforce limits the cloud cannot raise. A fully compromised Cloudflare account can do no
   more than the home side allows.
5. **Stopping is always instant.** Cancel, pause and the kill switch never need approval.

## 2. Decisions

| # | Decision | Status |
|---|---|---|
| H-1 | **Bridge, not tunnel.** A `factory-bridge` on the hub machine dials *out* to `gatekeeper-factory` and talks to brahma-hub on localhost. No inbound port at home; Brahma's D-3 ("no external surface") stays true. | decided |
| H-2 | **Workshop is the main interface** — chat, missions, results, administration. | decided |
| H-3 | **Telegram is the approval channel** for now: approval requests are pushed there, with Workshop showing the same queue. | decided |
| H-4 | **Kids use free models by default**; the admin may allow paid models per child. | decided |
| H-5 | **Recipes vs Brahma's "no agent invokes an operation".** See §5. | open — Brahma-side decision |

## 3. People and what they may do

| Who | Wants | Must never |
|---|---|---|
| **Owner / admin** | everything, including from the phone | have one prompt injection become code execution |
| **Adult** | "fix my app", "run my tests", see results | touch others' repos, raise their own ceilings |
| **Child** | "add a jump button to my game", play the result | run anything without a guardian; use paid/logging models unless allowed; ship code |
| **Chief of Staff (agent)** | plan, dispatch inside an approved envelope, report | approve its own work, widen an envelope, push code, see secrets |
| **Collaborator / guest** | see a shared gadget | see factory logs or dispatch |
| **Stranger** | — | anything |

## 4. Risk tiers

| Tier | Examples | Who approves | Feels like |
|---|---|---|---|
| **0 · Look** | list machines, run status, read events | nobody (logged as an observation) | instant |
| **1 · Recipe** | `test`, `build`, `lint`, `preview` on an allowlisted repo's main branch | **pre-authorized** by an adult's standing grant (§5) | instant, a card in chat |
| **2 · Mission** | coding-agent run toward a goal | **one approval per mission** (a child's goes to their guardian) | "Spend up to $2 / 1 h on my-app?" |
| **3 · Leaves the house** | open a PR, push, publish | **an adult, in Workshop**, with the diff | review screen |
| **X · Break-glass** | raw argv (`shell.exec`) | owner only, every time, plan-then-confirm | Brahma's own flow |

Rules:

- Nothing above Tier 1 is ever auto-approvable: starting a run never carries `autoApprovable`, and
  only `factory.cancel-run` is advertised in `getAutoApprovableActions()`.
- Cancelling is a queued action like any write, but always auto-approvable, so a user who opts in
  never waits to stop work.
- A budget increase, a different repo or a different node is a new approval, never an agent decision.
- Content the agent reads (issues, web pages, run output) is data. It can never widen an envelope,
  because the envelope was fixed when a human approved it.

### What makes a recipe Tier 1

It may run without a per-run approval only when *all* of these hold: it is a named recipe the repo
declares (not an agent-written command), on an allowlisted repo, at the **base commit** (human-merged
code, not unreviewed agent output), no secrets, no model spend, a short time limit, and only a result
leaves the machine. The worst case is wasted machine minutes. Recipes on unreviewed agent output run
only inside the Tier 2 mission that produced it.

## 5. Mapping onto Brahma as it is today

Brahma reality, verified against its source (2026-10-11):

| v3 concept | Brahma | State |
|---|---|---|
| Tier 0 | `GET /v1/nodes`, `/v1/runs`, `/v1/runs/{id}`, `/v1/runs/{id}/events?since=` | ✅ built |
| Tier 1 | `cmd.run` operation: a command the repo declares by name, read from the base commit | ✅ built — but see H-5 |
| Tier 2 | `POST /v1/runs` (node, repo, prompt, model, budget, wall/idle limits) | ✅ built, **`read` tier only** until confinement (D-23) |
| Tier 3 | `git.push` / `pr.open` hub-site verbs | ❌ declared, not built |
| Break-glass | `shell.exec` with plan-then-confirm | ✅ built; not exposed to Workshop |
| Machine actor | `-issue-token <name> -scopes read,operate -service` audits as `service` | ✅ built (v2 listed it as a gap) |
| Per-run model | `model` on the run request | ✅ built (v2 listed it as a gap) |

Consequences:

- **Tier 2 is "investigate" before it is "fix".** Until Brahma ships confinement (v0.2), every node
  advertises `max_tier=read`: a run may read the repo, analyze, review and plan, but not write. The
  Chief of Staff presents read-tier missions as "look into it" and refuses "fix it" with the reason.
  Writable missions arrive with Brahma's `standard` tier, unchanged on the Workshop side.
- **H-5 (open).** Brahma's invariant is that *no agent may invoke an operation, at any tier*, and the
  Chief of Staff is an agent. Two ways to keep the invariant honest:
  - **(a) Standing grants (recommended).** An adult creates a grant in Workshop — "the assistant may run
    `test` on `my-app` on `linux-box`" — which the bridge mirrors into a **local allowlist on the hub
    machine**. A trigger is then the execution of a human decision, not an agent's choice of verb: the
    agent can pick *when*, never *what*. Brahma records it in DECISIONS.md as a narrow exception
    (repo-declared, base-commit, allowlisted tuple, audited as `service`).
  - **(b) No exception.** Every recipe is a one-tap approval. Simpler, noisier.
- **Getting code out (Tier 3)** stays v2's short-term path until `pr.open` exists: the Chief of Staff
  reads the run's captured edits and proposes the change through the Workshop GitHub gatekeeper as a
  reviewable PR. Never node-side push credentials.

## 6. Architecture

```
 Family (browser, phone)        CLOUDFLARE                               HOME LAN (hub machine)
 ──────────────────────  ───────────────────────────────────    ─────────────────────────────────────
  Workshop UI ─────────▶  workshop-backend (kernel)
                            ├ household roster + roles (AdminConfig)
                            ├ approval routing → guardian
                            └ Chief of Staff agent
                                    │ FACTORY binding (role-scoped)
                          gatekeeper-factory                       factory-bridge ──https (pinned CA)──▶ brahma-hub
                            ├ recipes, tiers, missions   ◀═ WSS ═══ ├ holds the brahma service token      ├ budgets, tiers
                            ├ run state, event cursors     (out)    ├ local allowlist + ceilings          ├ audit chain
                            └ bridge credential (hashed)            └ refuses anything outside them       └ nodes ─▶ worktrees
                          gatekeeper-github (PRs)
                          gatekeeper-scheduler (check-ins)
                          Telegram bot ──▶ approvers' phones
```

### The bridge

`packages/factory-bridge` replaces the v1 `factory-node` daemon (same packaging, same reconnect logic)
and the v1 hub DO stops being a node registry and becomes the bridge's endpoint.

- **Outbound only.** Dials `wss://<workshop>/gatekeeper/factory/bridge`, authenticated by a per-bridge
  token minted at pairing (stored hashed in the cloud, mode 0600 at home).
- **Request/response over the socket.** The cloud sends `{id, method, params}`; the bridge answers
  `{id, result | error}`. Methods map one-to-one onto Brahma REST (`listNodes`, `startRun`, `getRun`,
  `runEvents`, `cancelRun`, and later `runRecipe`).
- **The Brahma token never leaves home.** The bridge holds a `service`-kind `read,operate` token and
  talks to the hub over its pinned-CA TLS listener on the LAN.
- **The bridge is the home-side policy point.** A local file (`bridge.json`, re-read on every
  request) sets the ceilings the
  cloud cannot exceed: allowed repos and nodes, maximum budget and wall clock per run, daily spend cap,
  recipe allowlist (H-5a, later), allowed models, and a `paused` switch. Out-of-policy requests are refused *at home* with a reason
  the agent can relay.
- **Kill switch.** `paused` is honored on the next request; while paused the bridge refuses
  everything but reads and cancels.
- **Only its own runs.** The bridge serves only runs it started, so runs the owner starts from
  Telegram or brahmactl are invisible to the cloud.
- **Pairing (phase 1).** A deployment secret (`FACTORY_PAIR_SECRET`, ≥32 chars) that pairs exactly
  once; re-pairing needs a new secret and disconnects the old bridge. W4's pairing code from the
  management page replaces it when that page exists.

### Identity and family roles (kernel work)

The kernel deliberately gives gatekeepers no user identity, and the factory does not break that.
Roles are an admin-configured *property of the minted capability*, set by the kernel:

1. **Household roster** in `AdminConfig`: each user → `owner | adult | child`, a guardian for each
   child, and per-child model permission (H-4).
2. **Role-scoped accounts.** When the kernel provisions the factory account for a user it passes the
   admin-configured role in the account's props. The gatekeeper enforces role policy (children: free
   models, playground nodes, guardian approval) but never asserts a role itself.
3. **Cross-user approval routing.** An action may be marked "approve by guardian". It appears in the
   guardian's queue (Workshop + Telegram) instead of the requester's. This is a general kernel
   mechanism and ships as its own reviewed PR.

### Approvals on Telegram (H-3)

- A Workshop-side Telegram bot (separate from Brahma's gateway, which is LAN-only by D-25/D-3)
  receives a webhook at the public origin.
- **Account linking:** a user links their Telegram account from Workshop settings with a one-time
  code; the bot accepts approvals only from linked accounts, and only for actions routed to that user.
- **What may be approved from Telegram:** Tier 1 grants and Tier 2 missions — plain-language summary,
  cost, time, node, with Approve / Decline buttons. **Tier 3 always opens Workshop**, because shipping
  code means reading a diff.
- Every Telegram decision is recorded in the Workshop action log with the channel it came through.

### Node isolation (Brahma's job, tracked here)

Until Brahma confinement lands, isolation is what Brahma's `read` tier gives (no writes, null jail
that says so). Remote dispatch is never routed to a node Brahma marks unconfined above `read`
(`desk-win`, D-2). Model credentials are leased per run from Brahma's vault, with a provider-side
spend cap.

## 7. Workflows

**W0 · Day-zero hardening**
1. `/admin`: signups **off**; Software Factory **disabled** except for the owner.
2. Pair the bridge only after its `bridge.json` allowlists are set (phase 1 ships with this).
3. Stop any v1 `factory-node` daemon; v1's job API is gone.

**W1 · Adult: "why is the auth test failing in my-app?"** (Tier 2, read)
1. Chief of Staff reads machine list and recent runs (Tier 0).
2. Proposes a mission card: *"Investigate on linux-box, model X, up to $1 / 30 min, read-only."*
3. Approve in Workshop or Telegram. The run streams into a live card with progress, spend and Stop.
4. Report in plain language. Once writable tiers exist, "Fix it?" is a second mission, then
   "Ship it?" is Tier 3 in Workshop.

**W2 · Child: "add a jump button to my game"** (Tier 2, guardian)
1. The child's Chief of Staff may only propose on playground nodes with free models.
2. The guardian gets a Telegram message: *"Maya wants to change Space Jumper (~free, 20 min).
   Approve / Decline."*
3. The result appears as a preview gadget in the child's Workshop. Publishing is a guardian's Tier 3.

**W3 · Nightly tests** (Tier 1)
1. An adult creates a standing grant: recipe `test`, repos A and B, `linux-box`, 15 min each.
2. The scheduler triggers it at 02:00; the bridge checks its local allowlist and runs it.
3. Failures land in the morning digest with a proposal ("Want me to investigate? ~$0.50"), which is a
   new Tier 2 approval.

**W4 · Pairing the bridge**
1. Owner clicks **Pair home hub** in the factory management page: a 10-minute single-use code.
2. On the hub machine: `factory-bridge pair <code> --server https://<workshop>`; the bridge gets its
   own token, and the code is spent.
3. The management page shows the bridge, Brahma's nodes and their max tiers. Dispatch is off until
   the owner enables it.

**W5 · Panic**
- **Stop everything** in the Workshop header (and as a Telegram command for linked adults): cancels
  in-flight runs, pauses the bridge, revokes the bridge credential. One tap, no confirmation.
- Afterwards, compare the Workshop action log with Brahma's audit chain (`brahmactl audit verify`)
  for the window. A mismatch is the finding.

## 8. Build plan

| Phase | Deliverable | Done when |
|---|---|---|
| **0 · Lock down** | W0 | a fresh signup cannot see the factory; nothing is auto-approvable |
| **1 · Bridge** ✅ built | `factory-bridge`, gatekeeper endpoint + RPC over the socket, Brahma REST client, `bridge.json` ceilings, pairing | an approved read-tier run completes end to end with zero inbound ports at home |
| **2 · Missions** | mission envelopes, live run card, events into chat, cancel without approval | W1 works with one approval |
| **3 · Telegram approvals** | bot, account linking, approval push + buttons | W1's approval works from a phone |
| **4 · Family** | roster + roles in AdminConfig, role-scoped accounts, kernel cross-user approval (separate PR) | W2 works; a child cannot run anything without a guardian |
| **5 · Recipes** | H-5 decided; standing grants mirrored to the bridge allowlist | W3 runs unattended |
| **6 · Ship path** | Tier 3 via GitHub gatekeeper; later Brahma `pr.open` | a change reaches a PR without node push credentials |
| **7 · Writable missions** | follows Brahma v0.2 confinement (`standard` tier) | "fix it" missions run in a confined worktree |

## 9. Threats and controls

| Threat | Control | Where |
|---|---|---|
| Stranger signs up and dispatches | signups off; factory disabled by default; role-scoped accounts | Workshop admin |
| Prompt injection makes the agent dispatch | envelopes fixed at approval; no auto-approval above Tier 1; recipes are repo-declared, not agent-written | gatekeeper + bridge |
| Child self-approves | guardian routing; child accounts cannot approve their own Tier 2 | kernel |
| Compromised Cloudflare account | home-side ceilings in `bridge.json`; Brahma token never in the cloud; pause/revoke at home | bridge |
| Stolen bridge credential | hashed at rest, revocable from Workshop, bound to one socket at a time | gatekeeper |
| Agent exfiltrates code or secrets | read tier: no writes, no egress; leased model creds; no forge creds on nodes | Brahma |
| Spoofed node or result | Brahma's pinned-CA node enrolment; bridge pins the hub's CA | Brahma + bridge |
| Telegram account takeover | approvals only from linked accounts; Tier 3 never from Telegram; kill switch in Workshop | bot |
| Runaway spend | per-run budget (Brahma), daily cap (bridge), provider-side key limit | all three |

## 10. History

**v2 (2026-10-04)** made the Workshop/Brahma split: Workshop is better at planning, multi-user access
and approval UX, Brahma at run isolation, budgets, observability and audit. It proposed exposing
brahma-hub's REST API through a cloudflared tunnel, which v3 replaces with the outbound bridge (H-1).

**v1** built `gatekeeper-factory` as a deployment-wide hub DO owning a node registry, per-node tokens
and a job queue, with a `factory-node` daemon dialing `/gatekeeper/factory/ws` and running argv
commands. Its approval-gated job model, socket transport and daemon packaging carry into v3; its
direct command execution (full host environment, shared enrolment token, label-based routing) does
not.
