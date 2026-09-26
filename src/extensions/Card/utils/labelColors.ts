// labelColors — shared colour helpers for label chips.
// The theme picks the look via CSS vars (.cd-label in index.css); JS only computes values.
import type { CSSProperties } from 'react';

const TRELLO_BASE = '#1d2125';

// Legacy Trello label hexes → Trello dark-mode label backgrounds.
const TRELLO_DARK_TONES: Record<string, string> = {
  '#61BD4F': '#216E4E', // green
  '#F2D600': '#7F5F01', // yellow
  '#FF9F1A': '#A54800', // orange
  '#EB5A46': '#AE2E24', // red
  '#C377E0': '#5E4DB2', // purple
  '#0079BF': '#0055CC', // blue
  '#00C2E0': '#206A83', // sky
  '#51E898': '#4C6B1F', // lime
  '#FF78CB': '#943D73', // pink
  '#344563': '#596773', // black
  '#B3BAC5': '#454F59', // grey
};
const TRELLO_GREY_TONE = '#454F59';

function parseHex(hex: string): [number, number, number] | null {
  const full = hex.trim().replace('#', '').replace(/^(.)(.)(.)$/, '$1$1$2$2$3$3');
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function isLight(hex: string): boolean {
  const rgb = parseHex(hex);
  if (!rgb) return false;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb;
  return 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255) > 0.3;
}

/** Readable fixed text colour for a label background (theme-independent). */
export function contrastText(bgHex: string): string {
  return isLight(bgHex) ? '#18181b' : '#ffffff';
}

/** Trello dark-mode label background for any label hex. */
export function trelloLabelTone(hex: string): string {
  const mapped = TRELLO_DARK_TONES[hex.trim().toUpperCase()];
  if (mapped) return mapped;
  const rgb = parseHex(hex);
  if (!rgb) return TRELLO_GREY_TONE;
  const [r, g, b] = rgb;
  const mix = (c: number, base: number) => Math.round(c * 0.6 + base * 0.4).toString(16).padStart(2, '0');
  return `#${mix(r, 0x1d)}${mix(g, 0x21)}${mix(b, 0x25)}`; // 60% hex + 40% TRELLO_BASE
}

/** Text colour for a Trello-tone background. */
export function trelloLabelText(tone: string): string {
  return isLight(tone) ? TRELLO_BASE : '#dee4ea';
}

/** Inline CSS vars consumed by `.cd-label` (default look) and `.theme-trello .cd-label`. */
export function labelStyle(hex: string): CSSProperties {
  const tone = trelloLabelTone(hex);
  return {
    '--label-bg': hex,
    '--label-fg': contrastText(hex),
    '--label-bg-trello': tone,
    '--label-fg-trello': trelloLabelText(tone),
  } as CSSProperties;
}
