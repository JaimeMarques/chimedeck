// BoardSwitcherBody — search, workspace chips and the board grid/list shared by
// the bottom-bar popover and the pinned left panel.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ListBulletIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  Squares2X2Icon,
  StarIcon as StarOutlineIcon,
} from '@heroicons/react/24/outline';
import { StarIcon as StarSolidIcon } from '@heroicons/react/24/solid';
import { useAppDispatch } from '~/hooks/useAppDispatch';
import { useAppSelector } from '~/hooks/useAppSelector';
import IconButton from '~/common/components/IconButton';
import { boardPath } from '~/common/routing/shortUrls';
import { cn } from '~/common/utils/cn';
import {
  selectActiveWorkspaceId,
  selectWorkspaces,
  setActiveWorkspace,
} from '~/extensions/Workspace/duck/workspaceDuck';
import { selectBoard } from '~/extensions/Board/slices/boardSlice';
import CreateBoardModal from '~/extensions/Board/components/CreateBoardModal';
import type { Board } from '~/extensions/Board/api';
import {
  createSwitcherBoardThunk,
  fetchSwitcherBoardsThunk,
  selectSwitcherBoards,
  selectSwitcherIncomplete,
  selectSwitcherPrefs,
  selectSwitcherStatus,
  setSwitcherPrefs,
  toggleSwitcherStarThunk,
} from '../boardSwitcher.slice';
import { boardRouteIdFromPath, filterBoards } from '../helpers';
import { PinIcon, PinSlashIcon } from './icons';
import { useIsMdUp } from '../useIsMdUp';
import translations from '../translations/en.json';

// [why] Outside-click/Escape handlers of the popover skip events from inside this
// marker, because the create modal is portalled out of the popover's DOM subtree.
export const SWITCHER_PORTAL_ATTR = 'data-board-switcher-portal';

interface Props {
  variant: 'popover' | 'pinned';
  /** Called after a board is opened or created (popover closes itself). */
  onDone?: () => void;
}

const BoardThumb = ({ board, className }: { board: Board; className: string }) =>
  board.background ? (
    <img src={board.background} alt="" aria-hidden="true" className={cn('object-cover', className)} />
  ) : (
    <div className={cn('bg-gradient-to-br from-indigo-500/20 to-blue-600/20', className)} aria-hidden="true" />
  );

