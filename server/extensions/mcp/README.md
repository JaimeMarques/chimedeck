# ChimeDeck MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that lets AI assistants — Claude, Cursor, and any other MCP-compatible client — take actions inside ChimeDeck on your behalf.

The server is a lightweight Bun subprocess (`server/extensions/mcp/index.ts`) that bridges MCP tool calls to ChimeDeck's REST API using your personal API token.

---

## Prerequisites

- [Bun](https://bun.sh/) ≥ 1.0 installed on the machine that will run the MCP server
- A running ChimeDeck instance (local or remote)
- Dependencies installed: `bun install` from the project root

---

## Generate an API Token

1. Open ChimeDeck in your browser and sign in.
2. Go to **User Settings → API Tokens**.
3. Click **Generate new token** and copy the value — it starts with `hf_`.

> Keep your token secret. Treat it like a password.

---

## Register in Claude Desktop

Edit `~/.claude/claude_desktop_config.json` (create it if it does not exist) and add the `chimedeck` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "chimedeck": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/server/extensions/mcp/index.ts"],
      "env": {
        "CHIMEDECK_TOKEN": "hf_your_token_here",
        "CHIMEDECK_API_URL": "http://localhost:3000"
      }
    }
  }
}
```

Replace `/absolute/path/to` with the actual path to this repository on your machine.
`CHIMEDECK_API_URL` defaults to `http://localhost:3000` — change it if your ChimeDeck instance is hosted elsewhere.

Restart Claude Desktop to pick up the change. The `chimedeck` tools will appear in Claude's tool list.

---

## Register in Cursor

Create or edit `.cursor/mcp.json` in your home directory (or at the project root for project-scoped config):

```json
{
  "mcpServers": {
    "chimedeck": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/server/extensions/mcp/index.ts"],
      "env": {
        "CHIMEDECK_TOKEN": "hf_your_token_here",
        "CHIMEDECK_API_URL": "http://localhost:3000"
      }
    }
  }
}
```

Reload Cursor after saving the file.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `CHIMEDECK_TOKEN` | ✅ Yes | — | API token generated in User Settings |
| `CHIMEDECK_API_URL` | No | `http://localhost:3000` | Base URL of the ChimeDeck API |

The server exits immediately with a clear error message if `CHIMEDECK_TOKEN` is not set.

## Tool overview

`create_board` creates a board in a workspace; `create_list` creates a list on a board; and `create_card` creates a card in a list. These primitives remain separate so callers retain explicit, auditable control over bootstrap steps. See [Available Tools](#available-tools) for the complete endpoint catalogue and parameter reference.

List creation honours the board's existing writable-member permission checks. Agents should create workflow lists only on an explicitly scoped board.

Board coverage tools mirror the local Python `chimedeck-mcp` server: the same tool names and camelCase argument names, so agents switch servers without changes. Lookups (`get_me`, `list_workspaces`, `list_lists`, `list_labels`, `list_board_members`, …) resolve IDs before writing. Every write returns the object read back after the change (a fresh card, or the row found in its list/card read); deletes verify the object is gone and return a small confirmation. Every requested field is compared on the read-back: booleans, enums and roles exactly, due dates as instants, and text the way the server's handler stores it (trimmed, and passed through the server's own `sanitizeText`/`sanitizeRichText` where the handler sanitizes; an empty description is `null`). A read-back that disagrees with the request is an error (`readback-failed`, `delete-failed`), and a missing, HTML or wrong-shaped response is `invalid-response`, never success. A DELETE succeeds only with its route's real answer: `204 No Content` for lists, labels, checklists, checklist items, cards and card labels/members; `200 {data}` naming the deleted row for attachments and comments. Read tools advertise `readOnlyHint`; deletes and `archive_list` advertise `destructiveHint`.

Tools that take a parent ID (`cardId`, `boardId`) next to a child ID read the parent first and require the child to belong to it, by UUID or by a short ID the parent's rows expose (lists do; attachments and comments do not, so pass their UUIDs). On a mismatch they fail with `not-in-card` / `not-in-board` and send no write: the REST routes for checklists, checklist items, attachments, labels, lists and comments act on the child ID alone, on any card or board.

