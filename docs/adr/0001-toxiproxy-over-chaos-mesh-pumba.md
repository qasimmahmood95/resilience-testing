# ADR-0001: Toxiproxy over chaos-mesh / pumba at this scale

**Status:** accepted / **Date:** 2026-07-18

## Context

We need deterministic network-fault injection against a system-under-test that
is a single Docker Compose stack: one application container (VaultChain) plus
whatever the harness adds. Candidate tools: Chaos Mesh, pumba, Toxiproxy.

## Decision

Use **Toxiproxy** (Shopify), run as a compose service, with per-test toxics
managed over its HTTP API.

## Rationale

- **No orchestrator to chaos.** Chaos Mesh is a Kubernetes operator (CRDs,
  sidecars, a control plane of its own). There is no k8s here - introducing one
  to inject faults into a single compose stack inverts the complexity budget:
  the harness would dwarf the system-under-test.
- **Determinism and scoping.** pumba (and tc/netem generally) degrades a
  *container's interface* - every connection through it, including the test
  runner's own observation traffic. Toxiproxy interposes *per-listener*: we run
  three proxies to the same upstream ("traffic planes", ADR-0002) and degrade
  exactly one while the others - including the plane used to read ground truth
  - stay clean. tc/netem cannot express that without namespace gymnastics.
- **Per-test lifecycle over an API.** Toxics are created and removed by the
  test itself over HTTP, so fixture teardown can *verify* a clean slate (our
  leak-detection fixture does exactly this). pumba's process-lifecycle model
  ("run pumba for N seconds") makes fault boundaries temporal rather than
  test-scoped - a recipe for cross-test poisoning.
- **Failure vocabulary matches the plan.** latency+jitter, black-hole timeout,
  reset_peer, bandwidth, slicer, limit_data cover every scenario in
  `docs/failure-scenarios.md` (RS-01...RS-12) natively.
- **CI cost.** One ~10 MB container, no privileged mode, no NET_ADMIN caps.
  Both chaos-mesh and pumba need elevated privileges CI runners often deny.

## Consequences

- Faults are limited to TCP-level effects on proxied connections - no packet
  loss/corruption below TCP, no CPU/disk pressure. Acceptable: the plan's
  invariants are all client-observable protocol behaviours.
- The proxy is itself a process that can fail; the smoke suite (RS-00) asserts
  proxy health and plane isolation before any scenario runs.
- Tests must connect via the proxy ports, never the upstream directly - the
  compose overlay enforces this by not publishing VaultChain's port at all.
