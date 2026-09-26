/** A small typed event emitter that works in Node and browsers. */
export type EventMap = Record<string, unknown[]>;
export type Listener<A extends unknown[]> = (...args: A) => void;
type AnyListener = (...args: unknown[]) => void;

export class TypedEmitter<E extends EventMap> {
  #listeners = new Map<keyof E, Set<AnyListener>>();

  /** Adds a listener; returns a function that removes it. */
  on<K extends keyof E>(event: K, listener: Listener<E[K]>): () => void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(listener as unknown as AnyListener);
    return () => this.off(event, listener);
  }

  once<K extends keyof E>(event: K, listener: Listener<E[K]>): () => void {
    const off = this.on(event, ((...args: E[K]) => {
      off();
      listener(...args);
    }));
    return off;
  }

  off<K extends keyof E>(event: K, listener: Listener<E[K]>): void {
    this.#listeners.get(event)?.delete(listener as unknown as AnyListener);
  }

  removeAllListeners(event?: keyof E): void {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
  }

  listenerCount(event: keyof E): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  /** Calls listeners synchronously. A throwing listener does not stop the others. */
  protected emit<K extends keyof E>(event: K, ...args: E[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const l of [...set]) {
      try {
        (l as unknown as Listener<E[K]>)(...args);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }
}