**Known limitation — archive toggles.** `PATCH /cards/:id/archive` and `PATCH /lists/:id/archive` toggle the stored state and ignore their body. `archive_card` and `archive_list` resolve the canonical UUID and current state first and only send the PATCH when the state differs, then re-read; a post-state other than the requested one is `archive-state-conflict`, never success. A concurrent toggle by another client between that read and the PATCH can still flip the object the other way; this cannot be closed from the MCP side. For the maintainer: an explicit `archived: boolean` body on those routes (set, not toggle) would make the operation atomic and idempotent.

---

## Run Manually (for testing)

```bash
CHIMEDECK_TOKEN=hf_... bun run server/extensions/mcp/index.ts
```

The server listens on **stdin/stdout** (MCP stdio transport) and is not intended to be run as a standalone HTTP server.

---

## Remote HTTP Transport

In addition to the local stdio subprocess, ChimeDeck exposes a persistent HTTP endpoint for MCP clients that cannot run a local subprocess (e.g., remote agents, CI environments, or web-based AI assistants).

### Endpoint

```
/api/mcp
```

Served on the **same port as the main ChimeDeck server** (default `3000`). No additional ports or environment variables are required.

### Authentication

Every request must include a valid `hf_` API token in the `Authorization` header:

```
Authorization: Bearer hf_your_token_here
```

Requests without a valid token are rejected with `401 Unauthorized` before any MCP logic runs.

### Session Lifecycle

1. **Initialize** — `POST /api/mcp` (no `mcp-session-id` header) creates a new isolated session and returns an `mcp-session-id` in the response headers.
2. **Interact** — subsequent `POST` requests (tool calls / notifications) or `GET` requests (SSE stream) must include the `mcp-session-id` header returned in step 1.
3. **Terminate** — `DELETE /api/mcp` with the session ID tears down the session immediately.

Sessions expire automatically after **30 minutes of inactivity**.

### curl Examples

#### 1. Initialize a session

```bash
curl -i -X POST http://localhost:3000/api/mcp \
  -H "Authorization: Bearer hf_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "my-agent", "version": "1.0.0" }
    }
  }'
```

The response headers will contain:

```
mcp-session-id: <uuid>
```

Copy this value for subsequent requests.

#### 2. Call a tool

```bash
SESSION_ID="<uuid-from-step-1>"

curl -X POST http://localhost:3000/api/mcp \
  -H "Authorization: Bearer hf_your_token_here" \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "write_comment",
      "arguments": { "cardId": "123", "text": "Done!" }
    }
  }'
```

#### 3. Open an SSE stream (server-sent events)

```bash
curl -N -X GET http://localhost:3000/api/mcp \
  -H "Authorization: Bearer hf_your_token_here" \
  -H "mcp-session-id: $SESSION_ID"
```

The connection stays open and the server pushes events as they occur.

#### 4. Terminate a session

```bash
curl -X DELETE http://localhost:3000/api/mcp \
  -H "Authorization: Bearer hf_your_token_here" \
  -H "mcp-session-id: $SESSION_ID"
```

Returns `204 No Content` on success.

### Error Responses

| Status | `name` | Meaning |
|---|---|---|
| `400` | `bad-request` | `mcp-session-id` header missing on a non-initialize request |
| `401` | `unauthorized` | Token absent or invalid |
| `403` | `forbidden` | Token belongs to a different user than the session owner |
| `404` | `session-not-found` | Session expired or never existed — re-initialize |

### stdio vs HTTP Transport Comparison

| Feature | stdio | Remote HTTP |
|---|---|---|
| **Transport** | stdin/stdout subprocess | HTTP/SSE (`/api/mcp`) |
| **Session scope** | One session per process | Many isolated sessions per server |
| **Authentication** | `CHIMEDECK_TOKEN` env var | `Authorization: Bearer hf_…` header |
| **Requires local install** | ✅ Yes (Bun + repo) | ❌ No — any HTTP client works |
| **Streaming (SSE)** | Via stdio protocol | Via `GET /api/mcp` SSE stream |
| **Session TTL** | Process lifetime | 30 min idle; explicit `DELETE` |
| **Multi-user** | One user per process | Each session is user-isolated |
| **Best for** | Claude Desktop, Cursor | Remote agents, CI, web UIs |

