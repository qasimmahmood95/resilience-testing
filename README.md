# resilience-testing

Failure-mode testing of **[VaultChain](https://github.com/qasimmahmood95/vaultchain)**,
a fictional digital-asset custody platform, from the outside, the way an
external integrator would experience it. Network faults are injected with
**Toxiproxy** at the only boundary an outsider can reach. Every test asserts
*behaviour under failure* rather than just failure: compliance gates that
fail closed, typed errors instead of hangs, retries that respect idempotency,
and no double settlements.

> VaultChain is consumed strictly as an external system-under-test: the
> compose overlay builds it from a **remote git context pinned to a commit**.
> This repo contains zero application code and zero patches. Where VaultChain
> lacks an invariant worth asserting, that goes in
> [the findings doc](docs/FINDINGS.md) instead of getting fixed here.

## The architecture in one diagram

VaultChain is a single Fastify process with embedded SQLite, so there are no
internal network hops to break. The harness instead models *traffic planes*:
three Toxiproxy proxies to the same upstream, degradable independently.

```text
                     ┌────────────────────────────────┐
   client-plane ────►│:18000                          │
   (CLIENT actors -  │                                │
    degraded freely) │                                │
                     │          ┌──────────────────┐  │
   ops-plane ───────►│:18001 ──►│ VaultChain :3000 │  │
   (operators &      │          │ (single process, │  │
    compliance -     │          │  embedded SQLite)│  │
    degraded         │          └──────────────────┘  │
    independently)   │                                │
   control-plane ───►│:18002    Toxiproxy             │
   (simulator +      │          (:8474 admin API)     │
    ground truth -   │                                │
    NEVER toxified)  └────────────────────────────────┘
```

The control plane is the design decision the rest depends on: **observation
must survive the fault**. Every ground-truth assertion and every
`/simulator/*` call travels a plane that toxics can never touch. This is
enforced in code rather than by convention: the toxic fixture refuses to
toxify it, and teardown treats a control-plane toxic as a fatal error
regardless of test outcome. Rationale in
[ADR-0002](docs/adr/0002-single-edge-topology-traffic-planes.md); why
Toxiproxy over chaos-mesh/pumba in
[ADR-0001](docs/adr/0001-toxiproxy-over-chaos-mesh-pumba.md).

## Run everything

```bash
npm ci
npm run stack:up        # toxiproxy + vaultchain (pinned remote git build), health-gated
npx playwright test     # 17 tests: RS-00 smoke + 12 failure scenarios
npm run falsify         # every scenario re-run with sabotage; must go RED
npm run stack:down      # clean slate
```

## Scenarios

Twelve scenarios (RS-01 to RS-12), each documented in
[`docs/failure-scenarios.md`](docs/failure-scenarios.md) with its toxic,
plane, expected degraded behaviour, invariant, and falsification lever, and
each implemented as a spec with the same structured header. A few of them:

| | Scenario | Invariant |
|---|---|---|
| RS-02/03 | Black-holed request / response torn **after** the server committed | Exactly-once creation: the idempotency key resolves the ambiguity and replay returns the *original* transaction |
| RS-04 | Dual approval where the first approval's response is torn | Ambiguous retries answered by typed 409s, never a second approval or debit |
| RS-05 | Travel-Rule attach torn mid-request | **Fail closed**: the tx cannot leave `TRAVEL_RULE_CHECK`; no partial record survives |
| RS-06 | Hold release with a torn response | Exactly-once resolution; retry -> typed 409 `hold-not-open` |
| RS-09 | Clients black-holed, ops healthy | Segregation of duties survives partial outage: compliance resolves holds while clients are dark |
| RS-11 | Deterministic chaos across a full lifecycle | Balance conservation + every state transition audited exactly once |

## A worked example: RS-03, the torn response

The scenario every idempotency key exists for:

1. **The fault.** A `limit_data` toxic caps the *response* path at 64 bytes,
   below one HTTP status-line-plus-headers block. The client's
   `POST /withdrawals` reaches VaultChain intact and **commits**; the client
   sees only a dead socket.
2. **The ambiguity.** Did that withdrawal happen? The client cannot know.
   The control plane proves the danger is real: the transaction exists.
3. **The invariant.** The integrator replays with the **same idempotency
   key**: VaultChain answers `200` (not `201`) with the *original*
   transaction. Exactly one withdrawal exists at every point in time.
4. **The falsification.** `FALSIFY=RS-03` replays with a *different* key.
   The double-create happens, the exactly-one assertion goes red, and the
   harness records that the test can catch the failure it guards against.
   A resilience test that cannot fail is worthless, so `npm run falsify`
   enforces this for all twelve scenarios. It requires JSON-reporter
   evidence that at least one test ran and failed; a zero-match grep or a
   crashed run counts as a harness failure, never a pass.

## Findings

Testing a system from outside surfaces what its own suite can't see. Eight
findings so far, each with evidence and an upstream fix shape in
[`docs/FINDINGS.md`](docs/FINDINGS.md). None are fixed here, by rule.
Three examples:

- **F-02**: VaultChain's shipped compose healthcheck can never turn healthy
  on Alpine (`localhost` resolves to `::1`, the server binds IPv4 only, and
  busybox wget doesn't fall back), so any consumer that health-gates startup
  sees a permanently unhealthy container. Confirmed in CI by changing one
  word.
- **F-04**: unknown request fields are **silently stripped** despite
  `additionalProperties: false`. A misspelled `idempotency_key` yields
  `201` with `idempotencyKey: null`, quietly voiding the idempotency
  guarantee. Captured reproduction in the doc.
- **F-08**: hold release and the resulting broadcast/debit run as two
  separate DB transactions. A drained wallet between `HELD` and release
  leaves a `RELEASED` hold on a still-`HELD` transaction.

## Determinism policy

- Every request carries an explicit budget (`AbortSignal.timeout`); every
  toxic parameter and timing threshold is a named constant with its
  derivation commented (including the 64-byte cut: smaller than one request
  line, so "the server never saw it" is deterministic, not probabilistic).
- Serialized execution (`workers: 1`, retries: 0), because toxics and
  VaultChain's sim-clock are global state.
- Leak hygiene as an auto-fixture: every test fails loudly at setup if it
  inherits a toxic, and the teardown sweep is verified. Sim state
  (`/simulator/reset`) guards the tests that arm VaultChain's global
  screening queue.
- Transport-level retries exist only as an explicit, bounded, call-site
  pattern that matches transport error signatures and rethrows everything
  else.

## CI

Two health-gated jobs on every PR and push to `main`, each with its own
clean stack: `resilience` (full suite + HTML report artifact) and `falsify`
(the no-vacuous-passes gate). The repo's merge protocol treats both as
required; mark them required in branch protection to enforce it server-side.

## Limits

- Only the client-API edge is injectable, because VaultChain has no internal
  network (F-01). Dependency-level faults ("screening vendor timeout") are
  reframed as edge interruptions; that reframing is documented per scenario.
- The ledger sub-ledger is not externally readable (F-07), so ledger
  reconciliation is asserted via balance conservation, the strongest
  externally visible proxy.
- Toxiproxy injects TCP-level faults on proxied connections; packet-level
  corruption and resource pressure are out of scope (ADR-0001).
