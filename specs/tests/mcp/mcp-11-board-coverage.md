# MCP 11. Board coverage tools

The hosted server exposes the 40 board, card, comment, attachment, label,
member, checklist and list/board tools of the local Python `chimedeck-mcp`
server, with the same tool and camelCase argument names. Write steps create
and delete data: run them only on a disposable instance or a scratch board.
Production acceptance is limited to the read tools (step 2).

1. Start a fresh stdio MCP session, or authenticate a fresh `/api/mcp` HTTP
   session. `tools/list` must return 60 tools with unique names, including all
   40 board coverage names. Read tools carry `readOnlyHint: true`; `delete_*`
   tools and `archive_list` carry `destructiveHint: true`.
2. Reads: call `get_me`, `list_workspaces`, `list_workspace_boards`,
   `list_workspace_members`, `get_board` (UUID, then short ID), `list_lists`,
   `list_labels`, `list_board_members`, `list_cards` (with and without
   `limit`/`offset`), `list_archived_cards`, `get_comments` and
   `get_attachments`. Each returns the API data; an inaccessible ID is an MCP
   error, not an empty success.
3. Card edits on a scratch card: `update_card` with `dueDate` and
   `dueComplete` must change the card (the PATCH body is `due_date` /
   `due_complete`); `set_card_due` with `null` clears it. Calling either with
   no field fails with `nothing-to-update` before any request. `archive_card`
   twice with `archived: true` must leave the card archived (the server route
   toggles); `archived: false` restores it. `copy_card` returns the new card.
4. Labels and members: `create_label`, `add_card_label`, `remove_card_label`,
   `delete_label`; `add_card_member`, `remove_card_member`. Each write returns
   the object read back and the card includes reflect the change.
   `add_board_member` for an existing member fails with
   `board-member-exists`; `set_board_member_role` accepts `admin` / `member`
   only and demoting the last admin fails with `last-board-admin`.
5. Comments: `edit_comment` returns the edited row; `delete_comment` returns
   the `[deleted]` placeholder with `deleted: true`.
6. Attachments: `add_url_attachment` (with `name`) returns the new row;
   `download_attachment` on it fails with `not-a-file`. On an uploaded image,
   it returns metadata text plus an image block; on another file type, an
   embedded resource with a base64 blob. A file over 10 MB fails with
   `attachment-too-large`. Nothing is written to the server's disk.
   `delete_attachment` removes the row.
7. Checklists: `create_checklist`, `add_checklist_item`,
   `set_checklist_item` (check, then rename), `rename_checklist`,
   `delete_checklist_item`, `delete_checklist`; each returns the read-back
   shape documented in the MCP README.
8. Lists and board: `rename_list`; `archive_list` twice must leave the list
   archived; `delete_list` on an empty list returns `{deleted: true, id}` and
   on a list with cards fails with `delete-requires-confirmation`;
   `update_board` with `visibility` returns the board with that visibility.
9. Verify every outbound call carries the current caller's token rather than
   the process fallback token, and no MCP output or error echoes a token.

Automated protocol/HTTP proof (isolated subprocesses, local REST fixture, no
external services):

```bash
bun test server/extensions/mcp
```

The fixture asserts exact methods, paths and bodies, read-back use, API error
names, `invalid-response` for null and HTML-200 bodies, and token redaction.
