import type { Page } from "./types.js";

export interface IterateOptions {
  /** Stop after this many items in total. */
  maxItems?: number;
}

/**
 * Walks a cursor-paginated listing, yielding items one by one and fetching the next page
 * lazily. Stops on the last page (`has_more: false` or no `next_cursor`).
 */
export async function* paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  startCursor?: string | null,
  opts: IterateOptions = {},
): AsyncGenerator<T, void, undefined> {
  let cursor: string | undefined = startCursor ?? undefined;
  let yielded = 0;
  const max = opts.maxItems ?? Infinity;
  const seen = new Set<string>();
  for (;;) {
    const page = await fetchPage(cursor);
    for (const item of page.items) {
      if (yielded >= max) return;
      yield item;
      yielded++;
    }
    if (!page.has_more || !page.next_cursor) return;
    if (seen.has(page.next_cursor)) return; // defensive: a repeated cursor would loop forever
    seen.add(page.next_cursor);
    cursor = page.next_cursor;
  }
}
