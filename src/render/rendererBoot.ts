/**
 * Renderer boot policy (R1). No Pixi, no DOM, no imports — so the one piece of
 * the shell that has to survive a graphics stack behaving badly can be tested
 * in node against fakes that hang, throw, or succeed on the second try.
 *
 * The failure this exists for: `Application.init` requesting a WebGPU adapter
 * that never answers. It does not reject and it does not resolve, so every
 * ordinary error path — try/catch, `.catch()`, a rejected promise — is dead
 * code against it. A promise that never settles can only be escaped by racing
 * something that does.
 *
 * Nothing here can cancel the work it abandons; that is not possible for a
 * promise. It stops *waiting* on it and hands the caller a way to release the
 * resources it was holding.
 */

export type BootOutcome = 'ok' | 'timeout' | 'failed';

export interface BootAttempt {
  /** Renderer backends to offer, most preferred first. */
  readonly preference: readonly string[];
  /** Recorded on the result so the caller can say which attempt won. */
  readonly label: string;
}

export interface Bootable<H> {
  /**
   * Construct the handle synchronously and start initialising it. The split
   * matters: a handle that only appears when initialisation *finishes* cannot
   * be torn down when initialisation never finishes.
   */
  begin(preference: readonly string[]): { handle: H; ready: Promise<unknown> };
  /** Release a handle whose `ready` may still be pending forever. */
  abandon(handle: H): void;
}

export interface BootResult<H> {
  readonly handle: H;
  readonly label: string;
  /** 1 for the first attempt; higher means an earlier backend had to be given up on. */
  readonly attempt: number;
}

/**
 * Wait for `ready`, but never longer than `timeoutMs`.
 *
 * `ready` is wrapped before the race so that a rejection arriving after the
 * timeout is already handled — an abandoned attempt that fails later must not
 * surface as an unhandled rejection and take the page down by another route.
 * The timer is always cleared, so a caller that resolves quickly does not keep
 * the process (or a test runner) alive waiting for it.
 */
export async function settleWithin(ready: Promise<unknown>, timeoutMs: number): Promise<BootOutcome> {
  const guarded: Promise<BootOutcome> = ready.then(
    () => 'ok',
    () => 'failed',
  );
  if (timeoutMs <= 0) return guarded;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<BootOutcome>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, timeoutMs);
  });
  try {
    return await Promise.race([guarded, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Try each attempt in order, giving every one the same deadline, and return the
 * first that comes up. An attempt that times out or fails is abandoned before
 * the next is started, so two graphics contexts are never live at once.
 *
 * Returns null when every attempt is exhausted — the caller decides what a
 * world with no GPU renderer should look like.
 */
export async function bootRenderer<H>(
  attempts: readonly BootAttempt[],
  bootable: Bootable<H>,
  timeoutMs: number,
  onAttemptFailed?: (attempt: BootAttempt, outcome: BootOutcome) => void,
): Promise<BootResult<H> | null> {
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    if (attempt === undefined) continue;

    let started: { handle: H; ready: Promise<unknown> };
    try {
      started = bootable.begin(attempt.preference);
    } catch {
      onAttemptFailed?.(attempt, 'failed');
      continue;
    }

    const outcome = await settleWithin(started.ready, timeoutMs);
    if (outcome === 'ok') return { handle: started.handle, label: attempt.label, attempt: index + 1 };

    onAttemptFailed?.(attempt, outcome);
    try {
      bootable.abandon(started.handle);
    } catch {
      // A half-built handle can fail to tear down; that must not stop the next
      // attempt, which is the whole point of having one.
    }
  }
  return null;
}
