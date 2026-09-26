// Board switcher slice — all active boards across the user's workspaces plus the
// switcher's UI prefs. [why] Prefs live in Redux because the bottom bar (BoardPage)
// and the pinned panel (AppShell) must share them; AppShell persists them.
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '~/store';
import { createAppAsyncThunk } from '~/utils/redux';
import type { apiClient } from '~/common/api/client';
import { listWorkspaces } from '../Workspace/api';
import { listBoards, createBoard, starBoard, unstarBoard, type Board } from '../Board/api';
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
  inFlight: number;
  touchedAt: number;
}

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
  async ({ boardId, starred }: { boardId: string; starred: boolean }, { extra }) => {
    if (starred) await starBoard({ api: apiOf(extra), boardId });
    else await unstarBoard({ api: apiOf(extra), boardId });
  },
);

export const createSwitcherBoardThunk = createAppAsyncThunk(
  'boardSwitcher/createBoard',
  async ({ workspaceId, title }: { workspaceId: string; title: string }, { extra }) => {
    const res = await createBoard({ api: apiOf(extra), workspaceId, title });
    return res.data;
  },
);

// ---------- Slice ----------

function setStarred(state: BoardSwitcherState, boardId: string, starred: boolean) {
  const board = state.boards.find((b) => b.id === boardId);
  if (board) board.isStarred = starred;
}

/** Drops a settled fetch and returns its start seq (an unknown fetch counts as starting now). */
function forgetFetch(state: BoardSwitcherState, requestId: string): number {
  const startedAt = state.fetchStartedAt[requestId] ?? state.seq;
  state.fetchStartedAt = Object.fromEntries(Object.entries(state.fetchStartedAt).filter(([id]) => id !== requestId));
  return startedAt;
}

function settleStatus(state: BoardSwitcherState) {
  if (Object.keys(state.fetchStartedAt).length > 0) state.status = 'loading';
  else state.status = state.loadFailed ? 'error' : 'idle';
}

function settleStar(state: BoardSwitcherState, boardId: string, requestId: string, ok: boolean) {
  const m = state.starMutations[boardId];
  if (!m) return;
  m.inFlight = Math.max(0, m.inFlight - 1);
  m.touchedAt = ++state.seq;
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
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchSwitcherBoardsThunk.pending, (state, action) => {
        state.status = 'loading';
        state.fetchStartedAt[action.meta.requestId] = ++state.seq;
      })
      .addCase(fetchSwitcherBoardsThunk.fulfilled, (state, action) => {
        const startedAt = forgetFetch(state, action.meta.requestId);
        if (startedAt >= state.appliedFetchAt) {
          state.appliedFetchAt = startedAt;
          state.incomplete = action.payload.incomplete;
          const current = new Map(state.boards.map((b) => [b.id, b.isStarred === true]));
          // [why] New objects: the fetched payload is frozen.
          state.boards = action.payload.boards.map((b) => {
            const m = state.starMutations[b.id];
            if (!m || (m.inFlight === 0 && m.touchedAt < startedAt)) return b;
            return { ...b, isStarred: current.get(b.id) ?? m.desired };
          });
          state.loadFailed = false;
        }
        settleStatus(state);
      })
      .addCase(fetchSwitcherBoardsThunk.rejected, (state, action) => {
        const startedAt = forgetFetch(state, action.meta.requestId);
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
        const prev = state.boards.find((b) => b.id === boardId)?.isStarred === true;
        state.starMutations[boardId] = {
          latestId: action.meta.requestId,
          prev,
          desired: starred,
          inFlight: (state.starMutations[boardId]?.inFlight ?? 0) + 1,
          touchedAt: ++state.seq,
        };
        setStarred(state, boardId, starred);
      })
      .addCase(toggleSwitcherStarThunk.fulfilled, (state, action) => {
        settleStar(state, action.meta.arg.boardId, action.meta.requestId, true);
      })
      .addCase(toggleSwitcherStarThunk.rejected, (state, action) => {
        settleStar(state, action.meta.arg.boardId, action.meta.requestId, false);
      });
  },
});

export const { setSwitcherPrefs } = boardSwitcherSlice.actions;
export default boardSwitcherSlice.reducer;

// ---------- Selectors ----------

export const selectSwitcherBoards = (state: RootState) => state.boardSwitcher.boards;
export const selectSwitcherStatus = (state: RootState) => state.boardSwitcher.status;
export const selectSwitcherIncomplete = (state: RootState) => state.boardSwitcher.incomplete;
export const selectSwitcherPrefs = (state: RootState) => state.boardSwitcher.prefs;
