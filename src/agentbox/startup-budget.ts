/**
 * The one time allowance shared by everything an AgentBox does before it listens.
 *
 * 🔴 A TOTAL, NOT A PER-STEP ALLOWANCE — and that distinction is the reason this module
 * exists rather than a `setTimeout` at each call site.
 *
 * Every pre-listen step (settings, resource bundles, the tool whitelist) is a round trip to
 * the Runtime, and they all happen at once precisely when the Runtime is least able to
 * answer: a rolling deploy, where it is restarting while every box of every agent asks it
 * for the same things. The deadline used to be applied per step — three sequential steps at
 * 30s each — so the worst case was 90s of silence before `listen()`.
 *
 * The box's `startupProbe` allows periodSeconds × failureThreshold = 60s from CONTAINER
 * start, and the pod runs `restartPolicy: Never`. Past 60s kubelet does not retry the
 * container; it kills the pod into phase `Failed`. The Runtime then collects it as a crashed
 * box, refills the pool slot, and the replacement queues behind the same slow gateway. So a
 * per-step budget turned a slow Runtime into an agent that could not hold a box at all.
 *
 * Losing a sync is recoverable: the next push installs it, and the tool whitelist stays
 * fail-closed until then. Losing the pod is not. The budget must therefore stay comfortably
 * under the startup-probe window, with room for node startup and module loading on top.
 */

/**
 * The total allowance for all pre-listen gateway work.
 *
 * Must stay comfortably under the startup-probe window described above — node startup and
 * module loading sit on top of it, uncounted. `startup-probe-window.test.ts` asserts the
 * relation against the probe configuration the spawner actually emits, so this number
 * cannot drift into the window unnoticed.
 */
export const STARTUP_BUDGET_MS = 30_000;

/** A countdown shared across steps. Injectable clock so the contract is testable. */
export interface StartupBudget {
  /** Milliseconds left, floored at 0. */
  remainingMs(): number;
  /** Whether the budget is used up, i.e. remaining work should be skipped. */
  isSpent(): boolean;
  /** The total this budget started with — for log lines that need to name it. */
  readonly totalMs: number;
}

export function startStartupBudget(totalMs: number, now: () => number = Date.now): StartupBudget {
  const endsAt = now() + totalMs;
  return {
    totalMs,
    remainingMs: () => Math.max(0, endsAt - now()),
    isSpent: () => endsAt - now() <= 0,
  };
}

/**
 * A budget that never runs out, for callers with no pod to lose (local mode, tests).
 *
 * Not the same as a zero budget: unlimited means "run the work", spent means "skip it".
 * Conflating the two would have a missing budget silently disable every startup sync.
 */
export function unlimitedStartupBudget(): StartupBudget {
  return {
    totalMs: Number.POSITIVE_INFINITY,
    remainingMs: () => Number.POSITIVE_INFINITY,
    isSpent: () => false,
  };
}

/**
 * Run one startup step against the shared budget, giving up loudly rather than delaying
 * `listen()`.
 *
 * Returns undefined — never throws — when the step fails, times out, or is skipped because
 * an earlier step already spent the budget. Every caller's fallback is the same: come up
 * without it and take it on the next push.
 */
export async function runWithinBudget<T>(
  budget: StartupBudget,
  label: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  if (budget.isSpent()) {
    console.warn(
      `[agentbox] startup: skipping ${label} — the ${budget.totalMs}ms startup budget is spent; it will arrive on the next push`,
    );
    return undefined;
  }

  const remaining = budget.remainingMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // An unlimited budget must not arm a timer at all: setTimeout coerces anything past
    // 2^31-1 ms back into a near-immediate fire, which would abort the work instantly —
    // the exact opposite of "no deadline".
    if (!Number.isFinite(remaining)) return await work();
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${Math.round(remaining)}ms of the shared startup budget`)),
          remaining,
        );
      }),
    ]);
  } catch (err) {
    console.warn(
      `[agentbox] startup: ${label} did not finish (${err instanceof Error ? err.message : String(err)}); continuing without it`,
    );
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
