// BoardSwitcherPopover — the switcher floating above the board bottom bar.
// Outside-click / Escape / navigation closing is owned by the bar, whose full-width
// wrapper is this popover's containing block (so 100% = the board area width).
import BoardSwitcherBody from './BoardSwitcherBody';
import translations from '../translations/en.json';

export default function BoardSwitcherPopover({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label={translations['BoardSwitcher.switchBoards']}
      className="pointer-events-auto absolute bottom-full left-1/2 mb-2 w-[600px] max-w-[calc(100%-2rem)] max-h-[70vh] -translate-x-1/2 overflow-y-auto rounded-xl border border-border bg-bg-surface p-4 shadow-2xl"
    >
      <BoardSwitcherBody variant="popover" onDone={onClose} />
    </div>
  );
}