---

## Available Tools

| Tool | Description | Endpoint |
|---|---|---|
| `move_card` | Move a card to a different list, optionally after a specific card | `PATCH /api/v1/cards/:cardId/move` |
| `write_comment` | Post a comment on a card | `POST /api/v1/cards/:cardId/comments` |
| `create_board` | Create a board in a workspace | `POST /api/v1/workspaces/:workspaceId/boards` |
| `create_list` | Create a list on a board | `POST /api/v1/boards/:boardId/lists` |
| `create_card` | Create a new card in a list | `POST /api/v1/lists/:listId/cards` |
| `edit_card_description` | Update the description of a card | `PATCH /api/v1/cards/:cardId/description` |
| `set_card_price` | Set or clear the price on a card | `PATCH /api/v1/cards/:cardId/money` |
| `invite_to_board` | Invite a user to a board by email (requires board admin) | `POST /api/v1/boards/:boardId/members` |
| `search_cards` | Full-text search over cards within a workspace | `GET /api/v1/workspaces/:workspaceId/search` |
| `search_board` | Full-text search over cards and lists scoped to a single board | `GET /api/v1/boards/:boardId/search` |
| `get_card` | Retrieve the full details of a single card by its ID | `GET /api/v1/cards/:cardId` |
| `get_card_discussion` | Read top-level comments and their replies with completeness status | `GET /api/v1/cards/:cardId/comments` + `GET /api/v1/comments/:commentId/replies` |
| `get_comment_replies` | Read one parent's non-deleted direct replies | `GET /api/v1/comments/:commentId/replies` |
| `get_state_transitions` | Retrieve state transition graph and enabled flag for a board | `GET /api/v1/boards/:boardId/state-transitions` |
| `set_state_transitions` | Update state transition graph and/or enabled flag for a board | `PUT /api/v1/boards/:boardId/state-transitions` |
| `get_state_transition_rules` | Retrieve enforceable state-transition rules for a board | `GET /api/v1/boards/:boardId/state-transitions/rules` |
| `copy_state_transitions` | Copy state transition graph from one board to another | `POST /api/v1/boards/:boardId/state-transitions/copy` |
| `get_me` | Return the user the token belongs to | `GET /api/v1/users/me` |
| `list_workspaces` | List the workspaces the token can see | `GET /api/v1/workspaces` |
| `list_workspace_boards` | List the boards in a workspace | `GET /api/v1/workspaces/:workspaceId/boards` |
| `list_workspace_members` | List workspace members (userId, email, name, role) | `GET /api/v1/workspaces/:workspaceId/members` |
| `get_board` | Retrieve a board with its lists and cards | `GET /api/v1/boards/:boardId` |
| `list_lists` | List a board's lists in board order | `GET /api/v1/boards/:boardId/lists` |
| `list_labels` | List the labels defined on a board | `GET /api/v1/boards/:boardId/labels` |
| `list_board_members` | List board members (user_id, email, display_name, role) | `GET /api/v1/boards/:boardId/members` |
| `list_cards` | List the open cards in a list, in board order | `GET /api/v1/lists/:listId/cards` |
| `list_archived_cards` | List the archived cards on a board | `GET /api/v1/boards/:boardId/archived-cards` |
| `update_card` | Update a card's title, description, due date and/or completion tick | `PATCH /api/v1/cards/:cardId` |
| `set_card_due` | Set or clear a card's due date and completion tick | `PATCH /api/v1/cards/:cardId` |
| `archive_card` | Archive or restore a card | `PATCH /api/v1/cards/:cardId/archive` |
| `delete_card` | Permanently delete a card | `DELETE /api/v1/cards/:cardId` |
| `copy_card` | Copy a card into a list | `POST /api/v1/cards/:cardId/copy` |
| `get_comments` | List a card's top-level comments, oldest first | `GET /api/v1/cards/:cardId/comments` |
| `edit_comment` | Edit the text of an existing comment | `PATCH /api/v1/comments/:commentId` |
| `delete_comment` | Delete a comment (the server keeps a placeholder) | `DELETE /api/v1/comments/:commentId` |
| `get_attachments` | List the attachments on a card | `GET /api/v1/cards/:cardId/attachments` |
| `download_attachment` | Fetch an uploaded attachment's bytes (max 10 MB) | `GET /api/v1/attachments/:attachmentId/view` |
| `add_url_attachment` | Attach a link to a card | `POST /api/v1/cards/:cardId/attachments/url` |
| `delete_attachment` | Remove an attachment from a card | `DELETE /api/v1/attachments/:attachmentId` |
| `add_card_label` | Add an existing board label to a card | `POST /api/v1/cards/:cardId/labels` |
| `remove_card_label` | Remove a label from a card | `DELETE /api/v1/cards/:cardId/labels/:labelId` |
| `create_label` | Create a label on a board | `POST /api/v1/boards/:boardId/labels` |
| `delete_label` | Delete a board label from the board and every card | `DELETE /api/v1/labels/:labelId` |
| `add_card_member` | Assign a board member to a card | `POST /api/v1/cards/:cardId/members` |
| `remove_card_member` | Unassign a member from a card | `DELETE /api/v1/cards/:cardId/members/:userId` |
| `add_board_member` | Add a workspace member to a board by user ID (requires board admin) | `POST /api/v1/boards/:boardId/members` |
| `set_board_member_role` | Change an existing board member's role (requires board admin) | `PATCH /api/v1/boards/:boardId/members/:userId` |
| `create_checklist` | Create a checklist on a card | `POST /api/v1/cards/:cardId/checklists` |
| `add_checklist_item` | Add an item to a checklist | `POST /api/v1/checklists/:checklistId/items` |
| `set_checklist_item` | Check, uncheck or rename a checklist item | `PATCH /api/v1/checklist-items/:itemId` |
| `rename_checklist` | Rename a checklist | `PATCH /api/v1/checklists/:checklistId` |
| `delete_checklist` | Delete a checklist and all its items | `DELETE /api/v1/checklists/:checklistId` |
| `delete_checklist_item` | Delete one checklist item | `DELETE /api/v1/checklist-items/:itemId` |
| `rename_list` | Rename a list | `PATCH /api/v1/lists/:listId` |
| `archive_list` | Archive a list | `PATCH /api/v1/lists/:listId/archive` |
| `delete_list` | Permanently delete an empty list | `DELETE /api/v1/lists/:listId` |
| `update_board` | Update a board's title, description or visibility | `PATCH /api/v1/boards/:boardId` |

