// End-to-end star toggling through the real thunks against a fake API whose requests
// settle in a chosen order. [why] Reducer-only tests cannot show what the UI ends on
// once every request (including the reconcile fetch) has finished.
import { describe, expect, it } from 'bun:test';
import { configureStore } from '@reduxjs/toolkit';
import reducer, { fetchSwitcherBoardsThunk, toggleStarAndReconcileThunk } from '../boardSwitcher.slice';

interface Deferred { resolve: () => void; reject: (e: Error) => void }

function setup(initialStarred: boolean) {
  const server = { starred: initialStarred };
  const starCalls: Deferred[] = [];
  const hold = (apply: () => void) =>
    new Promise<void>((resolve, reject) => {
      starCalls.push({ resolve: () => { apply(); resolve(); }, reject });
    });
  const api = {
    get: (url: string) =>
      Promise.resolve(
        url === '/workspaces'
          ? { data: [{ id: 'w1', name: 'Phoenix' }] }
          : { data: [{ id: 'b1', title: 'Framework', workspace_id: 'w1', state: 'ACTIVE', isStarred: server.starred }] },
      ),
    post: () => hold(() => { server.starred = true; }),
    delete: () => hold(() => { server.starred = false; }),
  };
  const store = configureStore({
    reducer: { boardSwitcher: reducer },
    middleware: (gDM) => gDM({ thunk: { extraArgument: { api } }, serializableCheck: false }),
  });
  // [why] The thunks are typed against the app RootState; this store only has the slice they read.
  const dispatch = store.dispatch as unknown as (action: unknown) => Promise<unknown>;
  const starred = () => store.getState().boardSwitcher.boards[0]?.isStarred;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { server, starCalls, dispatch, starred, flush };
}

describe('boardSwitcher star toggles end on server state', () => {
  it('star, unstar, star — last two fail, first succeeds last', async () => {
    const { server, starCalls, dispatch, starred, flush } = setup(false);
    await dispatch(fetchSwitcherBoardsThunk());

    const done = [
      dispatch(toggleStarAndReconcileThunk({ boardId: 'b1', starred: true })),
      dispatch(toggleStarAndReconcileThunk({ boardId: 'b1', starred: false })),
      dispatch(toggleStarAndReconcileThunk({ boardId: 'b1', starred: true })),
    ];
    await flush();
    starCalls[1]?.reject(new Error('unstar failed'));
    starCalls[2]?.reject(new Error('star failed'));
    await flush();
    starCalls[0]?.resolve();
    await Promise.all(done);
    await flush();

    expect(server.starred).toBe(true);
    expect(starred()).toBe(true);
  });

  it('overlapping successes applied by the server out of order', async () => {
    const { server, starCalls, dispatch, starred, flush } = setup(false);
    await dispatch(fetchSwitcherBoardsThunk());

    const done = [
      dispatch(toggleStarAndReconcileThunk({ boardId: 'b1', starred: true })),
      dispatch(toggleStarAndReconcileThunk({ boardId: 'b1', starred: false })),
    ];
    await flush();
    starCalls[1]?.resolve(); // server applies the unstar first…
    starCalls[0]?.resolve(); // …then the star
    await Promise.all(done);
    await flush();

    expect(server.starred).toBe(true);
    expect(starred()).toBe(true);
  });

  it('a single successful toggle needs no reconcile', async () => {
    const { starCalls, dispatch, starred, flush } = setup(false);
    await dispatch(fetchSwitcherBoardsThunk());
    const done = dispatch(toggleStarAndReconcileThunk({ boardId: 'b1', starred: true }));
    await flush();
    starCalls[0]?.resolve();
    await done;
    expect(starred()).toBe(true);
  });
});
