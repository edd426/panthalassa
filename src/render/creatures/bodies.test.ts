import { describe, expect, it } from 'vitest';
import { ARMOR_RENDER_RANGE } from '../contracts';
import type { CladeArchetype } from '../../contracts/genome';
import { CLADE_ARCHETYPES, CLADE_SCHEMA } from '../../contracts/genome';
import type { BodyGeometry, BodyParams, Polyline } from './bodies';
import {
  bellPointCount,
  buildBody,
  carapaceProfile,
  clampBodyAspect,
  clampFinPairs,
  clampSegments,
  createBodyGeometry,
  finPolygonCount,
  fusiformProfile,
  outlinePointCount,
  platePolygonCount,
  strokePolylineCount,
} from './bodies';

function params(archetype: CladeArchetype, overrides: Partial<BodyParams> = {}): BodyParams {
  const schema = CLADE_SCHEMA[archetype];
  return {
    archetype,
    segmentCount: schema.segmentCount.typical,
    finPairs: schema.finPairs.typical,
    bodyAspect: schema.bodyAspect.typical,
    armorPlating: 0.35,
    phase: 0,
    pulsePhase: 0,
    amplitudeScale: 1,
    ...overrides,
  };
}

function bounds(line: Polyline): { width: number; height: number; minX: number; maxX: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < line.count; i += 1) {
    const x = line.points[i * 2] ?? 0;
    const y = line.points[i * 2 + 1] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { width: maxX - minX, height: maxY - minY, minX, maxX };
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Strict crossing: shared or collinear endpoints do not count, a fold-through does. */
function crosses(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  return o1 > 0 !== o2 > 0 && o3 > 0 !== o4 > 0;
}

/** Indices of the first pair of non-adjacent edges of a closed outline that cross. */
function selfCrossing(line: Polyline): [number, number] | null {
  const n = line.count;
  const at = (i: number, axis: number): number => line.points[(i % n) * 2 + axis] ?? 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (
        crosses(
          at(i, 0), at(i, 1), at(i + 1, 0), at(i + 1, 1),
          at(j, 0), at(j, 1), at(j + 1, 0), at(j + 1, 1),
        )
      ) {
        return [i, j];
      }
    }
  }
  return null;
}

function samePoints(a: Polyline, b: Polyline): boolean {
  if (a.count !== b.count) return false;
  for (let i = 0; i < a.count * 2; i += 1) {
    if ((a.points[i] ?? 0) !== (b.points[i] ?? 0)) return false;
  }
  return true;
}

