// BoardBottomBar — Trello-style floating pill at the bottom of a board:
// Inbox / Planner / Board | Switch boards.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import {
  ArrowsRightLeftIcon,
  CalendarDaysIcon,
  InboxIcon,
  ViewColumnsIcon,
} from '@heroicons/react/24/outline';
import { useAppDispatch } from '~/hooks/useAppDispatch';
import { useAppSelector } from '~/hooks/useAppSelector';
import { cn } from '~/common/utils/cn';
import {
  saveViewPreference,
  selectActiveView,
  setActiveView,
} from '~/extensions/BoardViewSwitcher/viewPreference.slice';
import type { ViewType } from '~/extensions/BoardViewSwitcher/types';
import { selectUnreadCount } from '~/extensions/Notification/slices/notificationSlice';
import NotificationPanel from '~/extensions/Notification/components/NotificationPanel';
import { useNotificationNavigate } from '~/extensions/Notification/hooks/useNotificationNavigate';
import { selectSwitcherPrefs, setSwitcherPrefs } from '../boardSwitcher.slice';
import BoardSwitcherPopover from './BoardSwitcherPopover';
import { SWITCHER_PORTAL_ATTR } from './BoardSwitcherBody';
import { useIsMdUp } from '../useIsMdUp';
import translations from '../translations/en.json';

interface Props {
  boardId: string;
  /** True when the Board tab (not Activity/Archived/...) is showing. */
  boardTabActive: boolean;
  onShowBoardTab: () => void;
}

const badgeLabel = (n: number) => (n > 99 ? '99+' : String(n));

type OpenPopover = 'inbox' | 'switcher' | null;

const isInsidePortal = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest(`[${SWITCHER_PORTAL_ATTR}]`);

function BarButton({
  label,
  ariaLabel = label,
  icon,
  active,
  onClick,
  badge,
  expanded,
}: {
  label: string;
  ariaLabel?: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
  badge?: number;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={expanded === undefined ? active : undefined}
      aria-expanded={expanded}
      className={cn(
        'relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        // [why] Theme colors are plain CSS vars, so Tailwind's /10 opacity modifier emits nothing.
        active ? 'bg-[color-mix(in_srgb,var(--color-primary)_14%,transparent)] text-primary' : 'text-muted hover:bg-bg-overlay hover:text-base',
      )}
    >
      {icon}
      {/* [why] Icon-only below sm so the four buttons fit a phone; aria-label keeps the name */}
      <span className="hidden sm:inline">{label}</span>
      {!!badge && (
        // Same colours as NotificationBell's badge (bg-primary + white failed contrast)
        <span className="rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-bold leading-none text-inverse" aria-hidden="true">
          {badgeLabel(badge)}
        </span>
      )}
      {active && <span className="absolute bottom-0.5 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded bg-primary" aria-hidden="true" />}
    </button>
  );
}

export default function BoardBottomBar({ boardId, boardTabActive, onShowBoardTab }: Props) {
  const dispatch = useAppDispatch();
  const { pathname } = useLocation();
  const activeView = useAppSelector(selectActiveView);
  const unreadCount = useAppSelector(selectUnreadCount);
  const prefs = useAppSelector(selectSwitcherPrefs);
  const handleNotificationNavigate = useNotificationNavigate();
  const [open, setOpen] = useState<OpenPopover>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // [why] The pinned panel is hidden below md, so there pinned behaves like popover mode.
  const isMdUp = useIsMdUp();
  const pinned = prefs.pinned && isMdUp;

  // Close popovers on navigation
  useEffect(() => { setOpen(null); }, [pathname]);
  // Growing past md with pinned on shows the panel, so drop the popover
  useEffect(() => { if (pinned) setOpen((o) => (o === 'switcher' ? null : o)); }, [pinned]);

  // Close popovers on outside click and Escape
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (isInsidePortal(e.target)) return;
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector(`[${SWITCHER_PORTAL_ATTR}]`)) return;
      setOpen(null);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const showView = (view: ViewType) => {
    onShowBoardTab();
    setOpen(null);
    // Same as BoardViewSwitcher's switchView: optimistic local update + persist
    dispatch(setActiveView(view));
    void dispatch(saveViewPreference({ boardId, viewType: view }));
  };

  const toggleSwitcher = () => {
    if (pinned) {
      setOpen(null);
      dispatch(setSwitcherPrefs({ pinnedOpen: !prefs.pinnedOpen }));
    } else {
      setOpen((o) => (o === 'switcher' ? null : 'switcher'));
    }
  };

  // [why] The full-width wrapper is the popovers' containing block, so their
  // max-width is the board area (not the viewport, which includes the sidebar).
  // z-20: above the lists and the z-10 header, below the automation scrim (z-30).
  return (
    <div ref={barRef} className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center">
    <div
      role="toolbar"
      aria-label={translations['BoardSwitcher.barAriaLabel']}
      className="pointer-events-auto flex items-center gap-1 rounded-xl border border-border bg-[color-mix(in_srgb,var(--bg-surface)_95%,transparent)] p-1 shadow-lg backdrop-blur"
    >
      <BarButton
        label={translations['BoardSwitcher.inbox']}
        ariaLabel={
          unreadCount > 0
            ? translations['BoardSwitcher.inboxUnread'].replace('{count}', badgeLabel(unreadCount))
            : translations['BoardSwitcher.inbox']
        }
        icon={<InboxIcon className="h-4 w-4" aria-hidden="true" />}
        active={open === 'inbox'}
        expanded={open === 'inbox'}
        badge={unreadCount}
        onClick={() => { setOpen((o) => (o === 'inbox' ? null : 'inbox')); }}
      />
      <BarButton
        label={translations['BoardSwitcher.planner']}
        icon={<CalendarDaysIcon className="h-4 w-4" aria-hidden="true" />}
        active={boardTabActive && activeView === 'CALENDAR'}
        onClick={() => { showView('CALENDAR'); }}
      />
      <BarButton
        label={translations['BoardSwitcher.board']}
        icon={<ViewColumnsIcon className="h-4 w-4" aria-hidden="true" />}
        active={boardTabActive && activeView === 'KANBAN'}
        onClick={() => { showView('KANBAN'); }}
      />
      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
      <BarButton
        label={translations['BoardSwitcher.switchBoards']}
        icon={<ArrowsRightLeftIcon className="h-4 w-4" aria-hidden="true" />}
        active={open === 'switcher' || (pinned && prefs.pinnedOpen)}
        expanded={open === 'switcher' || (pinned && prefs.pinnedOpen)}
        onClick={toggleSwitcher}
      />
    </div>

      {open === 'switcher' && <BoardSwitcherPopover onClose={() => { setOpen(null); }} />}
      {open === 'inbox' && (
        <NotificationPanel
          className="pointer-events-auto absolute bottom-full left-1/2 mb-2 w-[380px] max-w-[calc(100%-2rem)] max-h-[60vh] -translate-x-1/2"
          onClose={() => { setOpen(null); }}
          onNavigate={handleNotificationNavigate}
        />
      )}
    </div>
  );
}
