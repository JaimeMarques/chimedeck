import { describe, expect, it } from 'bun:test';
import { contrastText, labelStyle, trelloLabelText, trelloLabelTone } from '../labelColors';

describe('labelColors', () => {
  it('picks the fixed text colour with the higher contrast ratio', () => {
    expect(contrastText('#F2D600')).toBe('#18181b'); // yellow
    expect(contrastText('#fff')).toBe('#18181b');
    expect(contrastText('#61BD4F')).toBe('#18181b'); // green
    expect(contrastText('#ef4444')).toBe('#18181b'); // red: 4.71:1 vs 3.76:1 on white
    expect(contrastText('#ec4899')).toBe('#18181b'); // pink: 5.02:1 vs 3.53:1 on white
    expect(contrastText('#0079BF')).toBe('#ffffff');
    expect(contrastText('#344563')).toBe('#ffffff'); // dark
  });

  it('gives a colourless label the theme text colour', () => {
    expect(contrastText('')).toBe('var(--text-base)');
    expect(labelStyle('')).toMatchObject({ '--label-bg': '', '--label-fg': 'var(--text-base)' });
  });

  it('maps legacy Trello hexes case-insensitively', () => {
    expect(trelloLabelTone('#61bd4f')).toBe('#216E4E');
    expect(trelloLabelTone('#FF9F1A')).toBe('#A54800');
    expect(trelloLabelTone('#C377E0')).toBe('#5E4DB2');
  });

  it('mixes other hexes 60% with the Trello base', () => {
    // 0x3e*.6+0x1d*.4 = 48.8 → 0x31; 0x63*.6+0x21*.4 = 72.6 → 0x49; 0xdd*.6+0x25*.4 = 147.4 → 0x93
    expect(trelloLabelTone('#3e63dd')).toBe('#314993');
    expect(trelloLabelTone('#ffffff')).toBe('#a5a6a8');
  });

  it('uses light text on dark tones', () => {
    expect(trelloLabelText('#7F5F01')).toBe('#dee4ea');
    expect(trelloLabelText('#a5a6a8')).toBe('#1d2125');
    // #AE2E24 (red): light 5.10:1 vs dark 2.48:1; mid grey #8f9194: dark 5.13:1 vs light 2.47:1
    expect(trelloLabelText('#AE2E24')).toBe('#dee4ea');
    expect(trelloLabelText('#8f9194')).toBe('#1d2125');
  });

  it('exposes both looks as CSS vars', () => {
    expect(labelStyle('#F2D600')).toEqual({
      '--label-bg': '#F2D600',
      '--label-fg': '#18181b',
      '--label-bg-trello': '#7F5F01',
      '--label-fg-trello': '#dee4ea',
    } as never);
  });
});
