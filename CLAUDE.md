# resilience-testing

Failure-mode (resilience) test suite for **VaultChain**
([qasimmahmood95/vaultchain](https://github.com/qasimmahmood95/vaultchain)), a
fictional digital-asset custody platform. This repo treats VaultChain strictly
as an external system-under-test: we inject network faults with **Toxiproxy**
between the test client and VaultChain's API edge, and assert *behaviour under
failure* — fail-closed compliance gates, typed errors instead of hangs,
idempotent retries, no double-settlement.

## Hard limits (non-negotiable)

1. **No application code.** This repo contains toxics config, test code, a
   docker-compose overlay, docs, and CI only. Never vendor, patch, fork-edit,
   or monkey-patch VaultChain. We consume it exactly as an external integrator
   could: `docker compose` with a remote git build context pinned to a commit.
2. **If VaultChain lacks an invariant worth asserting, it goes in
   `docs/FINDINGS.md`** — never fixed here. A finding with evidence is a
   deliverable; a patch is a scope violation.
3. **No vacuous passes.** Every resilience test must have a documented
   *falsification lever* (see below) and must be shown to fail when its
   invariant is deliberately broken. A resilience test that cannot fail is
   worthless and must not merge.

## System-under-test: topology reality

Read this before proposing any new fault-injection point:

- VaultChain is a **single Fastify process** (port 3000) with **embedded
  SQLite** inside the container. There is **no inter-service network**: no
  separate DB, no screening vendor, no chain node, no outbound webhooks.
  "Downstream dependencies" (chain confirmations, screening, clock) are
  in-process simulations driven via the `/simulator/*` control plane.
- Therefore the **only interposable network boundary is client ↔ API edge**.
  We model distinct *traffic planes* as separate Toxiproxy proxies to the same
  upstream, so faults can be applied asymmetrically:
  - `client-plane` — traffic authenticated as CLIENT actors (the degraded path
    under test),
  - `ops-plane` — OPERATOR / COMPLIANCE_OFFICER traffic (can be kept healthy
    or degraded independently),
  - `control-plane` — **never toxified**. All `/simulator/*` calls and all
    ground-truth assertions (state reads after a fault) go through this port so
    toxics can never corrupt *observation*.
- Faults that require an internal network hop (e.g. "screening service times
  out") are **out of reach by design**; that limitation is documented in
  `docs/FINDINGS.md`, and the corresponding invariants are asserted at the
  edge instead (interrupted client workflows must leave state safe).

Useful VaultChain facts (verified against source at the pinned commit):

- Errors are RFC 9457 `application/problem+json` (`src/errors.ts`).
- `POST /withdrawals` accepts an optional `idempotencyKey` (minLength 8);
  replays are tenant-scoped and return the original transaction.
- Withdrawal states: `PENDING_APPROVAL → APPROVED → SCREENING →
  (SCREENING_FLAG/HELD) → TRAVEL_RULE_CHECK → TRAVEL_RULE_ATTACHED → BROADCAST
  → PENDING_CONFIRMATION → …`, plus `CANCELLED` / `REJECTED`. Transitions are
  atomic with their audit row; settlement uses a compare-and-set claim.
- Ledger invariant: `Σ(ledger entries for a wallet) == wallet.balance` for
  every asset, always.
- `/simulator/tx/{id}/force` forces a broadcast-stage transaction's **outcome**
  (`CONFIRMED` | `FAILED`, with refund on FAILED) — it can NOT push arbitrary
  states (corrected 2026-07-18; earlier drafts overclaimed). Falsification
  levers therefore use per-scenario sabotage modes (`FALSIFY=<id>`, typically
  skipping the fault so degraded-behaviour assertions must fire) plus forced
  outcomes where legal.

## Conventions

- **TypeScript strict** (`"strict": true`, no `any`, no non-null assertions
  without a comment stating why it is safe).
- **Playwright test runner** for all tests. Resilience tests run serialized
  (`workers: 1`) — toxics are global state on shared proxies, and VaultChain's
  sim-clock is global.
- **Determinism policy.** Resilience testing is about time, so the rules are
  explicit rather than absolute:
  - Client-side deadlines use explicit budgets (`AbortSignal.timeout`) with
    named constants — never bare `waitForTimeout` sleeps as synchronization.
  - Toxic parameters (latency, rate, timeout) are named constants with the
    derivation of each budget commented.
  - Any randomness is seeded and the seed is printed on failure.
  - Every toxic is removed in fixture teardown even on test failure; a
    leaked toxic must fail the run loudly, not poison the next test.
- **Test documentation.** Every spec documents, in a structured header
  comment: (1) the failure scenario injected, (2) the expected degraded
  behaviour, (3) the invariant that must hold, (4) the falsification lever.
  Scenario IDs (`RS-xx`) trace to `docs/failure-scenarios.md`.
- **Conventional commits** (`feat:`, `test:`, `docs:`, `ci:`, `chore:`).
- **ADRs** in `docs/adr/NNNN-*.md` for every non-obvious decision. Required
  minimum: ADR-0001 "Toxiproxy over chaos-mesh/pumba at this scale",
  ADR-0002 "single-edge topology and traffic-plane proxies".

## Commands (once scaffolded — M1)

```bash
npm run stack:up                # toxiproxy + vaultchain (remote git build context)
npx playwright test             # full resilience suite
npm run falsify                 # falsification harness (lands with the first
                                # scenario suite, M2; required CI job by M5)
npm run stack:down              # clean slate (SQLite state dies with container)
```

## Subagent protocol

- **Code-review subagent** before every milestone PR: reviews the diff for
  weak assertions, toxic leaks, determinism violations, and scope violations
  (any VaultChain patching = automatic block).
- **Verification subagent** before every milestone PR: brings the composed
  stack up **from clean** (`docker compose down -v` first), applies each
  toxic, runs the suite green, then runs the falsification harness and
  confirms **every test fails** when its invariant is deliberately broken.
  A test that passes its falsification run blocks the PR.

## CI

GitHub Actions: bring up the full stack headlessly (compose with `--wait`,
health-gated), run the resilience suite, then the falsification harness as a
separate required job. Publish the Playwright HTML report as an artifact.

## Merge protocol

Milestone PRs are checked and merged by the working agent itself. This
authorization was given by the repo owner (qasimmahmood95) as an explicit
instruction in the working session of 2026-07-18 ("From now on, check and
merge yourself"); it is recorded here for continuity, remains subject to the
owner revoking it at any time, and every merge stays visible on the PR for
owner review after the fact. Conditions for any self-merge: (1) both subagent
gates have passed, (2) CI is green on the head commit, (3) there are no
unresolved review comments. Use a merge commit (never squash — the
conventional-commit history is part of the portfolio). After merging, restart
the working branch from the new `main`.
