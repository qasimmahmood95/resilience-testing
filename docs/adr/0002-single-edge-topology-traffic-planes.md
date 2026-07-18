# ADR-0002: Single-edge topology and traffic-plane proxies

**Status:** accepted · **Date:** 2026-07-18

## Context

Classic resilience testing interposes on inter-service links: app ↔ database,
app ↔ screening vendor, app ↔ chain node. VaultChain has none of those links.
It is a single Fastify process with embedded SQLite in one container, zero
outbound network I/O; its "downstream dependencies" (chain, screening, clock,
webhook deliveries) are in-process simulations driven via `/simulator/*`
(verified against the pinned source; see also VaultChain README §9). The only
network boundary an external consumer can interpose is **client ↔ API edge**.

Two risks follow. First, injecting a fault on "the" edge also degrades the
test's own observation traffic, so a test could time out reading the state it
needs to assert on — corrupting *measurement*, not just the path under test.
Second, real incidents are usually *partial*: some callers degraded, others
fine; a single shared path can't express that.

## Decision

Run **three Toxiproxy proxies to the same upstream**, segregating traffic by
*role of the caller*, and pin each test's traffic to its plane:

| Plane | Port | Carries | Toxifiable |
|---|---|---|---|
| `client-plane` | 18000 | CLIENT-actor API traffic | yes — the path under test |
| `ops-plane` | 18001 | OPERATOR / COMPLIANCE_OFFICER traffic | yes — independently |
| `control-plane` | 18002 | `/simulator/*` + all ground-truth assertion reads | **never** |

The never-toxified rule is enforced in code: the toxic fixture refuses to
apply a toxic to `control-plane`, and teardown asserts it carries none.
VaultChain's app port is not published, so no test can accidentally bypass
the planes.

## Rationale

- **Observation integrity.** Assertions about post-fault state must be exactly
  as trustworthy during a fault as after it. A dedicated clean plane makes the
  observer's channel a controlled variable rather than collateral damage.
- **Asymmetric degradation is the interesting case.** "Clients dark,
  compliance officers healthy" (RS-09) is a real operational posture —
  segregation-of-duties must survive partial outages. Distinct planes express
  it directly.
- **Same upstream, so no fidelity loss.** All planes hit the same process and
  the same SQLite state; the split changes only *which connections* a fault
  touches.

## Consequences

- Dependency-level faults ("screening vendor times out") are **out of reach by
  design**; the equivalent invariants are asserted at the edge (interrupted
  writes must fail closed — RS-05/06) and the limitation is recorded in
  `docs/FINDINGS.md`.
- Plane discipline is a suite convention: a test that reads ground truth
  through a degraded plane is a bug even if it passes. The code-review
  subagent checklist includes this.
- Toxiproxy becomes a single point of failure for all planes; accepted at this
  scale (RS-00 smoke-gates it), and mitigated by the fact that a dead proxy
  fails tests loudly rather than silently.