export default function BoardSwitcherBody({ variant, onDone }: Props) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const boards = useAppSelector(selectSwitcherBoards);
  const status = useAppSelector(selectSwitcherStatus);
  const incomplete = useAppSelector(selectSwitcherIncomplete);
  const prefs = useAppSelector(selectSwitcherPrefs);
  const workspaces = useAppSelector(selectWorkspaces);
  const activeWorkspaceId = useAppSelector(selectActiveWorkspaceId);
  const loadedBoard = useAppSelector(selectBoard);
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string>();
  // [why] Below md the pinned panel is hidden, so the popover owns the pin toggle
  const isMdUp = useIsMdUp();

  // Refetch whenever the popover opens / the pinned panel mounts
  useEffect(() => {
    void dispatch(fetchSwitcherBoardsThunk());
  }, [dispatch]);

  // A saved filter may point at a workspace the user no longer belongs to
  const workspaceFilter = workspaces.some((w) => w.id === prefs.workspaceFilter) ? prefs.workspaceFilter : 'all';
  const visibleBoards = useMemo(
    () => filterBoards(boards, { workspaceFilter, query }),
    [boards, workspaceFilter, query],
  );
  const layout = variant === 'pinned' ? 'list' : prefs.layout;

  // [why] /b/:id identifies the board directly; on /c/:cardId only the loaded board
  // slice knows it. Other routes highlight nothing (the slice may hold a stale board).
  const routeBoardId = boardRouteIdFromPath(pathname);
  const isCurrent = (b: Board) =>
    routeBoardId
      ? b.id === routeBoardId || b.short_id === routeBoardId
      : pathname.startsWith('/c/') && b.id === loadedBoard?.id;

  // Link click: the <a href> navigates; we only sync the workspace and close the popover.
  // Modified clicks open a new tab/window, so leave this view alone.
  const onBoardLinkClick = (e: React.MouseEvent, b: Board) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    dispatch(setActiveWorkspace(b.workspaceId));
    onDone?.();
  };

  const retryLoad = () => {
    void dispatch(fetchSwitcherBoardsThunk());
  };

  const toggleStar = (b: Board) => {
    void dispatch(toggleSwitcherStarThunk({ boardId: b.id, starred: !b.isStarred })).then((r) => {
      // [why] The failed toggle rolls back locally; refetch so overlapping failures end on server truth.
      if (toggleSwitcherStarThunk.rejected.match(r)) retryLoad();
    });
  };

  // Where "Create new board" lands: the filtered workspace, else the active one
  const createWorkspaceId =
    (workspaceFilter !== 'all' ? workspaceFilter : null) ?? activeWorkspaceId ?? workspaces[0]?.id;
  const createWorkspaceName = workspaces.find((w) => w.id === createWorkspaceId)?.name;
  const createSubtitle = createWorkspaceName
    ? translations['BoardSwitcher.createIn'].replace('{workspace}', createWorkspaceName)
    : undefined;

  const handleCreate = async (title: string) => {
    const workspaceId = createWorkspaceId;
    if (!workspaceId) return;
    setCreateError(undefined);
    const result = await dispatch(createSwitcherBoardThunk({ workspaceId, title }));
    if (!createSwitcherBoardThunk.fulfilled.match(result)) {
      setCreateError(translations['BoardSwitcher.createFailed']);
      return;
    }
    setCreateOpen(false);
    void dispatch(fetchSwitcherBoardsThunk());
    dispatch(setActiveWorkspace(workspaceId));
    navigate(boardPath(result.payload));
    onDone?.();
  };

  const closeCreate = () => {
    setCreateOpen(false);
    setCreateError(undefined);
  };

  // [why] A sibling of the board link, not inside it: a button nested in a link is
  // invalid and its Enter/click would also open the board.
  const starButton = (b: Board, onImage = false) => (
    <button
      type="button"
      onClick={() => { toggleStar(b); }}
      aria-label={b.isStarred ? translations['BoardSwitcher.unstar'] : translations['BoardSwitcher.star']}
      aria-pressed={!!b.isStarred}
      className={cn(
        'rounded p-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        onImage && 'bg-black/30 text-white',
        b.isStarred ? 'text-yellow-400' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
      )}
    >
      {b.isStarred ? <StarSolidIcon className="h-4 w-4" /> : <StarOutlineIcon className="h-4 w-4" />}
    </button>
  );

  const chipClass = (selected: boolean) =>
    cn(
      'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
      selected ? 'border-primary text-primary' : 'border-border text-muted hover:text-base hover:bg-bg-overlay',
    );

  const renderBoards = () => {
    if (status === 'loading' && boards.length === 0) {
      return <p className="px-1 py-3 text-sm text-muted">{translations['BoardSwitcher.loading']}</p>;
    }
    // [why] A failed load must not read as "no boards"; keep any earlier boards visible below it.
    const loadIssue = (status === 'error' || incomplete) && (
      <div role="alert" className="flex items-center justify-between gap-2 px-1 py-2 text-sm text-danger">
        <span>{translations[status === 'error' ? 'BoardSwitcher.loadFailed' : 'BoardSwitcher.loadIncomplete']}</span>
        <button
          type="button"
          onClick={retryLoad}
          className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-primary hover:bg-bg-overlay focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {translations['BoardSwitcher.retry']}
        </button>
      </div>
    );
    const empty = status !== 'error' && visibleBoards.length === 0 && (
      <p className="px-1 py-3 text-sm text-muted">{translations['BoardSwitcher.noBoards']}</p>
    );

    if (layout === 'grid') {
      return (
        <>
          {loadIssue}
          {empty}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {visibleBoards.map((b) => (
              <div key={b.id} className="group relative">
                <Link
                  to={boardPath(b)}
                  onClick={(e) => { onBoardLinkClick(e, b); }}
                  aria-current={isCurrent(b) ? 'page' : undefined}
                  className={cn(
                    'flex h-full flex-col overflow-hidden rounded-lg border bg-bg-surface group-hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                    isCurrent(b) ? 'border-primary' : 'border-border',
                  )}
                >
                  <BoardThumb board={b} className="h-20 w-full" />
                  <span className="line-clamp-2 px-2 py-1.5 text-xs font-medium text-base">{b.title}</span>
                </Link>
                <div className="absolute right-1.5 top-1.5">{starButton(b, true)}</div>
              </div>
            ))}
            <button
              type="button"
              onClick={() => { setCreateOpen(true); }}
              className="flex min-h-[7rem] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-xs text-muted hover:bg-bg-overlay hover:text-base"
            >
              <PlusIcon className="h-5 w-5" aria-hidden="true" />
              {translations['BoardSwitcher.createBoard']}
              {createSubtitle && <span className="text-[11px] text-subtle">{createSubtitle}</span>}
            </button>
          </div>
        </>
      );
    }

    return (
      <>
      {loadIssue}
      {empty}
      <ul className="flex flex-col gap-0.5">
        {visibleBoards.map((b) => {
          const current = isCurrent(b);
          return (
            <li key={b.id} className="group relative">
              <Link
                to={boardPath(b)}
                onClick={(e) => { onBoardLinkClick(e, b); }}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'relative flex items-center gap-2.5 rounded-md py-1.5 pl-2.5 pr-8 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  current ? 'bg-[color-mix(in_srgb,var(--color-primary)_14%,transparent)]' : 'group-hover:bg-bg-overlay',
                )}
              >
                {current && <span className="absolute inset-y-1 left-0 w-[3px] rounded-r bg-primary" aria-hidden="true" />}
                <BoardThumb board={b} className="h-8 w-10 shrink-0 rounded" />
                {/* [why] Not via cn(): twMerge reads the text-base color token as a font size and drops text-sm */}
                <span className={`min-w-0 flex-1 truncate text-sm text-base ${current ? 'font-semibold' : ''}`}>
                  {b.title}
                </span>
              </Link>
              <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2">{starButton(b)}</div>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            onClick={() => { setCreateOpen(true); }}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted hover:bg-bg-overlay hover:text-base"
          >
            <PlusIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">
              {translations['BoardSwitcher.createBoard']}
              {createSubtitle && <span className="ml-1.5 text-xs text-subtle">{createSubtitle}</span>}
            </span>
          </button>
        </li>
      </ul>
      </>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Search + layout toggle + pin/unpin */}
      <div className="flex items-center gap-1.5">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-bg-base px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-primary">
          <MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
          <input
            autoFocus={variant === 'popover'}
            type="search"
            value={query}
            onChange={(e) => { setQuery(e.target.value); }}
            placeholder={translations['BoardSwitcher.searchPlaceholder']}
            aria-label={translations['BoardSwitcher.searchPlaceholder']}
            className="min-w-0 flex-1 bg-transparent text-sm text-base placeholder:text-subtle focus:outline-none"
          />
        </label>
        {variant === 'popover' && (
          <IconButton
            aria-label={translations['BoardSwitcher.listLayout']}
            aria-pressed={layout === 'list'}
            onClick={() => dispatch(setSwitcherPrefs({ layout: layout === 'grid' ? 'list' : 'grid' }))}
            icon={layout === 'grid' ? <ListBulletIcon className="h-4 w-4" /> : <Squares2X2Icon className="h-4 w-4" />}
          />
        )}
        {/* Below md a pinned switcher shows as this popover, so it carries Unpin */}
        {variant === 'popover' && (isMdUp || !prefs.pinned) ? (
          <IconButton
            aria-label={translations['BoardSwitcher.pin']}
            onClick={() => {
              dispatch(setSwitcherPrefs({ pinned: true, pinnedOpen: true }));
              // Below md there is no panel to hand over to, so stay open (showing Unpin)
              if (isMdUp) onDone?.();
            }}
            icon={<PinIcon className="h-4 w-4" />}
          />
        ) : (
          <IconButton
            aria-label={translations['BoardSwitcher.unpin']}
            onClick={() => dispatch(setSwitcherPrefs({ pinned: false }))}
            icon={<PinSlashIcon className="h-4 w-4" />}
          />
        )}
      </div>

      {/* Workspace filter chips */}
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          aria-pressed={workspaceFilter === 'all'}
          onClick={() => dispatch(setSwitcherPrefs({ workspaceFilter: 'all' }))}
          className={chipClass(workspaceFilter === 'all')}
        >
          {translations['BoardSwitcher.allWorkspacesChip']}
        </button>
        {workspaces.map((w) => (
          <button
            key={w.id}
            type="button"
            aria-pressed={workspaceFilter === w.id}
            onClick={() => dispatch(setSwitcherPrefs({ workspaceFilter: w.id }))}
            className={chipClass(workspaceFilter === w.id)}
          >
            {w.name}
          </button>
        ))}
      </div>

      {/* Collapsible "Your boards" section */}
      <div>
        <button
          type="button"
          aria-expanded={!prefs.boardsCollapsed}
          onClick={() => dispatch(setSwitcherPrefs({ boardsCollapsed: !prefs.boardsCollapsed }))}
          className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted hover:text-base"
        >
          {prefs.boardsCollapsed ? (
            <ChevronRightIcon className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {translations['BoardSwitcher.yourBoards']}
        </button>
        {!prefs.boardsCollapsed && renderBoards()}
      </div>

      {/* Footer links (popover only) */}
      {variant === 'popover' && (
        <div className="flex gap-4 border-t border-border pt-3 text-xs">
          {workspaceFilter === 'all' ? (
            <Link to="/workspaces" onClick={onDone} className="text-link hover:underline">
              {translations['BoardSwitcher.allWorkspaces']}
            </Link>
          ) : (
            <>
              <Link to={`/workspace/${workspaceFilter}`} onClick={onDone} className="text-link hover:underline">
                {translations['BoardSwitcher.members']}
              </Link>
              <Link to={`/workspaces/${workspaceFilter}/boards`} onClick={onDone} className="text-link hover:underline">
                {translations['BoardSwitcher.allBoards']}
              </Link>
            </>
          )}
        </div>
      )}

      {createOpen &&
        createPortal(
          <div {...{ [SWITCHER_PORTAL_ATTR]: '' }}>
            <CreateBoardModal
              onClose={closeCreate}
              onCreate={(t) => { void handleCreate(t); }}
              subtitle={createSubtitle}
              error={createError}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
