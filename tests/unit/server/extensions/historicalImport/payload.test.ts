import { describe, expect, it } from 'bun:test';
import { exactHistoricalCommentContent } from '../../../../../server/extensions/historicalImport/core/payload';

describe('exactHistoricalCommentContent', () => {
  it('returns a representable historical string unchanged', () => {
    const content = '  <img src="x" onerror="historical()">\r\n@alice  ';

    expect(exactHistoricalCommentContent({ content })).toBe(content);
  });

  it('fails closed for missing or PostgreSQL-TEXT-unrepresentable content', () => {
    expect(() => exactHistoricalCommentContent({})).toThrow(
      'historical comment payload requires string content'
    );
    expect(() => exactHistoricalCommentContent({ content: 'not representable\u0000' })).toThrow(
      'historical comment content is not representable by PostgreSQL text: contains U+0000'
    );
    expect(() => exactHistoricalCommentContent({ content: '\ud800' })).toThrow(
      'historical comment content is not representable by PostgreSQL text: contains an unpaired UTF-16 surrogate'
    );
  });
});
