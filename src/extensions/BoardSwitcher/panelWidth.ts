export const DEFAULT_PANEL_WIDTH = 256;
export const MIN_PANEL_WIDTH = 200;
export const MAX_PANEL_WIDTH = 480;

export function normalizePanelWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PANEL_WIDTH;
  return Math.round(Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, value)));
}

export function panelWidthBounds(viewportWidth: number, panelLeft: number) {
  // Leave room for the board after the navigation rail and this panel.
  const max = Math.max(0, Math.floor(Math.min(MAX_PANEL_WIDTH, viewportWidth - panelLeft - 320)));
  return { min: Math.min(MIN_PANEL_WIDTH, max), max };
}

export function clampPanelWidth(width: number, bounds: { min: number; max: number }) {
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}
