/**
 * Coalesced runs an operation that must not overlap itself, such as the flush of a batch processor
 * that returns at once from a flush that overlaps another.
 *
 * A caller that finds nothing running starts a run. A caller that arrives while one is under way
 * shares, with every other such caller, one follow-up run that starts when the run under way ends.
 * The follow-up begins after the caller arrived, so it covers whatever the caller did before
 * calling. A caller waits for the rest of one run and one whole run more, never longer, and however
 * many callers arrive, at most one run is under way and one is waiting to start.
 */

interface FollowUp {
  readonly promise: Promise<void>;
  /** Settles promise as next settles. */
  start(next: Promise<void>): void;
}

function followUp(): FollowUp {
  let start: (next: Promise<void>) => void = () => {};
  const promise = new Promise<void>((resolve) => {
    start = resolve;
  });
  return { promise, start };
}

export class Coalesced {
  private readonly operation: () => Promise<void>;
  // The run under way, if any. It stays set from the first run to the end of the last follow-up:
  // the end of one run and the start of its follow-up are one step, with no gap a caller could
  // start a second run in.
  private current: Promise<void> | undefined;
  private waiting: FollowUp | undefined;

  constructor(operation: () => Promise<void>) {
    this.operation = operation;
  }

  /**
   * Resolves or rejects as the run that serves this caller does: a run started now when nothing is
   * running, otherwise the follow-up shared with the other callers that are waiting.
   */
  run(): Promise<void> {
    if (this.current === undefined) return this.begin();
    this.waiting ??= followUp();
    return this.waiting.promise;
  }

  /** Resolves, and never rejects, once nothing is running and nothing is waiting to run. */
  async idle(): Promise<void> {
    for (let run = this.current; run !== undefined; run = this.current) {
      await run.then(
        () => undefined,
        () => undefined,
      );
      // The end of a run clears it or puts its follow-up in its place before anyone waiting here
      // wakes. Were it ever still in place, waiting on it again would spin without yielding.
      if (this.current === run) return;
    }
  }

  private begin(): Promise<void> {
    let run: Promise<void>;
    try {
      run = this.operation();
    } catch (err) {
      run = Promise.reject(err);
    }
    this.current = run;
    const ended = (): void => {
      const waiting = this.waiting;
      this.waiting = undefined;
      if (waiting === undefined) {
        // Only the run that is still the current one clears it.
        if (this.current === run) this.current = undefined;
        return;
      }
      // Callers arrived meanwhile. Their follow-up starts here, in the step that ends this run.
      waiting.start(this.begin());
    };
    run.then(ended, ended);
    return run;
  }
}
