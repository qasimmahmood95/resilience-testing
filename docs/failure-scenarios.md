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
| RS-03 | `limit_data` (64 bytes) · client · down — response cut after server commit | `POST /withdrawals` with `idempotencyKey` | Client sees a torn response (transport error); outcome is ambiguous client-side, but the server HAS committed | **No double-settlement:** replay with the same key returns the original tx (200, same id); exactly one tx exists throughout | `FALSIFY=RS-03` retries with a *different* key → the exactly-one assertion fires (double-create demonstrated) |
| RS-04 | `limit_data` (64 bytes) · ops · down, on the 1st approval's response | Dual-approval (maker-checker) withdrawal ≥ threshold | Approver's client sees a torn response; the approval HAS landed server-side | Ambiguous retries never double-count: duplicate-approver retry → typed 409 `already-decided`; post-completion retry → typed 409; exactly 2 audited approvals, one debit | `FALSIFY=RS-04` skips the cut → the first-approval-must-fail-at-transport assertion fires |
| RS-05 | `limit_data` 64 bytes (below one request line) · ops · up | Travel-Rule attach (`POST …/travel-rule`, operator/compliance/admin — not CLIENT) on a tx ≥ 1000.00 fiat | Attach dies at the transport layer; the server never receives a complete request | **Fail closed:** tx stays in `TRAVEL_RULE_CHECK`, zero gate transitions audited, balance untouched; recovery attach succeeds as a FIRST attach (201) — proof no partial record survived | `FALSIFY=RS-05` skips the cut → the must-die-at-transport assertion fires (the attach just succeeds) |
| RS-06 | `limit_data` 64 bytes (below one response head) · ops · down | Compliance hold release (`POST /holds/{id}/release`, COMPLIANCE_OFFICER only) | Release COMMITS server-side; the officer's response is torn — outcome ambiguous | **Exactly-once resolution:** hold `OPEN → RELEASED` (states: OPEN/RELEASED/REJECTED), one `HOLD_RELEASED` audit row, one debit; retry → typed 409 `hold-not-open`. Atomicity of release→broadcast deliberately NOT claimed (F-08) | `FALSIFY=RS-06` skips the cut → the release-must-die-at-transport assertion fires |
| RS-07 | `bandwidth` 16 KB/s · client · down | Paged withdrawals list (~120 provisioned rows, >1 page) | Under-budgeted read aborts cleanly (typed); adequately-budgeted read completes slowly with content identical to the clean-plane read | Throttling is slow, never wrong: byte-identical payload, and post-recovery pagination is complete and duplicate-free | `FALSIFY=RS-07` skips the toxic → the transfer-time-floor assertion must fire |
| RS-08 | `bandwidth` 1 KB/s · client · up (slow request body, ~6 KB) | JSON POST with a pattern-violating `amount` (slow-loris-shaped) | Server accepts the trickle and answers a typed problem+json 400 after full receipt; ops plane entirely unaffected throughout | Typed errors survive degradation; no cross-plane head-of-line blocking; server-side ingress boundedness NOT asserted — recorded as finding F-03 | `FALSIFY=RS-08` skips the toxic → the upload-duration-floor assertion must fire |
| RS-09 | Asymmetric partition: client plane `timeout` (hold forever), ops plane healthy | Screening `FLAG` → hold → officer resolves while client is dark | Client probes abort at budget; officer reads + releases the hold under 2× the fast-path ceiling on the ops plane | Segregation of duties survives partial degradation: resolution completes correctly while clients are dark; the reconnecting client sees the resolved state | `FALSIFY=RS-09` skips the toxic → the client-plane dark-probe assertion fires (the probe just succeeds) |
| RS-10 | Delivery-layer fault: at-least-once webhook delivery (replay burst ×N of one `deposit.credited` event). Network toxics don't apply — the replay path is the control plane by design (F-01) | `POST /simulator/webhooks/{id}/replay` ×N for one settled deposit | Duplicate deliveries arrive; each replay is accepted AND provably reaches the credit handler (`creditResult.reason == 'already-credited'`) | **Exactly-once crediting:** balance unchanged by every replay; exactly one audited `TRANSACTION_CREDITED` settlement for the deposit | `FALSIFY=RS-10` registers N *fresh* deposits instead of replaying (defeating the dedupe surface) → the balance-unchanged assertion fires |
| RS-11 | Deterministic chaos sweep: a fixed rotation of latency/bandwidth toxics across every step of a full lifecycle | Deposit → withdrawal → dual approval → screening → Travel Rule → broadcast → confirmations | Every step completes correctly (slowly) under continuous degradation; destructive-ambiguity cases are RS-02/03/04's job | Balance conservation (`final = deposit − amount − fee`, the external proxy for the unreadable ledger — F-07), full audited state-machine trail, exactly one tx | `FALSIFY=RS-11` skips all toxics → the per-step degradation floors must fire |
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
