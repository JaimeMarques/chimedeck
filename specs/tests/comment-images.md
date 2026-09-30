# Comment image uploads

Use a disposable local board and local S3/LocalStack storage. Do not run these
write scenarios on a production board.

1. Paste or select two distinct images both named image.png; post a comment,
   reload, edit it and add a reply with another image. Each image must retain
   its correct contents. Card attachment counts, the attachment panel and
   attachment-added activity must exclude these comment images.
2. Repeat with an image larger than 5 MB to exercise multipart upload.
3. Upload an ordinary card attachment and a non-image file from the comment
   picker. Existing attachment panel, counts and activity must still work.
4. Cancel an editor, remove a queued upload, and leave a confirmed image
   unposted for more than an hour. Confirmed draft images must remain available
   for later submission/offline replay for thirty days from confirmation; older
   unposted uploads expire. Unfinished uploads expire one hour after
   creation; removed/deleted-comment images expire one hour after abandonment.
   Published images survive cleanup; re-adding a removed image before expiry
   clears its abandonment marker.
5. With scanning enabled, post immediately after upload confirmation. The
   comment must be accepted while its image awaits scanning; a pending JSON
   response must never be assigned as an image blob. Keep a comment open for
   more than thirty seconds while the scan is pending; it must show processing
   text and recover without reopening once ready. A ready image displays,
   and rejected or unfinished uploads cannot be claimed as comment images.
6. Try another author's upload, another card's image, a normal card attachment
   ID, and an image already associated with another comment. Other authors,
   cards and claimed comment images must be rejected; ordinary same-card
   attachments remain references and must never be claimed. A denied multipart
   completion must make no S3 mutation.
7. Read an existing filename-based image comment, rerender its attachment prop
   with a fresh array, and force an authenticated image fetch failure. The
   image must keep a valid proxy source and never retain a revoked blob URL.

Automated proof: `bun test server/extensions/comment/api/images.test.ts
src/common/utils/attachmentMarkdown.test.ts
src/extensions/Comment/components/__tests__/commentItemRender.test.ts`.
The actual editor drop/submit and already-uploaded offline replay regression is
`bun test src/extensions/Comment/components/__tests__/commentEditorUpload.test.tsx`.
Handler fixtures isolate authentication, database and S3 dependencies; they do
not prove a deployed migration or a full application/LocalStack integration.
The isolated browser fixture mounted the real CommentItem and verified image
dimensions after initial load, rerender, fetch failure and unmount.
