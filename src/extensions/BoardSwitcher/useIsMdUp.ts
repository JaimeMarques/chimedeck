// True at Tailwind's md breakpoint and up — where the pinned switcher panel is shown.
import { useSyncExternalStore } from 'react';

const query = '(min-width: 768px)';

const subscribe = (onChange: () => void) => {
  const mql = window.matchMedia(query);
  mql.addEventListener('change', onChange);
  return () => { mql.removeEventListener('change', onChange); };
};

export const useIsMdUp = () => useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
