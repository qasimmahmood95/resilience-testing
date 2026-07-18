# Findings

Gaps and sharp edges observed in VaultChain **as an external consumer**. Per
this repo's hard limits, nothing here is fixed in this repo — each entry
records evidence and what an upstream fix would look like. "Confirmed" means
reproduced with captured evidence; "suspected" means observed once or inferred
from source, pending a dedicated reproduction.

---

## F-01 — No injectable internal network boundary (topology limitation, by design)

- **Status:** confirmed (by inspection of the pinned commit).
- **What:** VaultChain is a single Fastify process with embedded SQLite and no
  outbound network I/O; chain, screening, clock, and webhook deliveries are
  in-process simulations. Faults like "screening vendor times out
  mid-workflow" cannot be induced by network fault injection at any boundary
  an external consumer can reach.
- **Impact:** dependency-level failure modes are untestable from outside; the
  equivalent invariants are asserted at the client↔API edge instead
  (RS-05/06/09 reframing — see `failure-scenarios.md`).
- **Upstream shape of a fix:** none required — this is a legitimate design for
  a self-contained SUT. A multi-service topology (screening as a sidecar
  process, DB over TCP) would make dependency-level injection possible.

## F-02 — Shipped compose healthcheck never turns healthy on Alpine

- **Status:** confirmed.
- **What:** VaultChain's `docker-compose.yml` healthcheck probes
  `http://localhost:3000/health` with busybox `wget`. On Alpine/musl,
  `localhost` can resolve to `::1` first; Fastify binds IPv4 `0.0.0.0` only,
  and busybox `wget` does not fall back to the next address. The probe fails
  forever while the server is provably listening.
- **Evidence:** CI run `29644907610` — server logged
  `listening at http://172.18.0.2:3000`, followed by 24 consecutive probe
  failures and `container … is unhealthy`; switching only the probe host to
  `127.0.0.1` (this repo's overlay, commit `9e9b358`) resolves it.
- **Impact:** any consumer that health-gates startup (`docker compose up
  --wait`, Kubernetes-style readiness) sees VaultChain as permanently
  unhealthy. The upstream README's `docker compose up -d` masks this because
  nothing gates on health.
- **Upstream shape of a fix:** probe `127.0.0.1` explicitly (one-word change),
  or bind Fastify to `::` as well.

## F-03 — No server-side request timeout (slow-loris tolerance)

- **Status:** confirmed (source + RS-08 empirical floor).
- **What:** `buildApp()` sets no Fastify `requestTimeout`/`connectionTimeout`
  (both default to 0 = unlimited). A request body trickled at 1 KB/s is
  accepted and held open; RS-08 demonstrates a ~6 s trickle being served
  normally. The suite deliberately does not probe for an upper bound (a
  multi-minute hold would be CI-hostile), so tolerance beyond ~6 s is
  established by source inspection, not measurement.
- **Impact:** a single misbehaving or malicious client can hold server
  connections open indefinitely. In-process SQLite means no connection-pool
  starvation of a shared DB, and RS-08 shows other traffic planes stay
  responsive — so the degradation is bounded in blast radius, but unbounded in
  duration.
- **Upstream shape of a fix:** set `requestTimeout` (e.g. 30 s) in the Fastify
  factory options; one line, no behavioural change for well-behaved clients.

## F-04 — Unknown request fields are silently stripped, not rejected

- **Status:** confirmed.
- **What:** request schemas declare `additionalProperties: false`, but
  Fastify's default AJV configuration (`removeAdditional`) *strips* unknown
  fields instead of rejecting the request. Observed in RS-08 development: a
  `POST /withdrawals` carrying an unknown `padding` field returned **201**,
  not 400.
- **Impact:** an integrator who misspells an optional field gets silent
  acceptance — worst case `idempotencyKey` (e.g. `idempotency_key`), where the
  request succeeds but is **not idempotent**, so a retry double-creates. This
  quietly undermines the platform's own headline idempotency guarantee.
- **Upstream shape of a fix:** configure AJV with `removeAdditional: false`
  so closed request schemas reject with a 400 problem, matching the
  strict-both-directions contract the README claims for the response side.

## F-05 — No account-enumeration endpoint

- **Status:** confirmed.
- **What:** there is no `GET /accounts` (list) route — only `POST /accounts`
  and `GET /accounts/{id}`. A client (or operator) cannot discover account
  ids through the API; they must be captured out-of-band at creation time.
- **Impact:** an external integrator recovering from state loss cannot
  re-enumerate their own accounts; this suite provisions fresh accounts per
  test and records ids from creation responses to work around it.
- **Upstream shape of a fix:** tenant-scoped `GET /accounts` mirroring the
  existing `GET /clients` pattern (CLIENT sees own, staff see all).

## F-06 — `idempotencyKey` is optional (keyless retries double-create by design)

- **Status:** confirmed by inspection (`src/routes/withdrawals.ts` schema:
  key absent from `required`); executable reproduction lands with RS-03 (M3).
- **What:** `POST /withdrawals` treats `idempotencyKey` as optional
  (minLength 8 when present). Without one, an ambiguous-outcome retry (e.g.
  response lost after commit) creates a second withdrawal.
- **Impact:** correct exactly-once behaviour is opt-in; the sharp edge is
  compounded by F-04, which silently discards a misspelled key.
- **Upstream shape of a fix:** require the key on `POST /withdrawals` (breaking
  change), or at minimum document the retry contract prominently in the spec.

## F-07 — Ledger sub-ledger is not externally readable

- **Status:** confirmed (no route in `src/routes/` touches ledger entries).
- **What:** the platform's headline invariant — `Σ(ledger entries for a
  wallet) == wallet.balance`, per asset, always — cannot be verified by an
  external consumer: there is no API that returns ledger entries. VaultChain's
  own suite asserts it via direct DB access, which an integrator (and this
  repo, by its hard limits) does not have.
- **Impact:** external reconciliation/audit tooling cannot exist against this
  API. This suite asserts **balance conservation** instead (RS-11 pins the
  single-withdrawal case exactly: `final = deposit − amount − fee`) — a
  strictly weaker external proxy than ledger reconciliation.
- **Upstream shape of a fix:** a read-only, tenant-scoped
  `GET /wallets/{id}/ledger` (paged like `/audit`), turning the invariant
  into an externally checkable contract.

