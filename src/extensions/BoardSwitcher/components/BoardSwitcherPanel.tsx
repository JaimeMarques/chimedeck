// BoardSwitcherPanel — the switcher pinned as a left column next to the sidebar.
import BoardSwitcherBody from './BoardSwitcherBody';
import translations from '../translations/en.json';

export default function BoardSwitcherPanel() {
  return (
    <aside
      aria-label={translations['BoardSwitcher.switchBoards']}
      className="hidden md:flex w-64 shrink-0 flex-col overflow-y-auto border-r border-border bg-bg-base p-3"
    >
      <BoardSwitcherBody variant="pinned" />
    </aside>
  );
}
