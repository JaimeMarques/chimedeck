// Board switcher slice — all active boards across the user's workspaces plus the
// switcher's UI prefs. [why] Prefs live in Redux because the bottom bar (BoardPage)
// and the pinned panel (AppShell) must share them; AppShell persists them.
import { createSlice, isAnyOf, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '~/store';
import { createAppAsyncThunk } from '~/utils/redux';
import type { apiClient } from '~/common/api/client';
import { listWorkspaces } from '../Workspace/api';
import { listBoards, createBoard, starBoard, unstarBoard, type Board } from '../Board/api';
import { clearAuth, loginThunk, logoutThunk, setCredentials, signupThunk } from '../Auth/duck/authDuck';
import {
  archiveBoardThunk,
  boardRemovedByRealtime,
  createBoardThunk,
  deleteBoardThunk,
  duplicateBoardThunk,
  starBoardThunk,
  unstarBoardThunk,
} from '../Board/containers/BoardListPage/BoardListPage.duck';
import { deleteBoardOptimisticThunk } from '../Board/slices/boardsSlice';
import { fetchBoardDataThunk } from '../Board/slices/boardSlice';
import { boardStarSet } from '../Board/boardStarEvents';
import type { WorkspaceFilter } from './helpers';

export const PREFS_STORAGE_KEY = 'board_switcher_prefs';

export interface BoardSwitcherPrefs {
  pinned: boolean;
  pinnedOpen: boolean;
  workspaceFilter: WorkspaceFilter;
  layout: 'grid' | 'list';
  boardsCollapsed: boolean;
}

/** A board's star toggles: the latest one, how many are unsettled, and when the
 *  board's star last changed (pending or settle), on the slice's seq clock. */
interface StarMutation {
  latestId: string;
  /** isStarred before the latest toggle — its rollback target. */
  prev: boolean;
  desired: boolean;
  /** Unsettled toggles, by requestId. [why] A completion not listed here was started
   *  before a session reset (same board ID, other account) and must not touch counts. */
  pendingIds: string[];
  touchedAt: number;
  /** Toggles in the current burst (since pendingIds was last empty), and whether any failed. */
  burstSize: number;
  burstFailed: boolean;
}

/** [why] Latest-wins is only a guess once toggles overlapped (the server may apply them
 *  in another order) or one failed, so re-read the server once the burst has settled. */
export const starNeedsReconcile = (m: StarMutation | undefined): boolean =>
  m !== undefined && m.pendingIds.length === 0 && (m.burstFailed || m.burstSize > 1);

interface BoardSwitcherState {
  boards: Board[];
  status: 'idle' | 'loading' | 'error';
  /** The newest settled fetch failed (status shows it once nothing is in flight). */
  loadFailed: boolean;
  /** Some (not all) workspaces failed to load on the last applied fetch. */
  incomplete: boolean;
  prefs: BoardSwitcherPrefs;
  /** Monotonic event counter ordering fetches against star toggles. */
  seq: number;
  /** seq at which each in-flight fetch started, by requestId. */
  fetchStartedAt: Record<string, number>;
  /** Start seq of the newest fetch whose result was applied. [why] An older fetch that
   *  lands later must not replace newer data or flag an error over it. */
  appliedFetchAt: number;
  /** [why] A fetch that overlaps a board's toggle may carry the old isStarred, so that
   *  board keeps its in-state value; only the latest toggle may roll back. */
  starMutations: Record<string, StarMutation>;
  /** seq at which each in-flight open-board fetch (BoardPage) started, by requestId.
   *  [why] Its isStarred is server truth for that board unless a toggle overlapped it. */
  boardFetchAt: Record<string, number>;
  /** Start seq of the newest accepted server read of each board's isStarred, from either the
   *  switcher list fetch or the open-board fetch. [why] The two race: an older read of one kind
   *  landing after a newer read of the other must not revert the star. */
  starReadAt: Record<string, number>;
  /** Bumped on every session reset, so async work can tell it outlived its session. */
  session: number;
  /** requestId of the create in flight this session. [why] In the slice, not the component:
   *  closing and reopening the switcher must not allow a second concurrent create. */
  creatingId: string | null;
  /** Local board writes (null = removed) made while a fetch was in flight, with their seq.
   *  [why] A fetch that started before the write must not resurrect, drop or revert it. */
  boardEdits: Record<string, { at: number; board: Board | null }>;
  /** requestIds of other features' board mutations started this session. [why] One from a
   *  previous account settling late must not star or insert boards into the next one's list. */
  externalIds: string[];
}

const DEFAULT_PREFS: BoardSwitcherPrefs = {
  pinned: false,
  pinnedOpen: true,
  workspaceFilter: 'all',
  layout: 'grid',
  boardsCollapsed: false,
};

function loadPrefs(): BoardSwitcherPrefs {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREFS_STORAGE_KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return DEFAULT_PREFS;
    const p = parsed as Partial<BoardSwitcherPrefs>;
    // [why] Shape-check each field so a stale or foreign value cannot poison state.
    return {
      pinned: typeof p.pinned === 'boolean' ? p.pinned : DEFAULT_PREFS.pinned,
      pinnedOpen: typeof p.pinnedOpen === 'boolean' ? p.pinnedOpen : DEFAULT_PREFS.pinnedOpen,
      workspaceFilter: typeof p.workspaceFilter === 'string' ? p.workspaceFilter : DEFAULT_PREFS.workspaceFilter,
      layout: p.layout === 'list' ? 'list' : 'grid',
      boardsCollapsed: typeof p.boardsCollapsed === 'boolean' ? p.boardsCollapsed : DEFAULT_PREFS.boardsCollapsed,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

const initialState: BoardSwitcherState = {
  boards: [],
  status: 'idle',
  loadFailed: false,
  incomplete: false,
  prefs: loadPrefs(),
  seq: 0,
  fetchStartedAt: {},
  appliedFetchAt: 0,
  starMutations: {},
  boardFetchAt: {},
  starReadAt: {},
  session: 0,
  creatingId: null,
  boardEdits: {},
  externalIds: [],
};

// ---------- Thunks ----------

// [why] createAppAsyncThunk does not type `extra`; narrow it here instead of per call.
const apiOf = (extra: unknown) => (extra as { api: typeof apiClient }).api;

export const fetchSwitcherBoardsThunk = createAppAsyncThunk(
  'boardSwitcher/fetchBoards',
  async (_, { extra }) => {
    const api = apiOf(extra);
    const { data: workspaces } = await listWorkspaces({ api });
    // [why] allSettled: a forbidden/guest workspace must not blank the others.
    const results = await Promise.allSettled(
      workspaces.map((w) => listBoards({ api, workspaceId: w.id })),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    // [why] Every workspace failing is an outage, not "no boards": surface it as an error.
    if (failed > 0 && failed === results.length) throw new Error('Could not load boards');
    // [why] The list endpoint returns raw rows (workspace_id), so stamp the camelCase
    // workspaceId the filter chips and setActiveWorkspace rely on.
    const boards = results
      .flatMap((r, i) =>
        r.status === 'fulfilled' ? r.value.data.map((b) => ({ ...b, workspaceId: workspaces[i]?.id ?? b.workspaceId })) : [],
      )
      .filter((b) => b.state === 'ACTIVE');
    return { boards, incomplete: failed > 0 };
  },
);

export const toggleSwitcherStarThunk = createAppAsyncThunk(
  'boardSwitcher/toggleStar',
  // `prev`: the caller's current value, the rollback target when the board is not cached.
  async ({ boardId, starred }: { boardId: string; starred: boolean; prev?: boolean }, { extra }) => {
    if (starred) await starBoard({ api: apiOf(extra), boardId });
    else await unstarBoard({ api: apiOf(extra), boardId });
  },
);

/** Star toggle every star control dispatches: toggles, then re-reads the server when the
 *  burst it ends was ambiguous (see starNeedsReconcile). Announces the resolved value at each
 *  step (boardStarSet) so the board list follows. Returns whether this toggle succeeded. */
export const toggleStarAndReconcileThunk = createAppAsyncThunk(
  'boardSwitcher/toggleStarAndReconcile',
  async (arg: { boardId: string; starred: boolean; prev?: boolean }, { dispatch, getState }) => {
    const announce = (cachedOnly = false) => {
      const s = getState().boardSwitcher;
      const board = s.boards.find((b) => b.id === arg.boardId);
      const isStarred = board ? board.isStarred === true : cachedOnly ? undefined : s.starMutations[arg.boardId]?.desired;
      if (isStarred !== undefined) dispatch(boardStarSet({ boardId: arg.boardId, isStarred }));
    };
    const toggle = dispatch(toggleSwitcherStarThunk(arg)); // pending has run: optimistic value
    announce();
    const ok = toggleSwitcherStarThunk.fulfilled.match(await toggle);
    announce();
    if (starNeedsReconcile(getState().boardSwitcher.starMutations[arg.boardId])) {
      await dispatch(fetchSwitcherBoardsThunk());
      announce(true); // only a cached board was re-read
    }
    return ok;
  },
);

export const createSwitcherBoardThunk = createAppAsyncThunk(
  'boardSwitcher/createBoard',
  async ({ workspaceId, title }: { workspaceId: string; title: string }, { extra, getState, dispatch }) => {
    const session = getState().boardSwitcher.session;
    const res = await createBoard({ api: apiOf(extra), workspaceId, title });
    // [why] Refresh here, not in the component: the switcher that started the create may be
    // closed by now, and the new board must still show. Skipped after an account change.
    if (getState().boardSwitcher.session === session) void dispatch(fetchSwitcherBoardsThunk());
    return res.data;
  },
  // [why] Synchronous, so a second submit in the same tick is refused before any POST.
  { condition: (_, { getState }) => getState().boardSwitcher.creatingId === null },
);

// ---------- Slice ----------

function setStarred(state: BoardSwitcherState, boardId: string, starred: boolean) {
  const board = state.boards.find((b) => b.id === boardId);
  if (board) board.isStarred = starred;
}

const omitKey = <T>(record: Record<string, T>, key: string) =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

/** Drops a settled fetch and returns its start seq, or null for an untracked one
 *  (started before a session reset), whose result must be ignored. */
function forgetFetch(state: BoardSwitcherState, requestId: string): number | null {
  const startedAt = state.fetchStartedAt[requestId];
  if (startedAt === undefined) return null;
  state.fetchStartedAt = omitKey(state.fetchStartedAt, requestId);
  return startedAt;
}

function settleStatus(state: BoardSwitcherState) {
  if (Object.keys(state.fetchStartedAt).length > 0) state.status = 'loading';
  else {
    state.status = state.loadFailed ? 'error' : 'idle';
    // Every later fetch starts after these edits, so none of them can be overtaken.
    state.boardEdits = {};
  }
}

/** Writes (or with null removes) one board, remembering the write while a fetch is in flight. */
function writeBoard(state: BoardSwitcherState, id: string, board: Board | null) {
  const i = state.boards.findIndex((b) => b.id === id);
  if (board === null) {
    if (i >= 0) state.boards.splice(i, 1);
  } else if (i >= 0) state.boards[i] = board;
  else state.boards.push(board);
  if (Object.keys(state.fetchStartedAt).length > 0) state.boardEdits[id] = { at: ++state.seq, board };
}

/** A board another feature created, duplicated or (un)archived: add it while ACTIVE, drop it otherwise. */
function upsertExternal(state: BoardSwitcherState, board: Board, workspaceId: string | undefined) {
  if (board.state !== 'ACTIVE') {
    writeBoard(state, board.id, null);
    return;
  }
  if (state.boards.some((b) => b.id === board.id)) return;
  // [why] Same stamping as fetchSwitcherBoardsThunk: raw rows carry workspace_id, not workspaceId.
  const raw = (board as Board & { workspace_id?: string }).workspace_id;
  writeBoard(state, board.id, { ...board, workspaceId: workspaceId ?? raw ?? board.workspaceId });
}

/** A star change settled elsewhere is server truth, unless the switcher's own toggles on that
 *  board are still out: then the order is unknown, so leave the value to their reconcile. */
function applyExternalStar(state: BoardSwitcherState, boardId: string, starred: boolean, requestId: string) {
  const m = state.starMutations[boardId];
  if (m && m.pendingIds.length > 0) {
    m.burstSize += 1; // overlapping toggles → starNeedsReconcile re-reads the server
    return;
  }
  adoptStar(state, boardId, starred, requestId, ++state.seq); // an older in-flight fetch keeps this value
}

/** Records a settled server value as the board's star, replacing any settled toggle burst.
 *  `at`: the seq it is current from; fetches started before it keep this value. */
function adoptStar(state: BoardSwitcherState, boardId: string, starred: boolean, requestId: string, at: number) {
  state.starMutations[boardId] = {
    latestId: requestId,
    prev: starred,
    desired: starred,
    pendingIds: [],
    touchedAt: at,
    burstSize: 0,
    burstFailed: false,
  };
  setStarred(state, boardId, starred);
}

/** True (and forgets it) when an external mutation started in this session. */
function takeExternal(state: BoardSwitcherState, requestId: string): boolean {
  const i = state.externalIds.indexOf(requestId);
  if (i < 0) return false;
  state.externalIds.splice(i, 1);
  return true;
}

function settleStar(state: BoardSwitcherState, boardId: string, requestId: string, ok: boolean) {
  const m = state.starMutations[boardId];
  if (!m?.pendingIds.includes(requestId)) return;
  m.pendingIds = m.pendingIds.filter((id) => id !== requestId);
  m.touchedAt = ++state.seq;
  if (!ok) m.burstFailed = true;
  // [why] An older toggle settling (either way) must not undo a newer one.
  if (m.latestId !== requestId) return;
  if (!ok) m.desired = m.prev;
  // Re-assert: a fetch that landed mid-flight may have been applied in between.
  setStarred(state, boardId, m.desired);
}

const boardSwitcherSlice = createSlice({
  name: 'boardSwitcher',
  initialState,
  reducers: {
    setSwitcherPrefs(state, action: PayloadAction<Partial<BoardSwitcherPrefs>>) {
      state.prefs = { ...state.prefs, ...action.payload };
    },
    /** The open board was renamed, got a new background or was archived (BoardPage's own
     *  actions carry no id). */
    patchSwitcherBoard(
      state,
      action: PayloadAction<{ id: string; title: string; background: string | null; state: Board['state'] }>,
    ) {
      const { id, title, background } = action.payload;
      // [why] Record a removal even for an uncached board: a fetch still in flight may carry it as ACTIVE.
      if (action.payload.state !== 'ACTIVE') {
        writeBoard(state, id, null);
        return;
      }
      const board = state.boards.find((b) => b.id === id);
      if (board) writeBoard(state, id, { ...board, title, background });
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchSwitcherBoardsThunk.pending, (state, action) => {
        state.status = 'loading';
        state.fetchStartedAt[action.meta.requestId] = ++state.seq;
      })
      .addCase(fetchSwitcherBoardsThunk.fulfilled, (state, action) => {
        const startedAt = forgetFetch(state, action.meta.requestId);
        if (startedAt === null) return;
        if (startedAt >= state.appliedFetchAt) {
          state.appliedFetchAt = startedAt;
          state.incomplete = action.payload.incomplete;
          const current = new Map(state.boards.map((b) => [b.id, b.isStarred === true]));
          // Local writes newer than this fetch win over what it read.
          const newer = (id: string) => {
            const e = state.boardEdits[id];
            return e && e.at > startedAt ? e : undefined;
          };
          const fetched = action.payload.boards.flatMap((b) => {
            const e = newer(b.id);
            if (!e) return [b];
            if (!e.board) return [];
            // [why] A local edit covers metadata only; its snapshot's isStarred may be stale, so keep
            // the fetched star and let the star ordering below decide.
            return [{ ...e.board, ...(b.isStarred !== undefined ? { isStarred: b.isStarred } : {}) }];
          });
          for (const [id, e] of Object.entries(state.boardEdits)) {
            if (e.board && newer(id) && !fetched.some((b) => b.id === id)) fetched.push({ ...e.board });
          }
          // [why] New objects: the fetched payload is frozen.
          state.boards = fetched.map((b) => {
            const m = state.starMutations[b.id];
            const newerRead = (state.starReadAt[b.id] ?? -1) > startedAt;
            if (!newerRead && (!m || (m.pendingIds.length === 0 && m.touchedAt < startedAt))) {
              state.starReadAt[b.id] = startedAt;
              return b;
            }
            return { ...b, isStarred: current.get(b.id) ?? m?.desired ?? b.isStarred === true };
          });
          state.loadFailed = false;
        }
        settleStatus(state);
      })
      .addCase(fetchSwitcherBoardsThunk.rejected, (state, action) => {
        const startedAt = forgetFetch(state, action.meta.requestId);
        if (startedAt === null) return;
        // [why] The newest attempt failed; an older fetch landing later must not mask that.
        if (startedAt >= state.appliedFetchAt) {
          state.appliedFetchAt = startedAt;
          state.loadFailed = true;
        }
        settleStatus(state);
      })
      // Optimistic star toggle; see settleStar for completion/rollback
      .addCase(toggleSwitcherStarThunk.pending, (state, action) => {
        const { boardId, starred } = action.meta.arg;
        const cached = state.boards.find((b) => b.id === boardId);
        const prev = cached ? cached.isStarred === true : action.meta.arg.prev ?? false;
        const m = state.starMutations[boardId];
        const continuing = m !== undefined && m.pendingIds.length > 0;
        state.starMutations[boardId] = {
          latestId: action.meta.requestId,
          prev,
          desired: starred,
          pendingIds: [...(m?.pendingIds ?? []), action.meta.requestId],
          touchedAt: ++state.seq,
          burstSize: continuing ? m.burstSize + 1 : 1,
          burstFailed: continuing ? m.burstFailed : false,
        };
        setStarred(state, boardId, starred);
      })
      .addCase(toggleSwitcherStarThunk.fulfilled, (state, action) => {
        settleStar(state, action.meta.arg.boardId, action.meta.requestId, true);
      })
      .addCase(toggleSwitcherStarThunk.rejected, (state, action) => {
        settleStar(state, action.meta.arg.boardId, action.meta.requestId, false);
      })
      // The open board's fresh load: adopt its isStarred unless a toggle overlapped the fetch
      // (still pending, or touched after it started), whose value then stands.
      .addCase(fetchBoardDataThunk.pending, (state, action) => {
        state.boardFetchAt[action.meta.requestId] = ++state.seq;
      })
      .addCase(fetchBoardDataThunk.fulfilled, (state, action) => {
        const startedAt = state.boardFetchAt[action.meta.requestId];
        if (startedAt === undefined) return; // started before a session reset
        state.boardFetchAt = omitKey(state.boardFetchAt, action.meta.requestId);
        const { id, isStarred } = action.payload.data;
        if (typeof isStarred !== 'boolean') return;
        const m = state.starMutations[id];
        if (m && (m.pendingIds.length > 0 || m.touchedAt > startedAt)) return;
        if ((state.starReadAt[id] ?? -1) > startedAt) return; // a newer list read already landed
        state.starReadAt[id] = startedAt;
        adoptStar(state, id, isStarred, action.meta.requestId, startedAt);
      })
      .addCase(fetchBoardDataThunk.rejected, (state, action) => {
        state.boardFetchAt = omitKey(state.boardFetchAt, action.meta.requestId);
      })
      .addCase(createSwitcherBoardThunk.pending, (state, action) => {
        state.creatingId = action.meta.requestId;
      })
      // Keep the list in step with board mutations made elsewhere (list page, realtime).
      .addCase(createBoardThunk.fulfilled, (state, action) => {
        if (takeExternal(state, action.meta.requestId)) upsertExternal(state, action.payload, action.meta.arg.workspaceId);
      })
      .addCase(duplicateBoardThunk.fulfilled, (state, action) => {
        if (!takeExternal(state, action.meta.requestId)) return;
        // [why] The arg has only the source board; the copy lands in its workspace.
        const source = state.boards.find((b) => b.id === action.meta.arg.boardId);
        upsertExternal(state, action.payload, source?.workspaceId);
      })
      .addCase(archiveBoardThunk.fulfilled, (state, action) => {
        // [why] The same endpoint unarchives, so an ACTIVE result brings the board back.
        if (takeExternal(state, action.meta.requestId)) upsertExternal(state, action.payload, undefined);
      })
      .addCase(starBoardThunk.fulfilled, (state, action) => {
        if (takeExternal(state, action.meta.requestId)) applyExternalStar(state, action.meta.arg.boardId, true, action.meta.requestId);
      })
      .addCase(unstarBoardThunk.fulfilled, (state, action) => {
        if (takeExternal(state, action.meta.requestId)) applyExternalStar(state, action.meta.arg.boardId, false, action.meta.requestId);
      })
      // [why] Removal is not account-specific (a deleted board is gone for everyone), so no session check.
      .addCase(boardRemovedByRealtime, (state, action) => {
        writeBoard(state, action.payload.boardId, null);
      })
      .addMatcher(isAnyOf(deleteBoardThunk.fulfilled, deleteBoardOptimisticThunk.fulfilled), (state, action) => {
        takeExternal(state, action.meta.requestId);
        writeBoard(state, action.meta.arg.boardId, null);
      })
      .addMatcher(
        isAnyOf(
          createBoardThunk.pending,
          duplicateBoardThunk.pending,
          archiveBoardThunk.pending,
          starBoardThunk.pending,
          unstarBoardThunk.pending,
          deleteBoardThunk.pending,
          deleteBoardOptimisticThunk.pending,
        ),
        (state, action) => {
          state.externalIds.push(action.meta.requestId);
        },
      )
      .addMatcher(
        isAnyOf(
          createBoardThunk.rejected,
          duplicateBoardThunk.rejected,
          archiveBoardThunk.rejected,
          starBoardThunk.rejected,
          unstarBoardThunk.rejected,
          deleteBoardThunk.rejected,
          deleteBoardOptimisticThunk.rejected,
        ),
        (state, action) => {
          takeExternal(state, action.meta.requestId);
        },
      )
      // [why] Match the requestId: a previous session's create settling late must not
      // release the current session's guard.
      .addMatcher(isAnyOf(createSwitcherBoardThunk.fulfilled, createSwitcherBoardThunk.rejected), (state, action) => {
        if (state.creatingId === action.meta.requestId) state.creatingId = null;
      })
      // [why] Logout is client-side navigation, so without this the next account would see
      // the previous one's boards. Prefs stay (per browser); seq stays monotonic.
      .addMatcher(
        isAnyOf(clearAuth, logoutThunk.pending, loginThunk.fulfilled, signupThunk.fulfilled, setCredentials),
        (state) => ({ ...initialState, prefs: state.prefs, seq: state.seq, session: state.session + 1 }),
      );
  },
});

export const { setSwitcherPrefs, patchSwitcherBoard } = boardSwitcherSlice.actions;
export default boardSwitcherSlice.reducer;

// ---------- Selectors ----------

export const selectSwitcherBoards = (state: RootState) => state.boardSwitcher.boards;
export const selectSwitcherStatus = (state: RootState) => state.boardSwitcher.status;
export const selectSwitcherIncomplete = (state: RootState) => state.boardSwitcher.incomplete;
export const selectSwitcherPrefs = (state: RootState) => state.boardSwitcher.prefs;
/** The switcher's star value for a board: cached, else its latest toggle's; undefined if unknown. */
export const selectSwitcherStarred = (state: RootState, boardId: string): boolean | undefined => {
  const s = state.boardSwitcher;
  const board = s.boards.find((b) => b.id === boardId);
  return board ? board.isStarred === true : s.starMutations[boardId]?.desired;
};
export const selectSwitcherCreating = (state: RootState) => state.boardSwitcher.creatingId !== null;