### Tool Parameters

#### `move_card`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card to move |
| `targetListId` | string | ✅ | ID of the destination list |
| `afterCardId` | string \| null | No | Insert after this card ID (`null` places at the top) |
| `position` | number | No | Deprecated alias. Only `0` is supported and maps to top |

#### `write_comment`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card to comment on |
| `content` | string | ✅ | Comment body text |
| `text` | string | No | Deprecated alias for `content` |

#### `create_board`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspaceId` | string | ✅ | ID of the workspace to create the board in |
| `title` | string | ✅ | Board title |
| `visibility` | `PRIVATE` \| `WORKSPACE` \| `PUBLIC` | No | Defaults to `PRIVATE` |
| `description` | string | No | Optional board description |
| `background` | string | No | Optional board background value |

The existing board API enforces workspace membership and makes the caller a board admin on success.

#### `create_list`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board to create the list on |
| `title` | string | ✅ | List title |
| `afterId` | string \| null | No | Optional list ID after which to insert; omit to append |

The existing list API enforces board writable-member permission checks.

#### `create_card`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `listId` | string | ✅ | ID of the list to create the card in |
| `title` | string | ✅ | Title of the new card |
| `description` | string | No | Optional card description |

#### `edit_card_description`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card to update |
| `description` | string | ✅ | New description text |

