# Proposed failure scenarios

All faults are injected with Toxiproxy at the client↔API edge (the only real
network boundary — see CLAUDE.md "topology reality"). *Plane* names the proxy
the fault is applied to; ground truth is always read through the untoxified
control plane. *Direction*: `up` = request path (fault before the server
processes), `down` = response path (server processed, client never learns —
the ambiguous-outcome case that idempotency exists for).

| ID | Failure injected (toxic · plane · direction) | Workflow under test | Expected degraded behaviour | Invariant that must hold | Falsification lever (proves the test can fail) |
|---|---|---|---|---|---|
| RS-01 | `latency` 2000ms ± 500ms jitter · client · down | Withdrawal creation, read-back | Request completes slowly within the client's 5s budget; response is schema-valid | Degradation is slow, not wrong: exactly one tx created, valid `problem+json` on any failure, no partial state visible | Drop client budget below toxic latency → budget-abort assertion must fire |
| RS-02 | `timeout` (black hole, 0 data) · client · up | `POST /withdrawals` with `idempotencyKey` | Client aborts at its deadline (typed client error, not a hang); server never saw the request | Retry after abort creates **exactly one** transaction (same id on replay); bounded wait — no unbounded hang | Retry with a *different* idempotency key → duplicate-detection assertion must fire |
| RS-03 | `reset_peer` · client · down (cut after commit) | `POST /withdrawals` with `idempotencyKey` | Client sees connection reset; outcome is ambiguous client-side | **No double-settlement:** replay with same key returns the original tx; one debit; `Σ ledger == balance` | Replay with different key (double-create) → ledger/duplicate assertions must fire |
| RS-04 | `reset_peer` · ops · down, on 2nd approval | Dual-approval (maker-checker) withdrawal | Approver's client sees reset; approval may or may not have landed | Retried approval never double-counts; exactly N **distinct** approvers, maker excluded; single `APPROVED` transition and audit row | Third approval by an already-counted approver via control plane → distinct-approver assertion must fire |
| RS-05 | `limit_data` / `reset_peer` mid-request-body · client · up | Travel-Rule attach (`PUT …/travel-rule`) on a tx ≥ 1000.00 fiat | Write is torn at the network layer; client gets reset/timeout | **Fail closed:** tx cannot leave `TRAVEL_RULE_CHECK` without complete originator+beneficiary data; no partial Travel-Rule record | `/simulator/tx/{id}/force` → `BROADCAST` without payload → gate assertion must go red |
| RS-06 | `reset_peer` · ops · down | Compliance hold release/reject | Officer's client sees reset on an ambiguous release | Hold is atomically `ACTIVE` or `RELEASED`, never in-between; audit row exists **iff** state changed; retry is safe (409/no-op, not double-release) | Force hold state via control plane without audit path → audit-completeness assertion must fire |
| RS-07 | `bandwidth` 8 KB/s · client · down | Paged audit-log read (~large payload) | Read completes within an explicit generous budget or aborts cleanly; pagination cursor remains resumable | Bounded client latency; a resumed cursor yields complete, duplicate-free results despite the earlier abort | Tighten budget below transfer time → abort path assertion; corrupt cursor → completeness assertion |
| RS-08 | `bandwidth` 1 KB/s + `slicer` · client · up (slow request body) | Any JSON POST (slow-loris-shaped) | Server terminates or completes the slow request within a bounded time; other clients (ops plane) unaffected | Server-side boundedness; **suspected finding:** no explicit Fastify `requestTimeout` — if unbounded, document in FINDINGS.md, assert isolation of healthy plane instead | Measure ops-plane latency during attack; remove isolation assertion tolerance → must fire |
| RS-09 | Asymmetric partition: client plane `timeout`, ops plane healthy | Screening `FLAG` → hold → officer resolves while client is dark | Client requests hang/abort; compliance workflow proceeds unimpeded on ops plane | Segregation of duties survives partial degradation: officer can resolve holds; client outage cannot block or corrupt compliance resolution | Apply the timeout toxic to ops plane too → officer-path assertions must fire |
| RS-10 | `reset_peer` intermittently during webhook replay burst · control-adjacent plane | `POST /simulator/webhooks/{id}/replay` ×N for one deposit | Some replays fail at the network layer, some land multiple times | **Exactly-once crediting:** deposit credited once regardless of replay count; `Σ ledger == balance` | Replay against a *fresh* deposit id each time (defeating idempotency surface) → double-credit assertion must fire |
| RS-11 | Seeded chaos sweep: rotating latency/reset/bandwidth toxics across a full lifecycle | Deposit → withdrawal → approvals → screening → Travel Rule → broadcast → confirm | Individual steps fail/retry per RS-02/03/04; lifecycle eventually completes or halts at a gate | Closing sweep: every wallet reconciles (`Σ ledger == balance`), audit log is append-only and complete, no tx in an undefined state | `/simulator/tx/force` one tx mid-sweep into an illegal state → reconciliation/state-machine assertions must fire |
| RS-12 | `timeout` on client plane · up | `GET /health` semantics under partition | Health via degraded plane fails fast at client budget; via control plane stays 200 | Liveness signal is trustworthy: degraded *edge* is distinguishable from degraded *service* (documented probe semantics) | Point "direct" probe at toxified plane → distinguishability assertion must fire |

## Reframed scenario (honesty note)

The brief's canonical case — *"does the compliance gate fail closed when a
downstream dependency times out mid-workflow?"* — is **not injectable via
network faults** in VaultChain: screening, chain, and clock are in-process
simulations with no network hop (single container, embedded SQLite, no
outbound calls). RS-05/RS-06/RS-09 reframe the same invariant at the only
real boundary: an **interrupted client/officer write mid-workflow must never
open the gate**. The topology limitation itself will be recorded in
`docs/FINDINGS.md` with a note on what a multi-service VaultChain would need
for true dependency-level injection.

## Findings candidates (to verify empirically, not assume)

1. **No server-side request timeout** (`src/app.ts` sets no
   `requestTimeout`/`connectionTimeout`) — RS-08 will measure whether a
   trickled request body holds a connection open unboundedly.
2. **`idempotencyKey` is optional** on `POST /withdrawals` — retries without
   it double-create *by design*; RS-03 documents this sharp edge for clients.
3. **No injectable internal boundary** — see reframing note above.
