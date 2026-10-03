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
    expect(trelloLabelTone('#FF9F1A')).toBe('#9E4C00');
    expect(trelloLabelTone('#C377E0')).toBe('#803FA5');
    expect(trelloLabelTone('#0079BF')).toBe('#1558BC');
  });

  it('preserves custom hex colours without muting their saturation', () => {
    expect(trelloLabelTone('#3e63dd')).toBe('#3e63dd');
    expect(trelloLabelTone('#ffffff')).toBe('#ffffff');
    expect(trelloLabelTone(' #F0A ')).toBe('#ff00aa');
  });

  it('keeps standard and bold Trello tones distinct', () => {
    expect(trelloLabelTone('#5ba4cf')).toBe('#669DF1');
    expect(trelloLabelTone('#579DFF')).toBe('#669DF1');
    for (const tone of ['#669DF1', '#F87168', '#4BCE97', '#DDB30E', '#FCA700', '#C97CF4', '#E774BB', '#6CC3E0', '#94C748']) {
      expect(trelloLabelTone(tone)).toBe(tone.toLowerCase());
    }
    expect(trelloLabelTone('#0079BF')).not.toBe(trelloLabelTone('#5BA4CF'));
  });

  it('uses light text on dark tones', () => {
    expect(trelloLabelText('#7F5F01')).toBe('#ffffff');
    expect(trelloLabelText('#a5a6a8')).toBe('#1F1F21');
    expect(trelloLabelText('#AE2E24')).toBe('#ffffff');
    expect(trelloLabelText('#8f9194')).toBe('#1F1F21');
  });

  it('maintains WCAG AA text contrast for tones and arbitrary custom colours', () => {
    const luminance = (hex: string) => {
      const channel = (offset: number) => {
        const s = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return channel(1) * 0.2126 + channel(3) * 0.7152 + channel(5) * 0.0722;
    };
    for (const hex of ['#61BD4F', '#F2D600', '#FF9F1A', '#EB5A46', '#C377E0', '#0079BF', '#00C2E0', '#51E898', '#FF78CB', '#669DF1', '#777777', '#888888', '#3e63dd', '#ff00aa']) {
      const tone = trelloLabelTone(hex);
      const a = luminance(tone);
      const b = luminance(trelloLabelText(tone));
      expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('exposes both looks as CSS vars', () => {
    expect(labelStyle('#F2D600')).toEqual({
      '--label-bg': '#F2D600',
      '--label-fg': '#18181b',
      '--label-bg-trello': '#7F5F01',
      '--label-fg-trello': '#ffffff',
    } as never);
  });
});
