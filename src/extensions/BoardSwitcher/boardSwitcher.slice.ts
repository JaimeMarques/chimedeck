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

interface BoardSwitcherState {
  boards: Board[];
  status: 'idle' | 'loading' | 'error';
  prefs: BoardSwitcherPrefs;
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
  prefs: loadPrefs(),
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
    // [why] The list endpoint returns raw rows (workspace_id), so stamp the camelCase
    // workspaceId the filter chips and setActiveWorkspace rely on.
    return results
      .flatMap((r, i) =>
        r.status === 'fulfilled' ? r.value.data.map((b) => ({ ...b, workspaceId: workspaces[i]?.id ?? b.workspaceId })) : [],
      )
      .filter((b) => b.state === 'ACTIVE');
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
      .addCase(fetchSwitcherBoardsThunk.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchSwitcherBoardsThunk.fulfilled, (state, action) => {
        state.status = 'idle';
        state.boards = action.payload;
      })
      .addCase(fetchSwitcherBoardsThunk.rejected, (state) => {
        state.status = 'error';
      })
      // Optimistic star toggle with rollback on failure
      .addCase(toggleSwitcherStarThunk.pending, (state, action) => {
        setStarred(state, action.meta.arg.boardId, action.meta.arg.starred);
      })
      .addCase(toggleSwitcherStarThunk.rejected, (state, action) => {
        setStarred(state, action.meta.arg.boardId, !action.meta.arg.starred);
      });
  },
});

export const { setSwitcherPrefs } = boardSwitcherSlice.actions;
export default boardSwitcherSlice.reducer;

// ---------- Selectors ----------

export const selectSwitcherBoards = (state: RootState) => state.boardSwitcher.boards;
export const selectSwitcherStatus = (state: RootState) => state.boardSwitcher.status;
export const selectSwitcherPrefs = (state: RootState) => state.boardSwitcher.prefs;
