// Falsification harness (CLAUDE.md hard limit 3: no vacuous passes).
//
// For each scenario, re-run its spec with FALSIFY=<id>, which activates the
// documented sabotage inside the test (typically: the toxic is silently not
// applied). Under sabotage the test MUST fail — a test that still passes with
// its fault removed cannot detect the fault and is worthless. The harness
// exits non-zero (failing the build) if ANY scenario survives sabotage.
//
// Run against an already-up stack: `npm run falsify`.

import { spawnSync } from 'node:child_process';

/** Scenario id → grep that selects exactly that spec. */
const SCENARIOS: readonly { id: string; grep: string }[] = [
  { id: 'RS-01', grep: 'RS-01' },
  { id: 'RS-02', grep: 'RS-02' },
  { id: 'RS-07', grep: 'RS-07' },
  { id: 'RS-08', grep: 'RS-08' },
  { id: 'RS-12', grep: 'RS-12' },
];

interface Outcome {
  id: string;
  sabotageDetected: boolean;
}

const outcomes: Outcome[] = [];

for (const scenario of SCENARIOS) {
  console.log(`\n=== FALSIFY ${scenario.id}: running its spec with sabotage active ===`);
  const run = spawnSync('npx', ['playwright', 'test', '--grep', scenario.grep, '--reporter=line'], {
    env: { ...process.env, FALSIFY: scenario.id, PW_TEST_HTML_REPORT_OPEN: 'never' },
    stdio: 'inherit',
    timeout: 300_000,
  });
  // Non-zero exit = the suite failed under sabotage = the test CAN detect its
  // fault. Zero exit = vacuous test.
  outcomes.push({ id: scenario.id, sabotageDetected: run.status !== 0 });
}

console.log('\n=== Falsification summary ===');
let vacuous = 0;
for (const o of outcomes) {
  console.log(`  ${o.id}: ${o.sabotageDetected ? 'OK — failed under sabotage' : 'VACUOUS — passed with its fault removed'}`);
  if (!o.sabotageDetected) vacuous += 1;
}

if (vacuous > 0) {
  console.error(`\n${vacuous} scenario(s) passed with their fault removed. A resilience test that cannot fail is worthless (CLAUDE.md hard limit 3).`);
  process.exit(1);
}
console.log('\nAll scenarios fail under sabotage — no vacuous passes.');
