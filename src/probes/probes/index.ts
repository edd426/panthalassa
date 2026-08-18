/**
 * The probe registry, in the plan's P1…P14 order.
 *
 * The order is the report table's order, so the table and the plan's probe
 * table can be read side by side. A probe whose scenario is not in the running
 * suite is skipped and named as skipped — never silently absent, because an
 * absent row reads like a passing one.
 */

import type { ProbeDefinition } from '../probe';
import { determinismProbe } from './determinism';
import { hygieneProbe } from './hygiene';
import { lociProbe, mortalityProbe, viabilityProbe } from './population';
import { driftProbe, flatlineProbe, heritabilityProbe, varianceProbe } from './genetics';
import { barrierProbe } from './barrier';
import { coevolutionProbe, speciationProbe, sweepProbe } from './community';
import { performanceProbe } from './performance';
import { disturbanceProbe, reEvolvabilityProbe } from './disturbance';
import { ageStructureProbe } from './lifehistory';
import { couplingProbe, mimicryProbe } from './aposematism';
import { runawayProbe } from './runaway';

export const PROBES: readonly ProbeDefinition[] = [
  determinismProbe, // P1
  hygieneProbe, // P2
  viabilityProbe, // P3
  varianceProbe, // P4
  flatlineProbe, // P5
  lociProbe, // P6
  mortalityProbe, // P7
  barrierProbe, // P8
  coevolutionProbe, // P9
  sweepProbe, // P10
  speciationProbe, // P11
  performanceProbe, // P12
  heritabilityProbe, // P13
  driftProbe, // P14
  disturbanceProbe, // P15
  reEvolvabilityProbe, // P16
  ageStructureProbe, // P17
  couplingProbe, // P18
  mimicryProbe, // P19
  runawayProbe, // P20
];

/** Scenarios that at least one probe reads, excluding the standalone probes' own harnesses. */
export function scenariosRead(): readonly string[] {
  return [...new Set(PROBES.filter((probe) => probe.standalone !== true).map((probe) => probe.scenario))];
}
