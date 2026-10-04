# Hybrid Home Lab v2: Workshop (Chief of Staff) + Brahma (Software Factory)

Supersedes the v1 prototype design at the bottom of this file. v1 built and deployed a
working `gatekeeper-factory` + `factory-node` daemon; v2 keeps the gatekeeper shell and
replaces the home-side execution fabric with [Brahma](https://github.com/kunalkushwaha/brahma)
(`/home/kunal/work/brahma`), whose execution plane is substantially more mature.

## 1. Verdict that drove v2

Two systems were built independently and turn out to be complementary layers:

| Concern | Cloudflare OS (Workshop) | Brahma |
|---|---|---|
| Plan, converse, multi-user family access | ✅ kernel + agents + per-user accounts | ❌ single-user, Telegram-only UX |
| Human approval UX | ✅ approval queue w/ simulated outcomes | ⚠️ plan-then-confirm for ops only |
| Run isolation | ❌ shared work root (v1 prototype) | ✅ per-run worktree, `origin` → local mirror (no forge credentials on nodes, by construction) |
| Budgets | ❌ timeout only | ✅ dollars / wall clock / idle, process-group kill |
| Observability | ❌ 64 KB log tail | ✅ full event stream, durable spool, replay by offset |
| Accountability | ✅ Workshop action log | ✅ hash-chained audit log (agents structurally excluded) |
| Always-on availability | ✅ Cloudflare | ⚠️ hub is LAN-only by design (D-3) |

Conclusion: **Workshop = Chief of Staff (brain). Brahma = Software Factory (floor).**
Bridge them across their existing, already-secured front doors; change neither trust model.

## 2. Topology

```
                    ┌─────────────────────────────────────────┐
                    │            CLOUDFLARE (always on)       │
   Family members ──▶  Workshop UI ── workshop-backend (kernel) │
   (browser)          │                    │                    │
                      │      gatekeeper-factory ────┐          │
                      │      gatekeeper-github      │          │
                      │      gatekeeper-scheduler   │          │
                      └──────────────────────────────┼──────────┘
                                                     │ HTTPS
                                                     │ Bearer bra_… (operate scope)
                                                     ▼
                    ┌─────────────────────────────────────────┐
                    │  HOME LAN (always-on box)               │
                    │  brahma-hub ── TLS out-only ──► nodes   │
                    │     ▲ cloudflared tunnel (one door)     │
                    └─────┼───────────────────────────────────┘
                          ├── linux-box   (brahma-node)
                          ├── laptop      (brahma-node)
                          └── mac         (brahma-node)
```

The tunnel exposes **only** brahma-hub's REST API (`/v1/*`), which is already bearer-token
authenticated (`bra_` tokens, sha256-hashed at rest, scoped, revocable). Nodes stay LAN-only
dial-out (D-3). One public door, on the component that is already always-on and holds
credentials — and that door was already defended.

## 3. Responsibilities (each piece owns nothing it shouldn't)

* **Chief of Staff** — an agent persona in the Workshop (admin-set instructions + ambient
  `FACTORY`/`SCHEDULER`/`GITHUB` bindings). Loop: plan → pick node from `listNodes()` →
  `submitJob()` → scheduler check-ins → read events → plain-language report + diff review.
* **gatekeeper-factory (the seam)** — every read is an observation, every run submission a
  queued action. Owns exactly: family identity (who's asking), the approval queue (the human
  gate; children's submissions always require an adult), per-user/node dispatch policy, and
  the single brahma `operate` token. Implementation is a typed brahma REST client; the
  session types and approval semantics from v1 carry over.
* **brahma-hub** — dispatch, budgets, tiers, event capture, spool/replay, audit chain. Knows
  nothing of "users" or "approval"; the Workshop is one authenticated operator.
* **brahma-node** — per-run worktree + bare mirror; agents hold no forge credential and
  cannot push to GitHub, by construction. Model credential leased at dispatch, never persisted.

## 4. Trust boundaries

1. The cloud holds exactly one brahma secret (the `operate` token). A compromised Cloudflare
   account can *request* runs — which is what the approval queue gates.
2. Nodes hold no forge credentials; code leaves a node only via the deliberate export path (§7).
3. Agents never become operators: brahma's type system has no agent caller; an unapproved
   submission simulates forever and never dispatches.
4. Kids are a policy layer in the gatekeeper (always-approve-required, `:free` models,
   per-user LLM limits), not a separate system.
5. Independent tamper-evident records: brahma's audit chain + the Workshop's action log.

## 5. API mapping (gatekeeper-factory → brahma REST)

| Factory session API | Brahma call |
|---|---|
| `listNodes()` | `GET /v1/nodes` (+ `node.doctor` op when capability truth is needed) |
| `submitJob(spec)` | approval → `POST /v1/runs` (explicit node targeting per D-5; the CoS picks from `listNodes`) |
| `getJob(jobId)` | `GET /v1/runs/{id}` + `GET /v1/runs/{id}/events?since=…` |
| `waitForJob(jobId)` | poll the above (brahma D-27 names a streaming endpoint as the additive fix) |
| `cancelJob(jobId)` | `POST /v1/runs/{id}/cancel` |

## 6. Brahma changes needed (small, upstreamable)

1. **`ActorService` machine actor kind** — token-driven calls currently audit as *human*;
   the Workshop should be auditable as what it is. Small type + audit-render change.
2. **`model` + `profile` fields on `RunSpec`** (S2-03 was left open for this) so the CoS can
   pin the model and budget per run.
3. Later: the streaming events endpoint (D-27: "additive when a second reader appears").
4. Stage 3's context plane converges with the CoS's memory — revisit when S3 lands.

## 7. The export path (getting work out of brahma)

Brahma runs end with commits in the node's local mirror; nothing pushes to GitHub today.
Options in order:

1. **Short term:** the CoS reads the run's event stream (file edits are captured), and lands
   the change through the Workshop's GitHub gatekeeper as a reviewable diff. No brahma code.
2. **Right fix:** implement the declared hub-site verbs (`git.push`, `pr.open`) behind the
   planned broker + plan-then-confirm; "publish this run" becomes an approved, audited op
   whose approval can surface in the Workshop.
3. **Never:** node-side push credentials.

## 8. Build order

1. Brahma: `ActorService` + mint `operate` token for the Workshop (~½ day)
2. Tunnel the hub API (config only)
3. Swap `gatekeeper-factory` internals to brahma REST (1–2 days); keep types/approval flow
4. End-to-end: plan → approve → run → events in chat → diff review
5. Export path (§7), then context plane ↔ CoS memory

## 9. Retained from v1

Deployed and live: Workshop instance (router/backend/factory/scheduler/github gatekeepers),
bindings, secrets, KV/R2, the onboarding-wizard ambient-connect fix, the OpenRouter model
setup (custom-URL "openai" provider now speaks Chat Completions — see `ai-models.ts`), and
the single-file `factory-node` packaging (transfers to `brahma-node` deployment). The v1
hub DO / node WS protocol is retired in favor of brahma.

---

# v1 (superseded): prototype design

The original design built `gatekeeper-factory` (auto-provisioned ambient gatekeeper with a
deployment-wide hub DO owning the node registry, tokens, and job queue) plus a `factory-node`
daemon dialing outbound WebSocket to `/gatekeeper/factory/ws`. See git history for the full
text. Key v1 artifacts kept in the tree: the gatekeeper shell, its `types.txt` agent API,
tests, and the node-daemon packaging.
