// BoardSwitcherPanel — the switcher pinned as a left column next to the sidebar.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { useAppDispatch } from '~/hooks/useAppDispatch';
import { useAppSelector } from '~/hooks/useAppSelector';
import { selectSwitcherPrefs, setSwitcherPrefs } from '../boardSwitcher.slice';
import { clampPanelWidth, panelWidthBounds } from '../panelWidth';
import BoardSwitcherBody from './BoardSwitcherBody';
import translations from '../translations/en.json';

const usePanelLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export default function BoardSwitcherPanel() {
  const dispatch = useAppDispatch();
  const { panelWidth } = useAppSelector(selectSwitcherPrefs);
  const panel = useRef<HTMLElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; width: number; draftWidth: number } | null>(null);
  const [draftWidth, setDraftWidth] = useState<number | null>(null);
  const [bounds, setBounds] = useState(() => panelWidthBounds(typeof window === 'undefined' ? 0 : window.innerWidth, 0));
  const width = clampPanelWidth(draftWidth ?? panelWidth, bounds);

  usePanelLayoutEffect(() => {
    const measure = () => {
      const next = panelWidthBounds(window.innerWidth, panel.current?.getBoundingClientRect().left ?? 0);
      setBounds((current) => current.min === next.min && current.max === next.max ? current : next);
    };
    measure();
    window.addEventListener('resize', measure);
    // The preceding desktop sidebar wrapper follows its child's animated width.
    // Observing this panel itself would miss position changes and react to our own sizing.
    const sidebar = panel.current?.previousElementSibling;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (sidebar) observer?.observe(sidebar);
    const separator = handle.current;
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
      const current = drag.current;
      drag.current = null;
      if (current && separator?.hasPointerCapture(current.id)) separator.releasePointerCapture(current.id);
    };
  }, []);

  const finishDrag = (event: PointerEvent<HTMLDivElement>, commit: boolean, useLastDraft = false) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = null;
    if (commit) {
      const next = useLastDraft ? current.draftWidth : current.width + event.clientX - current.x;
      dispatch(setSwitcherPrefs({ panelWidth: clampPanelWidth(next, bounds) }));
    }
    setDraftWidth(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <aside
      ref={panel}
      aria-label={translations['BoardSwitcher.switchBoards']}
      className="hidden md:grid grid-cols-[minmax(0,1fr)_8px] shrink-0 border-r border-border bg-bg-base"
      style={{ width }}
    >
      <div className={`col-start-1 row-start-1 flex min-h-0 min-w-0 flex-col overflow-y-auto p-3 ${draftWidth !== null ? 'select-none pointer-events-none' : ''}`}>
        <BoardSwitcherBody variant="pinned" />
      </div>
      <div
        ref={handle}
        role="separator"
        aria-label="Resize board switcher"
        aria-orientation="vertical"
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        aria-valuenow={width}
        aria-valuetext={`${String(width)} pixels`}
        tabIndex={0}
        className={`relative col-start-2 row-start-1 cursor-ew-resize touch-none select-none outline-none before:absolute before:inset-y-0 before:right-0 before:w-0.5 hover:before:bg-primary focus-visible:before:bg-primary ${draftWidth !== null ? 'before:bg-primary' : 'before:bg-border'}`}
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, x: event.clientX, width, draftWidth: width };
          setDraftWidth(width);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (current?.id === event.pointerId) {
            current.draftWidth = clampPanelWidth(current.width + event.clientX - current.x, bounds);
            setDraftWidth(current.draftWidth);
          }
        }}
        onPointerUp={(event) => { finishDrag(event, true); }}
        onPointerCancel={(event) => { finishDrag(event, false); }}
        onLostPointerCapture={(event) => { finishDrag(event, true, true); }}
        onKeyDown={(event) => {
          if (drag.current) return;
          const next = event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max
            : event.key === 'ArrowLeft' ? width - 10 : event.key === 'ArrowRight' ? width + 10 : null;
          if (next === null) return;
          event.preventDefault();
          dispatch(setSwitcherPrefs({ panelWidth: clampPanelWidth(next, bounds) }));
        }}
      />
    </aside>
  );
}
