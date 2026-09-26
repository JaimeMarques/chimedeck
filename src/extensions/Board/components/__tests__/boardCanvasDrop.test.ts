import { describe, expect, it } from 'bun:test';
import { resolveCardDropDestination } from '../BoardCanvas';

// Lane "B" cards with viewport mid-Ys; active card already excluded.
const mids: Record<string, number> = { b1: 100, b2: 200, b3: 300 };
const getMid = (id: string) => mids[id] ?? null;
const lane = ['b1', 'b2', 'b3'];
// Previous frame's cache: pointer was still in lane "A" at index 2.
const stale = { listId: 'A', index: 2 };

describe('resolveCardDropDestination', () => {
  it('commits a fallback lane drop to the final lane, not the stale cached one', () => {
    expect(resolveCardDropDestination(stale, 'B', lane, 250, getMid)).toEqual({ listId: 'B', index: 2 });
    expect(resolveCardDropDestination(stale, 'B', lane, 50, getMid)).toEqual({ listId: 'B', index: 0 });
    expect(resolveCardDropDestination(stale, 'B', lane, 900, getMid)).toEqual({ listId: 'B', index: 3 });
    // 1px midpoint tolerance: at mid - 1 the card counts as passed, at mid - 2 it does not.
    expect(resolveCardDropDestination(stale, 'B', lane, 199, getMid).index).toBe(2);
    expect(resolveCardDropDestination(stale, 'B', lane, 198, getMid).index).toBe(1);
  });

  it('appends into an empty lane or when the pointer Y is unknown', () => {
    expect(resolveCardDropDestination(stale, 'B', [], 250, getMid)).toEqual({ listId: 'B', index: 0 });
    expect(resolveCardDropDestination(stale, 'B', lane, null, getMid)).toEqual({ listId: 'B', index: 3 });
  });

  it('keeps the existing destination when there is no fallback lane (over != null / keyboard)', () => {
    expect(resolveCardDropDestination(stale, null, lane, 250, getMid)).toBe(stale);
  });
});