#### `set_card_price`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card |
| `amount` | number \| null | ✅ | Price amount, or `null` to clear the price |
| `currency` | string | No | ISO 4217 currency code (e.g. `USD`) |
| `label` | string | No | Display label for the price |

#### `invite_to_board`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board |
| `email` | string | ✅ | Email address of the user to invite |
| `role` | `"member"` \| `"admin"` | No | Role to assign (defaults to `"member"`) |

> **Note:** `invite_to_board` requires board-management permission. Permission failures are returned as structured API errors (for example, `insufficient-role`) instead of crashing.

#### `search_cards`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspaceId` | string | ✅ | ID of the workspace to search within |
| `query` | string | ✅ | Full-text search query |
| `q` | string | No | Deprecated alias for `query` |
| `limit` | number | No | Maximum number of results to return (default: 20) |

#### `search_board`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board to search within |
| `query` | string | ✅ | Full-text search query |
| `q` | string | No | Deprecated alias for `query` |
| `limit` | number | No | Maximum number of results to return |

#### `get_card`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card to retrieve |

#### `get_card_discussion`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | Card UUID or 8-character short ID |

Call this tool for a card's discussion; `get_card` is not a comment source.
It returns `{data, complete, issues}`. `data` is a flat array preserving every
comment field, including `parent_id`, body, author, timestamps and reactions.
Parents are oldest first, with each parent's oldest-first replies immediately
after it. Equal timestamps keep server order; this is thread order, not global
chronological order. Existing tools and response contracts are unchanged.

Always check `complete`. Failed reply reads, count mismatches and unexpected
response metadata produce `complete: false` and per-parent `issues`, while
successful threads are retained. An initial read failure or malformed root
response returns a normal MCP error. Unknown pagination metadata is reported;
no invented cursor or offset requests are sent.

The server currently supports one reply level and neither comment GET endpoint
is paginated. Deleted top-level placeholders are retained; deleted replies are
excluded by the API. Only positive `reply_count` parents trigger reply reads.
`complete` applies to the observed API responses, not an atomic snapshot:
concurrent comments/deletions can require a fresh read.

```json
{"name":"get_card_discussion","arguments":{"cardId":"<card UUID or short ID>"}}
```

#### `get_comment_replies`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `commentId` | UUID string | ✅ | Parent comment `id` from `get_card_discussion` |

Returns the same `{data, complete, issues}` envelope for non-deleted direct
replies, oldest first. UUIDs are case-insensitive. This tool does not verify
that the requested comment is top-level; a reply itself has no children under
the current one-level contract. A failed standalone read is an MCP error.

Both readers are registered for stdio and HTTP sessions with `readOnlyHint`.
They use the session's caller token and existing REST authorization, and issue
GETs only. Reconnect existing MCP sessions after deploying to reload the tool
catalogue; clients with an explicit tool allowlist must add both names.

#### `get_state_transitions`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board |

#### `set_state_transitions`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board |
| `enabled` | boolean | No | Enable or disable state transition enforcement |
| `graph` | object | No | State transition graph payload |

At least one of `enabled` or `graph` must be provided.

#### `get_state_transition_rules`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board |

#### `copy_state_transitions`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | Source board ID |
| `targetBoardId` | string | ✅ | Target board ID |
| `copyEnabled` | boolean | No | Copy source board's `enabled` flag when `true` |

#### `get_me`
No parameters.

#### `list_workspaces`
No parameters.

#### `list_workspace_boards`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspaceId` | string | ✅ | ID of the workspace |

#### `list_workspace_members`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspaceId` | string | ✅ | ID of the workspace |

#### `get_board`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | Board UUID or the short ID from its URL |

#### `list_lists`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board |

#### `list_labels`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board |

#### `list_board_members`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board |

#### `list_cards`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `listId` | string | ✅ | ID of the list |
| `limit` | integer | No | Maximum number of cards to return (min 1) |
| `offset` | integer | No | Number of cards to skip (min 0) |

Archived cards are not included; use `list_archived_cards`.

#### `list_archived_cards`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board |

