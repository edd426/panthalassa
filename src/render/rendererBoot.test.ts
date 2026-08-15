import { describe, expect, it } from 'vitest';
import { bootRenderer, settleWithin } from './rendererBoot';
import type { BootAttempt, BootOutcome, Bootable } from './rendererBoot';

const ATTEMPTS: readonly BootAttempt[] = [
  { preference: ['webgpu', 'webgl'], label: 'webgpu-then-webgl' },
  { preference: ['webgl'], label: 'webgl-only' },
];

/** Timeouts are real but tiny; the policy has no notion of how long a tick is. */
const TIMEOUT_MS = 25;

type Behaviour = 'ok' | 'throw' | 'reject' | 'hang' | 'reject-late';

interface FakeApp {
  readonly preference: readonly string[];
  abandoned: boolean;
}

/**
 * A graphics stack that misbehaves to order. `hang` is the one that matters:
 * a promise that never settles, which is what a WebGPU adapter request does
 * when it goes wrong and what every ordinary error path fails to catch.
 */
function fakeStack(behaviours: readonly Behaviour[]) {
  const started: FakeApp[] = [];
  let index = 0;
  const bootable: Bootable<FakeApp> = {
    begin(preference) {
      const behaviour = behaviours[index] ?? 'ok';
      index += 1;
      if (behaviour === 'throw') throw new Error('construction exploded');
      const handle: FakeApp = { preference, abandoned: false };
      started.push(handle);
      let ready: Promise<unknown>;
      if (behaviour === 'hang') ready = new Promise(() => {});
      else if (behaviour === 'reject') ready = Promise.reject(new Error('init failed'));
      else if (behaviour === 'reject-late')
        ready = new Promise((_resolve, reject) => setTimeout(() => { reject(new Error('late')); }, TIMEOUT_MS * 3));
      else ready = Promise.resolve();
      return { handle, ready };
    },
    abandon(handle) {
      handle.abandoned = true;
    },
  };
  return { bootable, started };
}

describe('settleWithin', () => {
  it('reports ok, failed and timeout distinctly', async () => {
    expect(await settleWithin(Promise.resolve(), TIMEOUT_MS)).toBe<BootOutcome>('ok');
    expect(await settleWithin(Promise.reject(new Error('no')), TIMEOUT_MS)).toBe<BootOutcome>('failed');
    expect(await settleWithin(new Promise(() => {}), TIMEOUT_MS)).toBe<BootOutcome>('timeout');
  });

  it('escapes a promise that never settles', async () => {
    const started = Date.now();
    expect(await settleWithin(new Promise(() => {}), TIMEOUT_MS)).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 20);
  });

  it('swallows a rejection that lands after the deadline', async () => {
    // An abandoned attempt failing later must not become an unhandled
    // rejection — that would take the page down by a second route.
    const late = new Promise((_resolve, reject) => setTimeout(() => { reject(new Error('late')); }, TIMEOUT_MS * 2));
    expect(await settleWithin(late, TIMEOUT_MS)).toBe('timeout');
    await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS * 4));
  });

  it('waits indefinitely when given no deadline', async () => {
    expect(await settleWithin(Promise.resolve(), 0)).toBe('ok');
  });
});

describe('bootRenderer', () => {
  it('takes the first backend when it comes up', async () => {
    const { bootable, started } = fakeStack(['ok']);
    const result = await bootRenderer(ATTEMPTS, bootable, TIMEOUT_MS);
    expect(result?.label).toBe('webgpu-then-webgl');
    expect(result?.attempt).toBe(1);
    expect(started).toHaveLength(1);
    expect(started[0]?.abandoned).toBe(false);
  });

  it('falls through to WebGL when WebGPU hangs, and tears the stall down', async () => {
    // The production bug, exactly: init neither resolves nor rejects.
    const { bootable, started } = fakeStack(['hang', 'ok']);
    const result = await bootRenderer(ATTEMPTS, bootable, TIMEOUT_MS);

    expect(result?.label).toBe('webgl-only');
    expect(result?.attempt).toBe(2);
    expect(result?.handle.preference).toEqual(['webgl']);
    // The abandoned attempt must be released before the next one starts, so
    // two graphics contexts are never live at once.
    expect(started[0]?.abandoned).toBe(true);
    expect(started[1]?.abandoned).toBe(false);
  });

  it('falls through on a rejection as well as a hang', async () => {
    const { bootable } = fakeStack(['reject', 'ok']);
    expect((await bootRenderer(ATTEMPTS, bootable, TIMEOUT_MS))?.attempt).toBe(2);
  });

  it('falls through when construction itself throws', async () => {
    const { bootable, started } = fakeStack(['throw', 'ok']);
    const result = await bootRenderer(ATTEMPTS, bootable, TIMEOUT_MS);
    expect(result?.label).toBe('webgl-only');
    // Nothing was constructed for the failed attempt, so nothing to abandon.
    expect(started).toHaveLength(1);
  });

  it('returns null when every backend is exhausted, without hanging', async () => {
    const started = Date.now();
    const { bootable } = fakeStack(['hang', 'hang']);
    expect(await bootRenderer(ATTEMPTS, bootable, TIMEOUT_MS)).toBeNull();
    // Bounded by the number of attempts, so the caller always gets an answer.
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 40);
  });

  it('reports every failed attempt to the caller', async () => {
    const seen: { label: string; outcome: BootOutcome }[] = [];
    const { bootable } = fakeStack(['hang', 'reject']);
    await bootRenderer(ATTEMPTS, bootable, TIMEOUT_MS, (attempt, outcome) => {
      seen.push({ label: attempt.label, outcome });
    });
    expect(seen).toEqual([
      { label: 'webgpu-then-webgl', outcome: 'timeout' },
      { label: 'webgl-only', outcome: 'failed' },
    ]);
  });

  it('survives a teardown that throws', async () => {
    const { bootable } = fakeStack(['hang', 'ok']);
    const brittle: Bootable<FakeApp> = {
      begin: (preference) => bootable.begin(preference),
      abandon: () => {
        throw new Error('half-built renderer cannot be destroyed');
      },
    };
    expect((await bootRenderer(ATTEMPTS, brittle, TIMEOUT_MS))?.attempt).toBe(2);
  });

  it('does not start a later attempt once one has succeeded', async () => {
    const { bootable, started } = fakeStack(['ok', 'ok']);
    await bootRenderer(ATTEMPTS, bootable, TIMEOUT_MS);
    expect(started).toHaveLength(1);
  });

  it('gives up cleanly when handed no attempts at all', async () => {
    const { bootable } = fakeStack([]);
    expect(await bootRenderer([], bootable, TIMEOUT_MS)).toBeNull();
  });
});
