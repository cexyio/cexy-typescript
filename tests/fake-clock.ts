import type { WsClock } from "../src/index.js";

/** A manual clock for tests: timers run only when `advance()` passes their due time. */
export class FakeClock implements WsClock {
  #now = 0;
  #seq = 0;
  #timers = new Map<number, { due: number; fn: () => void }>();

  now(): number {
    return this.#now;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#timers.set(id, { due: this.#now + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }
  /** Moves time forward, running due timers in order (timers they schedule run too if due). */
  advance(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      let next: [number, { due: number; fn: () => void }] | undefined;
      for (const e of this.#timers) if (e[1].due <= end && (!next || e[1].due < next[1].due)) next = e;
      if (!next) break;
      this.#timers.delete(next[0]);
      this.#now = next[1].due;
      next[1].fn();
    }
    this.#now = end;
  }
}
