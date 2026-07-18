# Proposed failure scenarios

All faults are injected with Toxiproxy at the client↔API edge (the only real
network boundary — see CLAUDE.md "topology reality"). *Plane* names the proxy
the fault is applied to; ground truth is always read through the untoxified
control plane. *Direction*: `up` = request path (fault before the server
processes), `down` = response path (server processed, client never learns —
the ambiguous-outcome case that idempotency exists for).

| ID | Failure injected (toxic · plane · direction) | Workflow under test | Expected degraded behaviour | Invariant that must hold | Falsification lever (proves the test can fail) |
|---|---|---|---|---|---|
| RS-01 | `latency` 2000ms, jitter 0 (determinism policy: unseedable jitter buys no coverage) · client · down | Withdrawal creation, read-back | Request completes slowly within the client's raised budget; response is schema-valid | Degradation is slow, not wrong: exactly one tx created, valid `problem+json` on any failure, no partial state visible | `FALSIFY=RS-01` skips the toxic → elapsed-floor assertion must fire |
| RS-02 | `timeout` (black hole, 0 data) · client · up | `POST /withdrawals` with `idempotencyKey` | Client aborts at its deadline (typed client error, not a hang); server never saw the request | Retry after abort creates **exactly one** transaction (same id on replay); bounded wait — no unbounded hang | `FALSIFY=RS-02` skips the toxic → the first-attempt-must-abort assertion must fire |
| RS-03 | `reset_peer` · client · down (cut after commit) | `POST /withdrawals` with `idempotencyKey` | Client sees connection reset; outcome is ambiguous client-side | **No double-settlement:** replay with same key returns the original tx; one debit; `Σ ledger == balance` | Replay with different key (double-create) → ledger/duplicate assertions must fire |
| RS-04 | `reset_peer` · ops · down, on 2nd approval | Dual-approval (maker-checker) withdrawal | Approver's client sees reset; approval may or may not have landed | Retried approval never double-counts; exactly N **distinct** approvers, maker excluded; single `APPROVED` transition and audit row | Third approval by an already-counted approver via control plane → distinct-approver assertion must fire |
| RS-05 | `limit_data` / `reset_peer` mid-request-body · client · up | Travel-Rule attach (`PUT …/travel-rule`) on a tx ≥ 1000.00 fiat | Write is torn at the network layer; client gets reset/timeout | **Fail closed:** tx cannot leave `TRAVEL_RULE_CHECK` without complete originator+beneficiary data; no partial Travel-Rule record | `/simulator/tx/{id}/force` → `BROADCAST` without payload → gate assertion must go red |
| RS-06 | `reset_peer` · ops · down | Compliance hold release/reject | Officer's client sees reset on an ambiguous release | Hold is atomically `ACTIVE` or `RELEASED`, never in-between; audit row exists **iff** state changed; retry is safe (409/no-op, not double-release) | Force hold state via control plane without audit path → audit-completeness assertion must fire |
| RS-07 | `bandwidth` 16 KB/s · client · down | Paged withdrawals list (~120 provisioned rows, >1 page) | Under-budgeted read aborts cleanly (typed); adequately-budgeted read completes slowly with content identical to the clean-plane read | Throttling is slow, never wrong: byte-identical payload, and post-recovery pagination is complete and duplicate-free | `FALSIFY=RS-07` skips the toxic → the transfer-time-floor assertion must fire |
| RS-08 | `bandwidth` 1 KB/s · client · up (slow request body, ~6 KB) | JSON POST with a pattern-violating `amount` (slow-loris-shaped) | Server accepts the trickle and answers a typed problem+json 400 after full receipt; ops plane entirely unaffected throughout | Typed errors survive degradation; no cross-plane head-of-line blocking; server-side ingress boundedness NOT asserted — recorded as finding F-03 | `FALSIFY=RS-08` skips the toxic → the upload-duration-floor assertion must fire |
| RS-09 | Asymmetric partition: client plane `timeout`, ops plane healthy | Screening `FLAG` → hold → officer resolves while client is dark | Client requests hang/abort; compliance workflow proceeds unimpeded on ops plane | Segregation of duties survives partial degradation: officer can resolve holds; client outage cannot block or corrupt compliance resolution | Apply the timeout toxic to ops plane too → officer-path assertions must fire |
| RS-10 | `reset_peer` intermittently during webhook replay burst · control-adjacent plane | `POST /simulator/webhooks/{id}/replay` ×N for one deposit | Some replays fail at the network layer, some land multiple times | **Exactly-once crediting:** deposit credited once regardless of replay count; `Σ ledger == balance` | Replay against a *fresh* deposit id each time (defeating idempotency surface) → double-credit assertion must fire |
| RS-11 | Seeded chaos sweep: rotating latency/reset/bandwidth toxics across a full lifecycle | Deposit → withdrawal → approvals → screening → Travel Rule → broadcast → confirm | Individual steps fail/retry per RS-02/03/04; lifecycle eventually completes or halts at a gate | Closing sweep: every wallet reconciles (`Σ ledger == balance`), audit log is append-only and complete, no tx in an undefined state | `/simulator/tx/force` one tx mid-sweep into an illegal state → reconciliation/state-machine assertions must fire |
| RS-12 | `timeout` on client plane · up | `GET /health` semantics under partition | Health via degraded plane aborts at the prober's budget; via control plane stays 200 fast — concurrently | Liveness signal is trustworthy: degraded *edge* is distinguishable from degraded *service* at the same instant | `FALSIFY=RS-12` skips the toxic → the degraded-probe-must-abort assertion must fire |

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

## Findings

Confirmed findings now live in [`FINDINGS.md`](FINDINGS.md) (F-01…F-06),
including two discovered while building M2: the shipped compose healthcheck
never turns healthy on Alpine (F-02), and unknown request fields are silently
stripped rather than rejected — which can silently void idempotency (F-04).
