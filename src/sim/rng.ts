/**
 * xoshiro128** seeded RNG, ported verbatim from herdloom (`src/sim/rng.ts`).
 * The generator body is unchanged on purpose: it is the one piece of the prior
 * project that was measured to behave, and keeping it byte-comparable means a
 * herdloom-vs-panthalassa stream divergence can only come from call ordering.
 *
 * Everything in `src/sim`, `src/stats` and `src/probes` draws randomness from
 * an instance of this class and nowhere else; ESLint bans the ambient entropy
 * and clock sources outright (see CLAUDE.md). The whole sim must be a pure
 * function of (config, seed).
 */

import type { RngState } from '../contracts/types';

/** The four 32-bit words of xoshiro128** state; serialise this to snapshot. */
export type { RngState };

export class SeededRng {
  private state: RngState;
  private spareNormal: number | undefined;

  constructor(seedOrState: string | RngState) {
    this.state = typeof seedOrState === 'string' ? seedState(seedOrState) : [...seedOrState];
  }

  next(): number {
    const result = rotl(Math.imul(this.state[1], 5), 7) * 9;
    const t = this.state[1] << 9;
    this.state[2] ^= this.state[0];
    this.state[3] ^= this.state[1];
    this.state[1] ^= this.state[2];
    this.state[0] ^= this.state[3];
    this.state[2] ^= t;
    this.state[3] = rotl(this.state[3], 11);
    return (result >>> 0) / 4_294_967_296;
  }

  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new Error('Cannot pick from an empty array.');
    return values[this.int(0, values.length - 1)] as T;
  }

  normal(mean = 0, standardDeviation = 1): number {
    if (this.spareNormal !== undefined) {
      const result = this.spareNormal;
      this.spareNormal = undefined;
      return mean + result * standardDeviation;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const magnitude = Math.sqrt(-2 * Math.log(u));
    const z0 = magnitude * Math.cos(2 * Math.PI * v);
    this.spareNormal = magnitude * Math.sin(2 * Math.PI * v);
    return mean + z0 * standardDeviation;
  }

  poisson(lambda: number): number {
    const threshold = Math.exp(-lambda);
    let count = 0;
    let product = 1;
    do {
      count += 1;
      product *= this.next();
    } while (product > threshold);
    return count - 1;
  }

  getState(): RngState {
    return [...this.state];
  }

  // ---------------------------------------------------------------------
  // Panthalassa additions
  // ---------------------------------------------------------------------

  /**
   * Derive a labelled sub-stream.
   *
   * The child state is a hash of (parent state, label), so:
   *
   * - **Pure**: forking does NOT consume parent entropy. Adding, removing or
   *   reordering `fork` calls cannot shift the parent's stream, so a new
   *   consumer (a stats pass, a debug dump, a god tool) can never perturb the
   *   sim's trajectory. This is the whole point of the helper.
   * - **Deterministic**: the same label from the same parent state always
   *   yields the same sub-stream. To get a *fresh* stream per tick, put the
   *   tick in the label: `rng.fork(`predation:${state.tick}`)`.
   * - **Independent**: different labels decorrelate — each word gets its own
   *   avalanche mix and the stream is advanced 8 draws to escape the seeding
   *   transient that xoshiro shows for low-entropy states.
   *
   * Use this to give each sim stage its own stream, so that a stage which
   * draws a variable number of samples (predation rolls, clutch sizes) cannot
   * desynchronise the stages after it.
   */
  fork(label: string): SeededRng {
    const labelHash = hashString(label);
    const forked: RngState = [
      avalanche(this.state[0] ^ labelHash),
      avalanche(this.state[1] ^ rotl(labelHash, 7)),
      avalanche(this.state[2] ^ rotl(labelHash, 15)),
      avalanche(this.state[3] ^ rotl(labelHash, 23)),
    ];
    if (forked.every((value) => value === 0)) forked[0] = 1;
    const child = new SeededRng(forked);
    // Discard the seeding transient: xoshiro's low bits need a few rounds to
    // mix when neighbouring seeds differ in only a handful of bits.
    for (let index = 0; index < 8; index += 1) child.next();
    return child;
  }

  /** Overwrite the generator state (snapshot restore). Clears the spare normal. */
  setState(state: RngState): void {
    this.state = [...state];
    this.spareNormal = undefined;
  }

  /**
   * A Laplace (double-exponential) draw — the fat tail in the mutation kernel.
   * Kept here rather than in genetics so that every distribution the sim uses
   * consumes the stream through one audited object.
   */
  laplace(mean = 0, scale = 1): number {
    const u = this.next() - 0.5;
    return mean - scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
  }
}

function rotl(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

function avalanche(value: number): number {
  let hash = value >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 2_246_822_507);
  hash = Math.imul(hash ^ (hash >>> 13), 3_266_489_909);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** FNV-ish string hash; shared by `seedState` and `fork`. */
function hashString(text: string): number {
  let hash = 1_779_033_703 ^ text.length;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 3_432_918_353);
    hash = (hash << 13) | (hash >>> 19);
  }
  return hash >>> 0;
}

function seedState(seed: string): RngState {
  let hash = 1_779_033_703 ^ seed.length;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 3_432_918_353);
    hash = (hash << 13) | (hash >>> 19);
  }
  const nextSeed = (): number => {
    hash = Math.imul(hash ^ (hash >>> 16), 2_246_822_507);
    hash = Math.imul(hash ^ (hash >>> 13), 3_266_489_909);
    return (hash ^= hash >>> 16) >>> 0;
  };
  const result: RngState = [nextSeed(), nextSeed(), nextSeed(), nextSeed()];
  if (result.every((value) => value === 0)) result[0] = 1;
  return result;
}
