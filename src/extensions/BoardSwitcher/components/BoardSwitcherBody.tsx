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
  selectSwitcherPrefs,
  selectSwitcherStatus,
  setSwitcherPrefs,
  toggleSwitcherStarThunk,
} from '../boardSwitcher.slice';
import { boardRouteIdFromPath, filterBoards } from '../helpers';
import { PinIcon, PinSlashIcon } from './icons';
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
  const prefs = useAppSelector(selectSwitcherPrefs);
  const workspaces = useAppSelector(selectWorkspaces);
  const activeWorkspaceId = useAppSelector(selectActiveWorkspaceId);
  const loadedBoard = useAppSelector(selectBoard);
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

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

  const openBoard = (b: { id: string; short_id?: string; title: string; workspaceId: string }) => {
    dispatch(setActiveWorkspace(b.workspaceId));
    navigate(boardPath(b));
    onDone?.();
  };

  const toggleStar = (e: React.MouseEvent, b: Board) => {
    e.stopPropagation();
    void dispatch(toggleSwitcherStarThunk({ boardId: b.id, starred: !b.isStarred }));
  };

  const handleCreate = async (title: string) => {
    const workspaceId =
      (workspaceFilter !== 'all' ? workspaceFilter : null) ?? activeWorkspaceId ?? workspaces[0]?.id;
    if (!workspaceId) return;
    const result = await dispatch(createSwitcherBoardThunk({ workspaceId, title }));
    if (!createSwitcherBoardThunk.fulfilled.match(result)) return;
    setCreateOpen(false);
    void dispatch(fetchSwitcherBoardsThunk());
    openBoard({ ...result.payload, workspaceId });
  };

  const starButton = (b: Board, onImage = false) => (
    <button
      type="button"
      onClick={(e) => { toggleStar(e, b); }}
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
    const empty = visibleBoards.length === 0 && (
      <p className="px-1 py-3 text-sm text-muted">{translations['BoardSwitcher.noBoards']}</p>
    );

    if (layout === 'grid') {
      return (
        <>
          {empty}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {visibleBoards.map((b) => (
              <div
                key={b.id}
                role="link"
                tabIndex={0}
                onClick={() => { openBoard(b); }}
                onKeyDown={(e) => { if (e.key === 'Enter') openBoard(b); }}
                className={cn(
                  'group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-bg-surface hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  isCurrent(b) ? 'border-primary' : 'border-border',
                )}
              >
                <BoardThumb board={b} className="h-20 w-full" />
                <div className="absolute right-1.5 top-1.5">{starButton(b, true)}</div>
                <span className="line-clamp-2 px-2 py-1.5 text-xs font-medium text-base">{b.title}</span>
              </div>
            ))}
            <button
              type="button"
              onClick={() => { setCreateOpen(true); }}
              className="flex min-h-[7rem] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-xs text-muted hover:bg-bg-overlay hover:text-base"
            >
              <PlusIcon className="h-5 w-5" aria-hidden="true" />
              {translations['BoardSwitcher.createBoard']}
            </button>
          </div>
        </>
      );
    }

    return (
      <ul className="flex flex-col gap-0.5">
        {empty}
        {visibleBoards.map((b) => {
          const current = isCurrent(b);
          return (
            <li key={b.id}>
              <div
                role="link"
                tabIndex={0}
                aria-current={current ? 'page' : undefined}
                onClick={() => { openBoard(b); }}
                onKeyDown={(e) => { if (e.key === 'Enter') openBoard(b); }}
                className={cn(
                  'group relative flex cursor-pointer items-center gap-2.5 rounded-md py-1.5 pl-2.5 pr-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  current ? 'bg-[color-mix(in_srgb,var(--color-primary)_14%,transparent)]' : 'hover:bg-bg-overlay',
                )}
              >
                {current && <span className="absolute inset-y-1 left-0 w-[3px] rounded-r bg-primary" aria-hidden="true" />}
                <BoardThumb board={b} className="h-8 w-10 shrink-0 rounded" />
                {/* [why] Not via cn(): twMerge reads the text-base color token as a font size and drops text-sm */}
                <span className={`min-w-0 flex-1 truncate text-sm text-base ${current ? 'font-semibold' : ''}`}>
                  {b.title}
                </span>
                {starButton(b)}
              </div>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            onClick={() => { setCreateOpen(true); }}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted hover:bg-bg-overlay hover:text-base"
          >
            <PlusIcon className="h-4 w-4" aria-hidden="true" />
            {translations['BoardSwitcher.createBoard']}
          </button>
        </li>
      </ul>
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
            aria-label={layout === 'grid' ? translations['BoardSwitcher.showAsList'] : translations['BoardSwitcher.showAsGrid']}
            aria-pressed={layout === 'list'}
            onClick={() => dispatch(setSwitcherPrefs({ layout: layout === 'grid' ? 'list' : 'grid' }))}
            icon={layout === 'grid' ? <ListBulletIcon className="h-4 w-4" /> : <Squares2X2Icon className="h-4 w-4" />}
          />
        )}
        {variant === 'popover' ? (
          <IconButton
            aria-label={translations['BoardSwitcher.pin']}
            aria-pressed={false}
            onClick={() => {
              dispatch(setSwitcherPrefs({ pinned: true, pinnedOpen: true }));
              onDone?.();
            }}
            icon={<PinIcon className="h-4 w-4" />}
          />
        ) : (
          <IconButton
            aria-label={translations['BoardSwitcher.unpin']}
            aria-pressed
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
            <CreateBoardModal onClose={() => { setCreateOpen(false); }} onCreate={(t) => { void handleCreate(t); }} />
          </div>,
          document.body,
        )}
    </div>
  );
}