describe('width profiles', () => {
  it('peaks a fusiform swimmer 30% back and a carapace 40% back, zero at both ends', () => {
    expect(fusiformProfile(0)).toBe(0);
    expect(fusiformProfile(1)).toBe(0);
    expect(fusiformProfile(0.3)).toBeCloseTo(1, 12);
    expect(carapaceProfile(0)).toBe(0);
    expect(carapaceProfile(1)).toBe(0);
    expect(carapaceProfile(0.4)).toBeCloseTo(1, 12);
    for (const profile of [fusiformProfile, carapaceProfile]) {
      for (let step = 1; step < 100; step += 1) {
        const value = profile(step / 100);
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
  });
});

describe('point counts', () => {
  it('matches the documented function of (segments, finPairs)', () => {
    const geometry = createBodyGeometry();
    for (const archetype of CLADE_ARCHETYPES) {
      const schema = CLADE_SCHEMA[archetype];
      const [segLow, segHigh] = schema.segmentCount.renderRange;
      const [finLow, finHigh] = schema.finPairs.renderRange;
      for (let segments = segLow; segments <= segHigh; segments += 1) {
        for (let finPairs = finLow; finPairs <= finHigh; finPairs += 1) {
          buildBody(params(archetype, { segmentCount: segments, finPairs }), geometry);
          expect(geometry.outline.count).toBe(outlinePointCount(archetype, segments));
          expect(geometry.finCount).toBe(finPolygonCount(archetype, finPairs));
          expect(geometry.plateCount).toBe(platePolygonCount(archetype, segments));
          expect(geometry.strokeCount).toBe(strokePolylineCount(archetype, segments, finPairs));
        }
      }
    }
  });

  it('spells out the per-archetype formulas', () => {
    expect(outlinePointCount('undulator', 8)).toBe(14); // 2S − 2
    expect(outlinePointCount('armoredCrawler', 12)).toBe(24); // 2S
    expect(outlinePointCount('radialDrifter', 5)).toBe(bellPointCount(5));
    expect(bellPointCount(2)).toBe(16); // floored
    expect(bellPointCount(5)).toBe(30);
    expect(bellPointCount(12)).toBe(48); // ceilinged
    expect(finPolygonCount('undulator', 3)).toBe(6);
    expect(finPolygonCount('radialDrifter', 3)).toBe(0);
    expect(strokePolylineCount('armoredCrawler', 12, 4)).toBe(9); // 2F + midline
    expect(strokePolylineCount('radialDrifter', 3, 2)).toBe(7); // S arms + 2F tentacles
    expect(strokePolylineCount('undulator', 8, 4)).toBe(0);
  });

  it('never truncates against the preallocated buffers at the top of every range', () => {
    const geometry = createBodyGeometry();
    for (const archetype of CLADE_ARCHETYPES) {
      const schema = CLADE_SCHEMA[archetype];
      buildBody(
        params(archetype, {
          segmentCount: schema.segmentCount.renderRange[1],
          finPairs: schema.finPairs.renderRange[1],
          bodyAspect: schema.bodyAspect.renderRange[0],
        }),
        geometry,
      );
      expect(geometry.outline.count * 2).toBeLessThanOrEqual(geometry.outline.points.length);
      for (let i = 0; i < geometry.plateCount; i += 1) {
        const plate = geometry.plates[i];
        expect(plate).toBeDefined();
        expect((plate?.count ?? 0) * 2).toBeLessThanOrEqual(plate?.points.length ?? 0);
      }
      for (let i = 0; i < geometry.strokeCount; i += 1) {
        const stroke = geometry.strokes[i];
        expect(stroke).toBeDefined();
        expect(stroke?.count ?? 0).toBeGreaterThanOrEqual(2);
        expect((stroke?.count ?? 0) * 2).toBeLessThanOrEqual(stroke?.points.length ?? 0);
      }
      for (let i = 0; i < geometry.finCount; i += 1) {
        expect(geometry.fins[i]?.count).toBe(3);
      }
    }
  });
});

describe('renderRange clamps', () => {
  it('saturates rather than extrapolating past CLADE_SCHEMA', () => {
    for (const archetype of CLADE_ARCHETYPES) {
      const schema = CLADE_SCHEMA[archetype];
      const [segLow, segHigh] = schema.segmentCount.renderRange;
      const [finLow, finHigh] = schema.finPairs.renderRange;
      const [aspectLow, aspectHigh] = schema.bodyAspect.renderRange;
      expect(clampSegments(archetype, 10_000)).toBe(segHigh);
      expect(clampSegments(archetype, -10_000)).toBe(segLow);
      expect(clampFinPairs(archetype, 10_000)).toBe(finHigh);
      expect(clampFinPairs(archetype, -10_000)).toBe(finLow);
      expect(clampBodyAspect(archetype, 10_000)).toBe(aspectHigh);
      expect(clampBodyAspect(archetype, -10_000)).toBe(aspectLow);
    }
  });

  it('draws an out-of-range organism exactly as the range edge', () => {
    const wild = createBodyGeometry();
    const edge = createBodyGeometry();
    for (const archetype of CLADE_ARCHETYPES) {
      const schema = CLADE_SCHEMA[archetype];
      buildBody(
        params(archetype, {
          segmentCount: 10_000,
          finPairs: 10_000,
          bodyAspect: 10_000,
          armorPlating: 10_000,
        }),
        wild,
      );
      buildBody(
        params(archetype, {
          segmentCount: schema.segmentCount.renderRange[1],
          finPairs: schema.finPairs.renderRange[1],
          bodyAspect: schema.bodyAspect.renderRange[1],
          armorPlating: ARMOR_RENDER_RANGE[1],
        }),
        edge,
      );
      expect(samePoints(wild.outline, edge.outline)).toBe(true);
      expect(wild.finCount).toBe(edge.finCount);
      expect(wild.plateCount).toBe(edge.plateCount);
      expect(wild.strokeCount).toBe(edge.strokeCount);
      expect(wild.armorLightening).toBe(edge.armorLightening);
      expect(wild.armorLightening).toBe(1);
    }
  });

  it('maps armorPlating into a 0..1 lightening and a monotone plate weight', () => {
    const geometry = createBodyGeometry();
    let previousWeight = -Infinity;
    for (const armor of [-5, 0, 0.35, 1.2, 2.5, 40]) {
      buildBody(params('armoredCrawler', { armorPlating: armor }), geometry);
      expect(geometry.armorLightening).toBeGreaterThanOrEqual(0);
      expect(geometry.armorLightening).toBeLessThanOrEqual(1);
      expect(geometry.plateStrokeWidth).toBeGreaterThanOrEqual(previousWeight);
      previousWeight = geometry.plateStrokeWidth;
    }
  });
});

describe('local frame', () => {
  it('puts the head at the origin and the body anti-heading', () => {
    const geometry = createBodyGeometry();
    for (const archetype of CLADE_ARCHETYPES) {
      for (const phase of [0, 1.4, 3.9]) {
        buildBody(params(archetype, { phase, pulsePhase: phase / 7 }), geometry);
        expect(geometry.outline.points[0] ?? 1).toBeCloseTo(0, 12);
        expect(geometry.outline.points[1] ?? 1).toBeCloseTo(0, 12);
        const box = bounds(geometry.outline);
        expect(box.maxX).toBeCloseTo(0, 12);
        expect(box.minX).toBeLessThan(-0.5);
        // Unit length, plus the drifter's contraction lengthening of up to 4%.
        expect(box.minX).toBeGreaterThanOrEqual(-1.05);
      }
    }
  });

  it('changes width with bodyAspect and leaves length alone', () => {
    const geometry = createBodyGeometry();
    for (const archetype of CLADE_ARCHETYPES) {
      const [low, high] = CLADE_SCHEMA[archetype].bodyAspect.renderRange;
      let lengthAtLow = 0;
      let previousWidthTimesAspect = 0;
      for (let step = 0; step <= 8; step += 1) {
        const aspect = low + ((high - low) * step) / 8;
        // Undulation frozen (and the bell pulse held at one phase) so the test
        // reads the width profile rather than the wave's lateral sweep.
        buildBody(params(archetype, { bodyAspect: aspect, amplitudeScale: 0 }), geometry);
        const box = bounds(geometry.outline);
        if (step === 0) lengthAtLow = box.width;
        expect(box.width).toBeCloseTo(lengthAtLow, 12);
        const invariant = box.height * aspect;
        if (step > 0) expect(invariant).toBeCloseTo(previousWidthTimesAspect, 10);
        previousWidthTimesAspect = invariant;
      }
    }
  });

  it('is a pure function of its parameters', () => {
    const a = createBodyGeometry();
    const b = createBodyGeometry();
    for (const archetype of CLADE_ARCHETYPES) {
      const p = params(archetype, { phase: 2.3, pulsePhase: 0.61, segmentCount: 7, finPairs: 3 });
      buildBody(p, a);
      buildBody(p, b);
      expect(samePoints(a.outline, b.outline)).toBe(true);
      expect(a.eyeX).toBe(b.eyeX);
      expect(a.eyeR).toBe(b.eyeR);
    }
  });

  it('keeps the accent mark inside the body it belongs to', () => {
    const geometry = createBodyGeometry();
    for (const archetype of CLADE_ARCHETYPES) {
      buildBody(params(archetype), geometry);
      expect(geometry.eyeR).toBeGreaterThan(0);
      expect(geometry.eyeX).toBeLessThanOrEqual(0);
      expect(geometry.eyeX).toBeGreaterThan(-1);
      expect(Math.abs(geometry.eyeY)).toBeLessThanOrEqual(geometry.maxHalfWidth + 1e-12);
    }
  });
});

describe('outline integrity', () => {
  it('closes without self-crossing across every archetype and morphology corner', () => {
    const geometry = createBodyGeometry();
    for (const archetype of CLADE_ARCHETYPES) {
      const schema = CLADE_SCHEMA[archetype];
      const [segLow, segHigh] = schema.segmentCount.renderRange;
      const [aspectLow, aspectHigh] = schema.bodyAspect.renderRange;
      for (const segments of [segLow, Math.round((segLow + segHigh) / 2), segHigh]) {
        for (let aspectStep = 0; aspectStep <= 4; aspectStep += 1) {
          const bodyAspect = aspectLow + ((aspectHigh - aspectLow) * aspectStep) / 4;
          for (let phaseStep = 0; phaseStep < 8; phaseStep += 1) {
            const phase = (phaseStep / 8) * 2 * Math.PI;
            buildBody(
              params(archetype, { segmentCount: segments, bodyAspect, phase, pulsePhase: phaseStep / 8 }),
              geometry,
            );
            const hit = selfCrossing(geometry.outline);
            expect(
              hit,
              `${archetype} segments=${segments} aspect=${bodyAspect.toFixed(2)} phase=${phase.toFixed(2)}`,
            ).toBeNull();
          }
        }
      }
    }
  });

  it('encloses a positive area, so the fill is never inside-out', () => {
    const geometry = createBodyGeometry();
    for (const archetype of CLADE_ARCHETYPES) {
      buildBody(params(archetype, { phase: 1.1, pulsePhase: 0.3 }), geometry);
      const line = geometry.outline;
      let twiceArea = 0;
      for (let i = 0; i < line.count; i += 1) {
        const j = (i + 1) % line.count;
        twiceArea +=
          (line.points[i * 2] ?? 0) * (line.points[j * 2 + 1] ?? 0) -
          (line.points[j * 2] ?? 0) * (line.points[i * 2 + 1] ?? 0);
      }
      expect(Math.abs(twiceArea) / 2).toBeGreaterThan(0.01);
    }
  });
});

describe('archetype reads', () => {
  it('draws an eel-like undulator long and thin and a stubby one short and fat', () => {
    const geometry = createBodyGeometry();
    buildBody(params('undulator', { bodyAspect: 9, amplitudeScale: 0 }), geometry);
    const eel = bounds(geometry.outline);
    buildBody(params('undulator', { bodyAspect: 1.2, amplitudeScale: 0 }), geometry);
    const stubby = bounds(geometry.outline);
    expect(eel.width / eel.height).toBeGreaterThan(4 * (stubby.width / stubby.height));
  });

  it('lets a slender undulator sweep far harder than a stubby one', () => {
    const geometry = createBodyGeometry();
    const swings = [9, 1.2].map((bodyAspect) => {
      let swing = 0;
      for (let step = 0; step < 16; step += 1) {
        buildBody(params('undulator', { segmentCount: 16, bodyAspect, phase: (step / 16) * 2 * Math.PI }), geometry);
        swing = Math.max(swing, Math.abs(geometry.chain.ys[geometry.chain.count - 1] ?? 0));
      }
      return swing;
    });
    const [eel = 0, stubby = 0] = swings;
    expect(stubby).toBeGreaterThan(0);
    expect(eel).toBeGreaterThan(stubby * 3);
  });

  it('gives the crawler one shingled plate per somite, overlapping its neighbour', () => {
    const geometry = createBodyGeometry();
    buildBody(params('armoredCrawler', { segmentCount: 12, amplitudeScale: 0 }), geometry);
    expect(geometry.plateCount).toBe(12);
    const gap = 1 / geometry.chain.count;
    for (let p = 0; p < geometry.plateCount; p += 1) {
      const plate = geometry.plates[p];
      expect(plate).toBeDefined();
      if (plate === undefined) continue;
      expect(bounds(plate).width).toBeGreaterThan(gap);
    }
  });

  it('lags the drifter tentacles behind the bell pulse', () => {
    const geometry = createBodyGeometry();
    const tips: number[] = [];
    for (const pulsePhase of [0, 0.25, 0.5, 0.75]) {
      buildBody(params('radialDrifter', { finPairs: 2, pulsePhase }), geometry);
      const arms = clampSegments('radialDrifter', CLADE_SCHEMA.radialDrifter.segmentCount.typical);
      const tentacle = geometry.strokes[arms];
      expect(tentacle).toBeDefined();
      tips.push(tentacle?.points[(TENTACLE_TIP - 1) * 2 + 1] ?? 0);
    }
    expect(new Set(tips.map((v) => v.toFixed(6))).size).toBe(tips.length);
  });

  it('stiffens the crawler spine relative to the undulator at the same phase', () => {
    const geometry = createBodyGeometry();
    let crawlerSwing = 0;
    let undulatorSwing = 0;
    for (let step = 0; step < 16; step += 1) {
      const phase = (step / 16) * 2 * Math.PI;
      buildBody(params('armoredCrawler', { segmentCount: 12, bodyAspect: 2, phase }), geometry);
      crawlerSwing = Math.max(crawlerSwing, Math.abs(geometry.chain.ys[geometry.chain.count - 1] ?? 0));
      buildBody(params('undulator', { segmentCount: 12, bodyAspect: 2, phase }), geometry);
      undulatorSwing = Math.max(undulatorSwing, Math.abs(geometry.chain.ys[geometry.chain.count - 1] ?? 0));
    }
    expect(crawlerSwing).toBeGreaterThan(0);
    expect(crawlerSwing).toBeLessThan(undulatorSwing * 0.5);
  });
});

/** Tentacle polylines carry five points; the last is the free tip. */
const TENTACLE_TIP = 5;

describe('geometry reuse', () => {
  it('leaves no stale points behind when a slot is rebuilt as another archetype', () => {
    const geometry: BodyGeometry = createBodyGeometry();
    buildBody(params('armoredCrawler', { segmentCount: 28, finPairs: 10 }), geometry);
    buildBody(params('radialDrifter', { segmentCount: 3, finPairs: 0 }), geometry);
    expect(geometry.plateCount).toBe(0);
    expect(geometry.finCount).toBe(0);
    expect(geometry.strokeCount).toBe(3);
    expect(geometry.outline.count).toBe(bellPointCount(3));
    buildBody(params('undulator', { segmentCount: 8, finPairs: 2 }), geometry);
    expect(geometry.plateCount).toBe(0);
    expect(geometry.strokeCount).toBe(0);
    expect(geometry.finCount).toBe(4);
  });
});
