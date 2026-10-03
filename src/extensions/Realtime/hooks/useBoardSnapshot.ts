import { useCallback, useEffect, useRef } from 'react';

export type SnapshotRequest = Promise<unknown> & { abort: () => void };

/** Coalesce polling and recovery without dropping a refresh during an in-flight request. */
export function useBoardSnapshot({ boardId, fetchSnapshot, shouldRetry }: {
  boardId: string | undefined;
  fetchSnapshot: () => SnapshotRequest;
  shouldRetry?: (result: unknown) => boolean;
}) {
  const requestRef = useRef<SnapshotRequest | null>(null);
  const pendingRef = useRef(false);
  const fetchRef = useRef(fetchSnapshot);
  fetchRef.current = fetchSnapshot;
  const boardRef = useRef(boardId);
  boardRef.current = boardId;
  const retryRef = useRef(shouldRetry);
  retryRef.current = shouldRetry;
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshBoard = useCallback(async function refresh() {
    if (!boardId || boardRef.current !== boardId) return;
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (requestRef.current) {
      pendingRef.current = true;
      return;
    }
    const request = fetchRef.current();
    requestRef.current = request;
    try {
      const result = await request;
      if (requestRef.current === request && retryRef.current?.(result)) {
        // [why] Keep eventual recovery while bounding retry cadence and concurrency.
        retryTimerRef.current = setTimeout(() => { void refresh(); }, 5_000);
      }
    } finally {
      if (requestRef.current === request) {
        requestRef.current = null;
        if (pendingRef.current) {
          pendingRef.current = false;
          if (retryTimerRef.current === null) await refresh();
        }
      }
    }
  }, [boardId]);

  useEffect(() => {
    boardRef.current = boardId;
    return () => {
      boardRef.current = undefined;
      requestRef.current?.abort();
      requestRef.current = null;
      pendingRef.current = false;
      if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    };
  }, [boardId]);

  return refreshBoard;
}
