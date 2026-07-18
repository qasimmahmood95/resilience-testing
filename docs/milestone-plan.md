# Milestone plan

Each milestone ends in a PR gated by two subagents: a **code-review agent**
(assertion strength, determinism, scope) and a **verification agent** (clean
stack bring-up, toxics applied, falsification harness proves no vacuous
passes). Scenario IDs (`RS-xx`) refer to
[`failure-scenarios.md`](failure-scenarios.md).

## M0 — Plan (this PR)

**Deliverables:** `CLAUDE.md`, this plan, the failure-scenario table.
**Exit:** reviewer (repo owner) approves scenarios and invariants. No code.

## M1 — Stack scaffolding + ADRs

**Deliverables:**

- `docker-compose.yml`: `vaultchain` built from a **remote git build context
  pinned to a commit** (external-consumer stance; no vendored code, no
  published app port) + `toxiproxy` (`ghcr.io/shopify/toxiproxy`) exposing the
  Toxiproxy API and three proxy ports: `client-plane`, `ops-plane`, and the
  never-toxified `control-plane` (see CLAUDE.md "topology reality").
- Toxiproxy bootstrap config (proxies declared declaratively; toxics are
  applied per-test, never statically).
- Playwright/TS scaffold: strict tsconfig, fixtures for (a) a typed VaultChain
  API client with explicit request budgets, (b) a Toxiproxy client whose
  teardown removes all toxics even on failure, (c) a clean-state fixture using
  `/simulator/reset` via the control plane.
- One smoke spec: stack healthy through each plane, `/health` and seeded state
  reachable.
- CI workflow: compose up `--wait`, smoke green, teardown.
- **ADR-0001**: why Toxiproxy over chaos-mesh/pumba at this scale (single-host
  compose, one network edge, HTTP-API-driven per-test toxics, no k8s).
- **ADR-0002**: single-edge topology; traffic-plane proxies as the substitute
  for inter-service injection; untoxified control plane for observation.

**Exit:** CI green from a clean checkout; verification agent confirms toxics
can be applied/removed and that killing the client-plane proxy does not affect
control-plane observation.

## M2 — Error surface & bounded latency (RS-01, RS-02, RS-07, RS-08, RS-12)

Latency, timeout (black-hole), and bandwidth toxics against read and write
paths. Asserts: failures surface as typed `problem+json` or as *client-side*
deadline aborts within budget — never unbounded hangs; degraded reads
complete-or-fail cleanly. Expected to produce the first `FINDINGS.md` entries
(e.g. no server-side request timeout).

**Exit:** suite green; falsification harness shows each test fails when its
toxic is silently not applied (vacuity check) or its budget is violated.

## M3 — Idempotency & no-double-settlement (RS-03, RS-04, RS-10, RS-11)

`reset_peer` in both directions around the commit point: request cut before
processing vs response cut after processing (the ambiguous-outcome case).
Withdrawal creation with/without `idempotencyKey`, dual-approval retries,
webhook replay under flaky network, then the ledger reconciliation sweep
(`Σ ledger == balance` on every wallet) as the closing assertion of every
spec in this milestone.

**Exit:** suite green ×3 consecutive runs (concurrency-sensitive tests);
falsification via `/simulator/tx/{id}/force` and duplicate-submission with
*different* idempotency keys proves each invariant assertion actually fires.

## M4 — Fail-closed mid-workflow (RS-05, RS-06, RS-09)

Connections cut mid-request (`limit_data`, `reset_peer`, `slicer`) during
compliance-relevant steps: Travel-Rule attach, hold release/reject,
cancellation racing settlement. Asserts the gate never opens on an
interrupted write: state remains at the gate or moves atomically, audit rows
exist iff state changed, asymmetric degradation (client plane down, ops plane
up) still lets compliance officers resolve holds.

**Exit:** suite green; falsification: `/simulator/tx/force` pushes a gated tx
past its gate and every fail-closed assertion goes red.

## M5 — Findings, hardening, portfolio polish

- `docs/FINDINGS.md` finalized: each finding with scenario ID, evidence
  (captured output), impact, and what an invariant-asserting fix in VaultChain
  would look like (described, not implemented).
- Falsification harness promoted to a first-class `npm run falsify` + required
  CI job.
- `README.md` for portfolio readers: the architecture, one worked example
  (an RS scenario from toxic to invariant), how to run everything in one
  command.
- Flake audit: full suite ×5 from clean; any flake is fixed or the test is
  redesigned — no retries policy for invariant assertions.

**Exit:** CI fully green from scratch on a fresh clone; both subagent gates
pass; repo presentable without this plan as context.
