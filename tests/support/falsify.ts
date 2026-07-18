// Falsification support (CLAUDE.md hard limit 3: no vacuous passes).
//
// `npm run falsify` re-runs each scenario with FALSIFY=<scenario-id>, which
// activates that scenario's documented sabotage — typically "the toxic is
// silently not applied". A resilience test that still passes with its fault
// removed is asserting nothing; the harness (scripts/falsify.ts) fails the
// build when that happens.

/** True when this run deliberately sabotages the given scenario. */
export function sabotaged(scenarioId: string): boolean {
  const active = process.env['FALSIFY'] === scenarioId;
  if (active) {
    console.log(`[FALSIFY] ${scenarioId}: sabotage active — this test MUST fail`);
  }
  return active;
}
