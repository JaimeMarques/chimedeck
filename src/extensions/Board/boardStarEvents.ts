// A board's star value as the board switcher resolved it. [why] A neutral module so the
// switcher can announce it and the board list slices follow without an import cycle.
import { createAction } from '@reduxjs/toolkit';

export const boardStarSet = createAction<{ boardId: string; isStarred: boolean }>('board/starSet');