#### `update_card`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card |
| `title` | string | No | New title |
| `description` | string | No | New description |
| `dueDate` | string \| null | No | ISO-8601 due date; `null` or empty string clears it |
| `dueComplete` | boolean | No | Mark the due date complete (the visible tick) or not |

Give at least one field, otherwise the tool fails with `nothing-to-update` before any request. The PATCH body uses the server's snake_case fields (`due_date`, `due_complete`). Returns the card read back with its includes; `title`, `description`, `due_date` and `due_complete` must read back as written (`readback-failed` otherwise).

#### `set_card_due`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card |
| `dueDate` | string \| null | No | ISO-8601 due date; `null` or empty string clears it |
| `dueComplete` | boolean | No | Mark complete (`true`) or not (`false`) |

Give `dueDate`, `dueComplete` or both (`nothing-to-update` otherwise). `dueDate` is sent as a UTC instant, so a bare date means UTC midnight. Returns the card read back with its includes.

#### `archive_card`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card |
| `archived` | boolean | No | `true` to archive (default), `false` to restore |

The server route toggles, so the tool reads the card first (a short ID resolves to the UUID used for every later request) and only PATCHes when its state differs from `archived`. Returns the card read back; a post-state other than `archived` is `archive-state-conflict` (see the known limitation above).

#### `delete_card`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card |

Destructive. Prefer `archive_card`. Requires a `204` DELETE, verifies the card now returns 404 and returns `{deleted: true, id, title}`.

#### `copy_card`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card to copy |
| `targetListId` | string | ✅ | ID of the destination list |
| `title` | string | No | Title for the copy (defaults to the original) |
| `keepChecklists` | boolean | No | Copy checklists too |
| `keepMembers` | boolean | No | Copy members too |

Returns the new card read back with its includes.

#### `get_comments`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card |

Replies are not included; use `get_card_discussion`.

#### `edit_comment`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card the comment is on |
| `commentId` | string | ✅ | ID of the comment |
| `content` | string | ✅ | New comment text |

The comment must be on `cardId` (top level or a reply; `not-in-card` otherwise, no PATCH sent). Returns the comment read back from the card's top-level comments, or for a reply from its parent's replies; its content must match the sanitized, trimmed text.

#### `delete_comment`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card the comment is on |
| `commentId` | string | ✅ | ID of the comment |

Destructive. The comment must be on `cardId` (`not-in-card` otherwise, no DELETE sent). The server soft-deletes: for a top-level comment the tool requires the re-read row to have `deleted: true` and returns that `[deleted]` placeholder; a deleted reply must be absent from its parent's replies, and the tool returns `{deleted: true, id}`.

#### `get_attachments`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card |

#### `download_attachment`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card the attachment is on |
| `attachmentId` | string | ✅ | ID of the attachment (from `get_attachments`) |

The attachment must be on `cardId` (`not-in-card` otherwise). Returns the attachment metadata as text, then the file as an image block for `image/*` types or an embedded resource with a base64 blob and `mimeType` otherwise. Nothing is written to the server's disk. Files over 10 MB fail with `attachment-too-large`; link attachments fail with `not-a-file`; an upload that is not finished fails with `not-ready`; any non-200 view response fails with `http-<status>`.

#### `add_url_attachment`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card |
| `url` | string | ✅ | Link URL |
| `name` | string | No | Display name (defaults to the URL) |

The server requires a name, so an omitted `name` is sent as the URL. Returns the attachment read back from the card's attachment list.

#### `delete_attachment`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card the attachment is on |
| `attachmentId` | string | ✅ | ID of the attachment |

Destructive. The attachment must be on `cardId` (`not-in-card` otherwise, no DELETE sent). Verifies the attachment is absent from the card's attachment list.

#### `add_card_label`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card |
| `labelId` | string | ✅ | ID of the label (see `list_labels`) |

Returns the card read back; the label must appear in its includes.

#### `remove_card_label`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card |
| `labelId` | string | ✅ | ID of the label |

Returns the card read back; the label must be gone from its includes.

#### `create_label`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board |
| `name` | string | ✅ | Label name (must not be empty) |
| `color` | string | ✅ | Hex color, e.g. `#0079BF` |

Returns the label read back from the board's label list.

