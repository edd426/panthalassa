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
  nearVertexCount,
  outlinePointCount,
  platePolygonCount,
  strokePolylineCount,
  PATTERN_MARKS,
} from './bodies';
import { PATTERN_FAMILIES } from './divergence';

function params(archetype: CladeArchetype, overrides: Partial<BodyParams> = {}): BodyParams {
  const schema = CLADE_SCHEMA[archetype];
  return {
    archetype,
    segmentCount: schema.segmentCount.typical,
    finPairs: schema.finPairs.typical,
    bodyAspect: schema.bodyAspect.typical,
    armorPlating: 0.35,
    headForm: 0,
    spination: 0,
    juvenile: 0,
    patternFamily: 'none',
    patternPhase: 0.5,
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

describe('the near-tier cost model', () => {
  it('predicts the emitted point total exactly, for every morphology in range', () => {
    const geometry = createBodyGeometry();
    for (const archetype of CLADE_ARCHETYPES) {
      const schema = CLADE_SCHEMA[archetype];
      const [segLow, segHigh] = schema.segmentCount.renderRange;
      const [finLow, finHigh] = schema.finPairs.renderRange;
      for (let segments = segLow; segments <= segHigh; segments += 1) {
        for (let finPairs = finLow; finPairs <= finHigh; finPairs += 1) {
          buildBody(params(archetype, { segmentCount: segments, finPairs }), geometry);
          let emitted = geometry.outline.count + geometry.mouth.count;
          for (let i = 0; i < geometry.finCount; i += 1) emitted += geometry.fins[i]?.count ?? 0;
          for (let i = 0; i < geometry.plateCount; i += 1) emitted += geometry.plates[i]?.count ?? 0;
          for (let i = 0; i < geometry.strokeCount; i += 1) emitted += geometry.strokes[i]?.count ?? 0;
          for (let i = 0; i < geometry.patternCount; i += 1) emitted += geometry.patterns[i]?.count ?? 0;
          expect(
            nearVertexCount(archetype, segments, finPairs),
            `${archetype} segments=${segments} finPairs=${finPairs}`,
          ).toBe(emitted);
        }
      }
    }
  });

  it('saturates with the renderRange clamps rather than running away', () => {
    for (const archetype of CLADE_ARCHETYPES) {
      const schema = CLADE_SCHEMA[archetype];
      expect(nearVertexCount(archetype, 10_000, 10_000)).toBe(
        nearVertexCount(archetype, schema.segmentCount.renderRange[1], schema.finPairs.renderRange[1]),
      );
    }
  });

  it('spans the range that makes a flat body-count cap the wrong knob', () => {
    // The budget exists because these differ by more than an order of
    // magnitude, and which one a world is full of is decided by evolution.
    const cheapest = nearVertexCount('undulator', 4, 0);
    const dearest = nearVertexCount('armoredCrawler', 28, 10);
    expect(cheapest).toBe(15);
    expect(dearest).toBe(378);
    expect(dearest / cheapest).toBeGreaterThan(15);
    // A crawler is the expensive archetype at its own typical morphology too.
    // The multiple is 4.7 rather than the ~6 of the pre-divergence shapes: the
    // jaw line and the species marks are a flat 9 points on every body, so they
    // weigh proportionally more on the cheap archetype.
    expect(nearVertexCount('armoredCrawler', 12, 4)).toBeGreaterThan(
      4 * nearVertexCount('undulator', 8, 2),
    );
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
  /**
   * The sweep now runs the two divergence axes as well, and it has to: the head
   * form and the spination both displace outline stations, and the serration is
   * the only one of the two that pushes *outward* on a curving chain, which is
   * the condition an offset curve folds under. Sweeping morphology alone would
   * have passed the whole time.
   */
  it('closes without self-crossing across every archetype, morphology and divergence corner', () => {
    const geometry = createBodyGeometry();
    for (const archetype of CLADE_ARCHETYPES) {
      const schema = CLADE_SCHEMA[archetype];
      const [segLow, segHigh] = schema.segmentCount.renderRange;
      const [aspectLow, aspectHigh] = schema.bodyAspect.renderRange;
      for (const segments of [segLow, Math.round((segLow + segHigh) / 2), segHigh]) {
        for (let aspectStep = 0; aspectStep <= 4; aspectStep += 1) {
          const bodyAspect = aspectLow + ((aspectHigh - aspectLow) * aspectStep) / 4;
          for (const headForm of [-1, 0, 1]) {
            for (const spination of [0, 0.5, 1]) {
              for (let phaseStep = 0; phaseStep < 8; phaseStep += 1) {
                const phase = (phaseStep / 8) * 2 * Math.PI;
                buildBody(
                  params(archetype, {
                    segmentCount: segments,
                    bodyAspect,
                    headForm,
                    spination,
                    phase,
                    pulsePhase: phaseStep / 8,
                  }),
                  geometry,
                );
                const hit = selfCrossing(geometry.outline);
                expect(
                  hit,
                  `${archetype} segments=${segments} aspect=${bodyAspect.toFixed(2)} head=${headForm} spines=${spination} phase=${phase.toFixed(2)}`,
                ).toBeNull();
              }
            }
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

/** Half-width of the outline at a fraction `s` back from the nose. */
function halfWidthAt(geometry: BodyGeometry, s: number): number {
  const chain = geometry.chain;
  const n = chain.count;
  const i = Math.max(1, Math.min(n - 2, Math.round(s * (n - 1))));
  const dorsalX = geometry.outline.points[i * 2] ?? 0;
  const dorsalY = geometry.outline.points[i * 2 + 1] ?? 0;
  const cx = chain.xs[i] ?? 0;
  const cy = chain.ys[i] ?? 0;
  return Math.hypot(dorsalX - cx, dorsalY - cy);
}

function outlineDelta(a: Polyline, b: Polyline): number {
  if (a.count !== b.count) return Infinity;
  let worst = 0;
  for (let i = 0; i < a.count; i += 1) {
    worst = Math.max(
      worst,
      Math.hypot((a.points[i * 2] ?? 0) - (b.points[i * 2] ?? 0), (a.points[i * 2 + 1] ?? 0) - (b.points[i * 2 + 1] ?? 0)),
    );
  }
  return worst;
}

function insidePolygon(line: Polyline, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = line.count - 1; i < line.count; j = i, i += 1) {
    const xi = line.points[i * 2] ?? 0;
    const yi = line.points[i * 2 + 1] ?? 0;
    const xj = line.points[j * 2] ?? 0;
    const yj = line.points[j * 2 + 1] ?? 0;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const TRUNK_ARCHETYPES: readonly CladeArchetype[] = ['undulator', 'armoredCrawler'];

describe('diet → head form', () => {
  it('draws a blunt snout at negative diet and a wedge at positive, monotonically', () => {
    const geometry = createBodyGeometry();
    for (const archetype of TRUNK_ARCHETYPES) {
      let previous = Infinity;
      for (let step = 0; step <= 12; step += 1) {
        const headForm = -1 + step / 6;
        buildBody(params(archetype, { segmentCount: 14, headForm, amplitudeScale: 0 }), geometry);
        const width = halfWidthAt(geometry, 0.08);
        expect(width, `${archetype} headForm=${headForm.toFixed(2)}`).toBeLessThan(previous);
        previous = width;
      }
    }
  });

  it('separates the two extremes by enough to actually read as a different animal', () => {
    // Measured over the snout, not the whole head window: the shaping is
    // strongest at the nose (2.9x there) and rolls off to nothing by
    // HEAD_WINDOW, which is what makes it read as a head rather than as a
    // thinner animal. Averaging over the full window would dilute it to 1.17
    // and pass a threshold that no longer means anything.
    const geometry = createBodyGeometry();
    const snout = (headForm: number): number => {
      buildBody(params('undulator', { segmentCount: 20, headForm, amplitudeScale: 0 }), geometry);
      return halfWidthAt(geometry, 0.05) + halfWidthAt(geometry, 0.1) + halfWidthAt(geometry, 0.15);
    };
    expect(snout(-1) / snout(1)).toBeGreaterThan(1.5);
    // And the blunt end really is blunt: a nose at most of the shoulder width.
    buildBody(params('undulator', { segmentCount: 20, headForm: -1, amplitudeScale: 0 }), geometry);
    expect(halfWidthAt(geometry, 0.05)).toBeGreaterThan(geometry.maxHalfWidth * 0.85);
    buildBody(params('undulator', { segmentCount: 20, headForm: 1, amplitudeScale: 0 }), geometry);
    expect(halfWidthAt(geometry, 0.05)).toBeLessThan(geometry.maxHalfWidth * 0.4);
  });

  it('is continuous through diet 0, where the exponent is exactly 1', () => {
    // The channel a lineage crosses when it stops grazing and starts hunting.
    // A pop here would read as the animal being replaced rather than changing.
    const previous = createBodyGeometry();
    const current = createBodyGeometry();
    for (const archetype of TRUNK_ARCHETYPES) {
      let worst = 0;
      for (let step = -20; step <= 20; step += 1) {
        buildBody(params(archetype, { segmentCount: 14, headForm: (step - 1) / 200 }), previous);
        buildBody(params(archetype, { segmentCount: 14, headForm: step / 200 }), current);
        worst = Math.max(worst, outlineDelta(previous.outline, current.outline));
      }
      // A 0.005 step in head form moves no outline point by more than a
      // thousandth of a body length anywhere across the neutral zone.
      expect(worst, archetype).toBeLessThan(0.001);
    }
    buildBody(params('undulator', { headForm: 0, amplitudeScale: 0 }), current);
    buildBody(params('undulator', { headForm: 0, amplitudeScale: 0 }), previous);
    expect(outlineDelta(previous.outline, current.outline)).toBe(0);
  });

  it('gives the trunk archetypes a jaw line that lengthens with the head form, and the drifter none', () => {
    const geometry = createBodyGeometry();
    for (const archetype of TRUNK_ARCHETYPES) {
      let previous = 0;
      for (const headForm of [-1, -0.5, 0, 0.5, 1]) {
        buildBody(params(archetype, { headForm, amplitudeScale: 0 }), geometry);
        expect(geometry.hasMouth).toBe(true);
        expect(geometry.mouth.count).toBe(3);
        // The jaw starts at the nose, so its reach is the distance to its tip.
        const reach = Math.hypot(geometry.mouth.points[4] ?? 0, geometry.mouth.points[5] ?? 0);
        expect(reach, `${archetype} headForm=${headForm}`).toBeGreaterThan(previous);
        previous = reach;
      }
    }
    buildBody(params('radialDrifter', { headForm: 1 }), geometry);
    expect(geometry.hasMouth).toBe(false);
  });

  it('grows and advances the eye for a hunter, and keeps it inside the head', () => {
    const geometry = createBodyGeometry();
    buildBody(params('undulator', { segmentCount: 14, headForm: -1, amplitudeScale: 0 }), geometry);
    const grazerR = geometry.eyeR;
    const grazerX = geometry.eyeX;
    buildBody(params('undulator', { segmentCount: 14, headForm: 1, amplitudeScale: 0 }), geometry);
    expect(geometry.eyeR).toBeGreaterThan(grazerR * 1.4);
    expect(geometry.eyeX).toBeGreaterThan(grazerX);
    // Bigger on a narrower head is only a read if it still fits on the head.
    for (const headForm of [-1, -0.5, 0, 0.5, 1]) {
      buildBody(params('undulator', { segmentCount: 14, headForm, amplitudeScale: 0 }), geometry);
      expect(Math.abs(geometry.eyeY) + geometry.eyeR, `headForm=${headForm}`).toBeLessThanOrEqual(
        geometry.maxHalfWidth,
      );
    }
  });
});

describe('defense → spination', () => {
  it('serrates the dorsal line and leaves the ventral one alone', () => {
    const smooth = createBodyGeometry();
    const spiny = createBodyGeometry();
    for (const archetype of TRUNK_ARCHETYPES) {
      const p = params(archetype, { segmentCount: 14, amplitudeScale: 0 });
      buildBody({ ...p, spination: 0 }, smooth);
      buildBody({ ...p, spination: 1 }, spiny);
      expect(spiny.outline.count).toBe(smooth.outline.count);
      const n = spiny.chain.count;
      // Dorsal stations 1..n−1 come first in the outline; odd ones are spikes.
      let spikes = 0;
      for (let i = 1; i < n - 1; i += 1) {
        const moved = Math.hypot(
          (spiny.outline.points[i * 2] ?? 0) - (smooth.outline.points[i * 2] ?? 0),
          (spiny.outline.points[i * 2 + 1] ?? 0) - (smooth.outline.points[i * 2 + 1] ?? 0),
        );
        if (i % 2 === 1) {
          expect(moved, `${archetype} dorsal station ${i}`).toBeGreaterThan(0);
          spikes += 1;
        } else {
          expect(moved, `${archetype} dorsal station ${i}`).toBeCloseTo(0, 12);
        }
      }
      expect(spikes).toBeGreaterThanOrEqual(3);
      // The ventral return pass is the tail of the outline and must be untouched.
      for (let k = n; k < spiny.outline.count; k += 1) {
        expect(spiny.outline.points[k * 2]).toBeCloseTo(smooth.outline.points[k * 2] ?? 0, 12);
        expect(spiny.outline.points[k * 2 + 1]).toBeCloseTo(smooth.outline.points[k * 2 + 1] ?? 0, 12);
      }
    }
  });

  it('costs no extra points, whatever the spination', () => {
    const geometry = createBodyGeometry();
    for (const archetype of CLADE_ARCHETYPES) {
      const baseline = nearVertexCount(archetype, 12, 2);
      for (const spination of [0, 0.3, 1, 5, -2]) {
        buildBody(params(archetype, { segmentCount: 12, finPairs: 2, spination }), geometry);
        expect(geometry.spination).toBeGreaterThanOrEqual(0);
        expect(geometry.spination).toBeLessThanOrEqual(1);
        expect(nearVertexCount(archetype, 12, 2)).toBe(baseline);
      }
    }
  });
});

describe('species patterning', () => {
  it('emits the same marks whatever the family, and only draws the ones that are marks', () => {
    const geometry = createBodyGeometry();
    for (const archetype of CLADE_ARCHETYPES) {
      for (const patternFamily of PATTERN_FAMILIES) {
        buildBody(params(archetype, { patternFamily, segmentCount: 12 }), geometry);
        expect(geometry.patternCount, `${archetype}/${patternFamily}`).toBe(PATTERN_MARKS);
        for (let i = 0; i < geometry.patternCount; i += 1) expect(geometry.patterns[i]?.count).toBe(2);
        if (patternFamily === 'none') expect(geometry.patternWidth).toBe(0);
        else expect(geometry.patternWidth).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every mark inside the silhouette it is painted on', () => {
    // A mark whose centreline left the body would stroke out over open water.
    const geometry = createBodyGeometry();
    for (const archetype of CLADE_ARCHETYPES) {
      const [aspectLow, aspectHigh] = CLADE_SCHEMA[archetype].bodyAspect.renderRange;
      for (const patternFamily of PATTERN_FAMILIES) {
        for (const bodyAspect of [aspectLow, aspectHigh]) {
          for (const headForm of [-1, 0, 1]) {
            for (const patternPhase of [0, 0.5, 1]) {
              for (let phaseStep = 0; phaseStep < 4; phaseStep += 1) {
                buildBody(
                  params(archetype, {
                    segmentCount: 12,
                    bodyAspect,
                    headForm,
                    patternFamily,
                    patternPhase,
                    phase: (phaseStep / 4) * 2 * Math.PI,
                    pulsePhase: phaseStep / 4,
                  }),
                  geometry,
                );
                for (let m = 0; m < geometry.patternCount; m += 1) {
                  const mark = geometry.patterns[m];
                  if (mark === undefined) continue;
                  for (let k = 0; k < mark.count; k += 1) {
                    const x = mark.points[k * 2] ?? 0;
                    const y = mark.points[k * 2 + 1] ?? 0;
                    expect(
                      insidePolygon(geometry.outline, x, y),
                      `${archetype}/${patternFamily} aspect=${bodyAspect} head=${headForm} mark=${m} point=${k}`,
                    ).toBe(true);
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it('moves the marks with the per-slot phase, so schoolmates are not stencils', () => {
    const a = createBodyGeometry();
    const b = createBodyGeometry();
    buildBody(params('undulator', { segmentCount: 20, patternFamily: 'stripes', patternPhase: 0 }), a);
    buildBody(params('undulator', { segmentCount: 20, patternFamily: 'stripes', patternPhase: 1 }), b);
    expect(samePoints(a.patterns[0] as Polyline, b.patterns[0] as Polyline)).toBe(false);
  });
});

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

describe('ontogeny', () => {
  /** Farthest any emitted point of an appendage reaches from the body midline chain. */
  function appendageReach(geometry: BodyGeometry): number {
    let reach = 0;
    const walk = (lines: readonly Polyline[], count: number): void => {
      for (let i = 0; i < count; i += 1) {
        const line = lines[i];
        if (line === undefined) continue;
        for (let p = 0; p < line.count; p += 1) {
          reach = Math.max(reach, Math.hypot(line.points[p * 2] ?? 0, line.points[p * 2 + 1] ?? 0));
        }
      }
    };
    walk(geometry.fins, geometry.finCount);
    walk(geometry.strokes, geometry.strokeCount);
    return reach;
  }

  it('still costs exactly what the near-tier budget bills it for', () => {
    // The budget currency. `nearVertexCount` sees only (archetype, segments,
    // finPairs), so a juvenile that dropped a fin pair would be under-billed at
    // the near tier — and it is the small animals the budget reaches last, so
    // the error would land exactly where it is hardest to see.
    const geometry = createBodyGeometry();
    for (const archetype of CLADE_ARCHETYPES) {
      const schema = CLADE_SCHEMA[archetype];
      const segments = schema.segmentCount.typical;
      const finPairs = Math.max(1, schema.finPairs.typical);
      for (const juvenile of [0, 0.5, 1]) {
        buildBody(params(archetype, { segmentCount: segments, finPairs, juvenile }), geometry);
        let emitted = geometry.outline.count + geometry.mouth.count;
        for (let i = 0; i < geometry.finCount; i += 1) emitted += geometry.fins[i]?.count ?? 0;
        for (let i = 0; i < geometry.plateCount; i += 1) emitted += geometry.plates[i]?.count ?? 0;
        for (let i = 0; i < geometry.strokeCount; i += 1) emitted += geometry.strokes[i]?.count ?? 0;
        for (let i = 0; i < geometry.patternCount; i += 1) emitted += geometry.patterns[i]?.count ?? 0;
        expect(nearVertexCount(archetype, segments, finPairs), `${archetype} juvenile=${juvenile}`).toBe(emitted);
      }
    }
  });

  it('draws an adult identically to the body that had no ontogeny at all', () => {
    // The centring guarantee in geometry: at `juvenile` 0 both scale factors are
    // exactly 1, so an animal at lifeStage 1 is bit-identical to the R5 body.
    const geometry = createBodyGeometry();
    const undulator = createBodyGeometry();
    buildBody(params('undulator', { juvenile: 0, finPairs: 3, amplitudeScale: 0 }), geometry);
    buildBody(params('undulator', { finPairs: 3, amplitudeScale: 0 }), undulator);
    expect(geometry.eyeR).toBe(undulator.eyeR);
    expect(samePoints(geometry.fins[0] as Polyline, undulator.fins[0] as Polyline)).toBe(true);
  });

  it('shortens appendages and enlarges the eye, monotonically', () => {
    const geometry = createBodyGeometry();
    for (const archetype of CLADE_ARCHETYPES) {
      let previousReach = Infinity;
      let previousEye = 0;
      for (const juvenile of [0, 0.25, 0.5, 0.75, 1]) {
        buildBody(params(archetype, { juvenile, finPairs: 3, amplitudeScale: 0 }), geometry);
        const reach = appendageReach(geometry);
        expect(reach).toBeLessThanOrEqual(previousReach + 1e-12);
        expect(geometry.eyeR).toBeGreaterThanOrEqual(previousEye);
        previousReach = reach;
        previousEye = geometry.eyeR;
      }
      // And the treatment is a read, not a rounding difference.
      buildBody(params(archetype, { juvenile: 0, finPairs: 3, amplitudeScale: 0 }), geometry);
      const adultEye = geometry.eyeR;
      buildBody(params(archetype, { juvenile: 1, finPairs: 3, amplitudeScale: 0 }), geometry);
      expect(geometry.eyeR).toBeGreaterThan(adultEye * 1.2);
    }
  });

  it('keeps a juvenile outline simple, which is what the amplification can break', () => {
    const geometry = createBodyGeometry();
    for (const archetype of CLADE_ARCHETYPES) {
      for (const juvenile of [0.5, 1]) {
        buildBody(params(archetype, { juvenile, spination: 1, segmentCount: 14, headForm: 1 }), geometry);
        expect(selfCrossing(geometry.outline)).toBeNull();
      }
    }
  });
});
