import { expect, test } from 'bun:test';
import type { Attachment } from '~/extensions/Attachments/types';
import { dehydrateCommentAttachmentMarkdown, hydrateCommentAttachmentMarkdown } from './attachmentMarkdown';

const images = [1, 2].map((number) => ({
  id: `11111111-1111-4111-8111-11111111111${String(number)}`, name: 'image.png', type: 'FILE',
  upload_context: 'comment', view_url: `/api/v1/attachments/image-${String(number)}/view`, thumbnail_url: null,
} as Attachment));

test('same filename images retain distinct stable IDs through save and reload', () => {
  const markdown = images.map((image) => `![image.png](${image.view_url ?? ''})`).join('\n');
  const stored = dehydrateCommentAttachmentMarkdown(markdown, images);
  expect(stored).toContain(`attachment:id:${images[0]?.id ?? ''}`);
  expect(stored).toContain(`attachment:id:${images[1]?.id ?? ''}`);
  expect(hydrateCommentAttachmentMarkdown(stored, images)).toBe(markdown);
});

test('existing filename placeholders and HTML image placeholders still hydrate', () => {
  expect(hydrateCommentAttachmentMarkdown('![image.png](attachment:image.png)', images))
    .toBe(`![image.png](${images[0]?.view_url ?? ''})`);
  expect(hydrateCommentAttachmentMarkdown('<img src="attachment:image.png">', images))
    .toBe(`<img src="${images[0]?.view_url ?? ''}">`);
});

test('an unknown proxy URL never substitutes a same-filename card attachment', () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const oldCardImage = { ...images[0], upload_context: 'card' } as Attachment;
  const markdown = `![image.png](/api/v1/attachments/${id}/view)`;
  expect(dehydrateCommentAttachmentMarkdown(markdown, [oldCardImage]))
    .toBe(markdown);
});