#### `delete_label`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board the label belongs to |
| `labelId` | string | ✅ | ID of the label |

Destructive. The label must be on `boardId` (`not-in-board` otherwise, no DELETE sent). Verifies the label is absent from the board's label list.

#### `add_card_member`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card |
| `userId` | string | ✅ | User ID (see `list_board_members`) |

Returns the card read back; the member must appear in its includes.

#### `remove_card_member`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card |
| `userId` | string | ✅ | User ID |

Returns the card read back; the member must be gone from its includes.

#### `add_board_member`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board |
| `userId` | string | ✅ | User ID (see `list_workspace_members`) |
| `role` | `"admin"` \| `"member"` | No | Role to assign (defaults to `"member"`) |

An existing member fails with `board-member-exists`; use `set_board_member_role`. Returns the member row read back from the board roster.

#### `set_board_member_role`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board |
| `userId` | string | ✅ | User ID (see `list_board_members`) |
| `role` | `"admin"` \| `"member"` | ✅ | New role |

Demoting the last admin fails with `last-board-admin`. Returns the member row read back with the new role.

#### `create_checklist`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card |
| `title` | string | ✅ | Checklist title |

Returns `{checklist, items, card}` read back from the card.

#### `add_checklist_item`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `checklistId` | string | ✅ | ID of the checklist |
| `title` | string | ✅ | Item text |

Returns `{item, card}` read back from the card.

#### `set_checklist_item`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `itemId` | string | ✅ | ID of the checklist item |
| `checked` | boolean | No | `true` to tick, `false` to untick |
| `title` | string | No | New item text |

Give `checked`, `title` or both (`nothing-to-update` otherwise). Returns `{item, card}`; the item must read back with the requested `checked` and trimmed `title`.

#### `rename_checklist`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `checklistId` | string | ✅ | ID of the checklist |
| `title` | string | ✅ | New title |

Returns `{checklist, items, card}`; the checklist must read back with the trimmed title.

#### `delete_checklist`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card the checklist is on |
| `checklistId` | string | ✅ | ID of the checklist |

Destructive. The checklist must be on `cardId` (`not-in-card` otherwise, no DELETE sent). Verifies the checklist is absent from the card and returns `{deleted: true, id}`.

#### `delete_checklist_item`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `cardId` | string | ✅ | ID of the card the item is on |
| `itemId` | string | ✅ | ID of the checklist item |

Destructive. The item must be on `cardId` (`not-in-card` otherwise, no DELETE sent). Verifies the item is absent from the card and returns `{deleted: true, id}`.

#### `rename_list`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board the list is on |
| `listId` | string | ✅ | ID of the list |
| `title` | string | ✅ | New title |

The list (open or archived, by UUID or short ID) must be on `boardId` (`not-in-board` otherwise, no PATCH sent). Returns the list read back from the board's lists; its title must match the sanitized, trimmed text.

#### `archive_list`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board the list is on |
| `listId` | string | ✅ | ID of the list |

The tool finds the list among the board's open and archived lists (by UUID or short ID; `not-in-board` otherwise). The server route toggles, so a list already archived is returned without a PATCH, and the PATCH uses the UUID. Returns the list read back from the archived lists; anything else is `archive-state-conflict` (see the known limitation above).

#### `delete_list`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board the list is on |
| `listId` | string | ✅ | ID of the list |

Destructive. Prefer `archive_list`. The server refuses a list that still has cards (`delete-requires-confirmation`); this tool sends no confirmation, matching the local Python server. The list (open or archived) must be on `boardId` (`not-in-board` otherwise, no DELETE sent); the DELETE must answer `204`. Verifies the list is absent from both the board's open and archived lists and returns `{deleted: true, id}`.

#### `update_board`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `boardId` | string | ✅ | ID of the board |
| `title` | string | No | New title |
| `description` | string | No | New description |
| `visibility` | `PRIVATE` \| `WORKSPACE` \| `PUBLIC` | No | New visibility |

Give at least one field (`nothing-to-update` otherwise). Returns the board read back; every given field must match (`readback-failed` otherwise).
