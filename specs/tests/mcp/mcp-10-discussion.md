# MCP 10. Read a threaded discussion

Use an existing test card with an unthreaded comment and a parent with two
non-deleted replies. Run against a disposable instance when provisioning data;
production acceptance must be GET-only and must not post test comments.

1. Start a fresh stdio MCP session, or authenticate a fresh `/api/mcp` HTTP
   session. `tools/list` must include `get_card_discussion` and
   `get_comment_replies`, both annotated `readOnlyHint: true`.
2. Call `get_card_discussion` with `{ "cardId": "<card UUID>" }`, then the
   card's short ID. Both must return `{data, complete: true, issues: []}`.
   Check bodies, authors, reactions and `parent_id`, with oldest-first parents
   and each parent's oldest-first replies immediately after it. An unthreaded
   parent must remain present. `get_card` is not a discussion source.
3. Call `get_comment_replies` with the parent's UUID, including uppercase UUID
   letters. Verify only that parent's replies appear, oldest first, and the
   parent relation remains canonical. Deleted replies are outside this read
   contract; deleted top-level placeholders remain available.
4. With an inaccessible card/comment, verify a normal MCP error rather than
   an empty successful discussion. Invalid comment UUIDs must fail before HTTP.
5. In the local HTTP fixture, force one reply read to fail while another
   succeeds. Require `complete: false`, a parent-scoped issue, retained parents
   and the successful thread. A count mismatch in either direction must also
   mark the result incomplete.
6. In the fixture, add unexpected metadata/cursor fields to either response.
   Require `unrecognized-envelope`, no guessed pagination requests, and no
   requests to metadata-provided URLs. Both current REST routes are unpaginated
   and creation forbids replies to replies.
7. Verify all outbound calls are GET, carry the current caller's token rather
   than the process fallback token, and never echo a token in MCP output.

Automated protocol/HTTP proof (isolated subprocesses, no external services):

```bash
bun test server/extensions/mcp/tools/readDiscussion.test.ts
```

Reads across endpoints are not atomic snapshots. `complete` means the observed
responses agree with the documented contract and reply counts; re-read after
concurrent comment edits.
