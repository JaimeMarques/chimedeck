import { afterEach, describe, expect, it } from 'bun:test';
import { clampPanelWidth, normalizePanelWidth, panelWidthBounds } from '../panelWidth';
import reducer, { loadPrefs, PREFS_STORAGE_KEY, setSwitcherPrefs } from '../boardSwitcher.slice';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('pinned board switcher width', () => {
  it('validates saved widths and bounds them to practical limits', () => {
    for (const value of [undefined, null, '300', NaN, Infinity]) expect(normalizePanelWidth(value)).toBe(256);
    expect(normalizePanelWidth(100)).toBe(200);
    expect(normalizePanelWidth(999)).toBe(480);
    expect(normalizePanelWidth(310.6)).toBe(311);
  });

  it('reserves main content space after the navigation rail', () => {
    expect(panelWidthBounds(768, 64)).toEqual({ min: 200, max: 384 });
    expect(clampPanelWidth(480, panelWidthBounds(768, 64))).toBe(384);
    expect(panelWidthBounds(1000, 64)).toEqual({ min: 200, max: 480 });
    expect(panelWidthBounds(500, 64)).toEqual({ min: 116, max: 116 });
  });

  it('loads legacy, malformed and saved preferences without losing the saved width', () => {
    let saved = '{}';
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => key === PREFS_STORAGE_KEY ? saved : null,
    } });
    expect(loadPrefs().panelWidth).toBe(256);
    saved = '{broken';
    expect(loadPrefs().panelWidth).toBe(256);
    saved = JSON.stringify({ pinned: true, panelWidth: 345 });
    expect(loadPrefs()).toMatchObject({ pinned: true, panelWidth: 345 });
    saved = JSON.stringify({ panelWidth: '345' });
    expect(loadPrefs().panelWidth).toBe(256);
    saved = JSON.stringify({ panelWidth: 999 });
    expect(loadPrefs().panelWidth).toBe(480);
  });

  it('retains preferred width through pin toggling and rejects invalid updates', () => {
    let state = reducer(undefined, setSwitcherPrefs({ panelWidth: 345, pinned: true }));
    state = reducer(state, setSwitcherPrefs({ pinned: false }));
    state = reducer(state, setSwitcherPrefs({ pinned: true }));
    expect(state.prefs.panelWidth).toBe(345);
    state = reducer(state, setSwitcherPrefs({ panelWidth: NaN }));
    expect(state.prefs.panelWidth).toBe(256);
  });
});
