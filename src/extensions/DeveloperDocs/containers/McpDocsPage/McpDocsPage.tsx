// McpDocsPage — developer reference for the ChimeDeck MCP server.
// Route: /developer/mcp (private, within AppShell)
import { useNavigate } from 'react-router-dom';
import config from '~/config';
import {
  CommandLineIcon,
  KeyIcon,
  BoltIcon,
  ServerStackIcon,
} from '@heroicons/react/24/outline';
import {
  Section, H2, H3, P, Code, Pre, Divider, Badge,
  InfoCallout, WarnCallout, Table, NavItem, inlineCodeClass,
} from '~/extensions/DeveloperDocs/components/DocsPrimitives';

// ─── Page ──────────────────────────────────────────────────────────────────────

const McpDocsPage = () => {
  const navigate = useNavigate();
  const appUrl = config.appUrl || 'APP_URL';

  return (
    <div className="flex min-h-screen bg-bg-base text-base">
      {/* ── Left TOC ─────────────────────────────────────── */}
      <aside className="hidden w-56 shrink-0 border-r border-border bg-bg-base xl:block">
        <div className="sticky top-0 overflow-y-auto py-8 px-3">
          <p className="mb-3 px-2 text-xs font-semibold uppercase tracking-wider text-muted">
            On this page
          </p>
          <nav className="space-y-0.5">
            <NavItem href="#overview" label="Overview" />
            <NavItem href="#authentication" label="Authentication" />
            <NavItem href="#connecting" label="Connecting" />
            <NavItem href="#endpoint-reference" label="Endpoint Reference" />
            <NavItem href="#available-tools" label="Available Tools" />
            <NavItem href="#tool-details" label="Tool Details" />
            <NavItem href="#tool-move-card" label="move_card" />
            <NavItem href="#tool-write-comment" label="write_comment" />
            <NavItem href="#tool-create-board" label="create_board" />
            <NavItem href="#tool-create-list" label="create_list" />
            <NavItem href="#tool-create-card" label="create_card" />
            <NavItem href="#tool-edit-card-description" label="edit_card_description" />
            <NavItem href="#tool-set-card-price" label="set_card_price" />
            <NavItem href="#tool-invite-to-board" label="invite_to_board" />
            <NavItem href="#tool-search-cards" label="search_cards" />
            <NavItem href="#tool-search-board" label="search_board" />
            <NavItem href="#tool-get-card" label="get_card" />
            <NavItem href="#tool-get-card-discussion" label="get_card_discussion" />
            <NavItem href="#tool-get-comment-replies" label="get_comment_replies" />
            <NavItem href="#tool-get-state-transitions" label="get_state_transitions" />
            <NavItem href="#tool-set-state-transitions" label="set_state_transitions" />
            <NavItem href="#tool-get-state-transition-rules" label="get_state_transition_rules" />
            <NavItem href="#tool-copy-state-transitions" label="copy_state_transitions" />
            <NavItem href="#tool-get-me" label="get_me" />
            <NavItem href="#tool-list-workspaces" label="list_workspaces" />
            <NavItem href="#tool-list-workspace-boards" label="list_workspace_boards" />
            <NavItem href="#tool-list-workspace-members" label="list_workspace_members" />
            <NavItem href="#tool-get-board" label="get_board" />
            <NavItem href="#tool-list-lists" label="list_lists" />
            <NavItem href="#tool-list-labels" label="list_labels" />
            <NavItem href="#tool-list-board-members" label="list_board_members" />
            <NavItem href="#tool-list-cards" label="list_cards" />
            <NavItem href="#tool-list-archived-cards" label="list_archived_cards" />
            <NavItem href="#tool-update-card" label="update_card" />
            <NavItem href="#tool-set-card-due" label="set_card_due" />
            <NavItem href="#tool-archive-card" label="archive_card" />
            <NavItem href="#tool-delete-card" label="delete_card" />
            <NavItem href="#tool-copy-card" label="copy_card" />
            <NavItem href="#tool-get-comments" label="get_comments" />
            <NavItem href="#tool-edit-comment" label="edit_comment" />
            <NavItem href="#tool-delete-comment" label="delete_comment" />
            <NavItem href="#tool-get-attachments" label="get_attachments" />
            <NavItem href="#tool-download-attachment" label="download_attachment" />
            <NavItem href="#tool-add-url-attachment" label="add_url_attachment" />
            <NavItem href="#tool-delete-attachment" label="delete_attachment" />
            <NavItem href="#tool-add-card-label" label="add_card_label" />
            <NavItem href="#tool-remove-card-label" label="remove_card_label" />
            <NavItem href="#tool-create-label" label="create_label" />
            <NavItem href="#tool-delete-label" label="delete_label" />
            <NavItem href="#tool-add-card-member" label="add_card_member" />
            <NavItem href="#tool-remove-card-member" label="remove_card_member" />
            <NavItem href="#tool-add-board-member" label="add_board_member" />
            <NavItem href="#tool-set-board-member-role" label="set_board_member_role" />
            <NavItem href="#tool-create-checklist" label="create_checklist" />
            <NavItem href="#tool-add-checklist-item" label="add_checklist_item" />
            <NavItem href="#tool-set-checklist-item" label="set_checklist_item" />
            <NavItem href="#tool-rename-checklist" label="rename_checklist" />
            <NavItem href="#tool-delete-checklist" label="delete_checklist" />
            <NavItem href="#tool-delete-checklist-item" label="delete_checklist_item" />
            <NavItem href="#tool-rename-list" label="rename_list" />
            <NavItem href="#tool-archive-list" label="archive_list" />
            <NavItem href="#tool-delete-list" label="delete_list" />
            <NavItem href="#tool-update-board" label="update_board" />
          </nav>
        </div>
      </aside>

      {/* ── Main content ─────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto">
        {/* Header */}
        <div className="border-b border-border bg-bg-base px-8 py-5">
          <button
            onClick={() => { navigate(-1); }}
            className="mb-2 flex items-center gap-1 text-sm text-muted hover:text-subtle"
          >
            ← Back
          </button>
          <div className="flex items-center gap-3">
            <CommandLineIcon className="h-7 w-7 text-indigo-400" />
            <div>
              <h1 className="text-2xl font-bold text-base">MCP Server Developer Guide</h1>
              <p className="text-sm text-muted">
                Connect AI assistants to ChimeDeck using the{' '}
                <Code>Model Context Protocol</Code> (MCP).
              </p>
            </div>
          </div>
        </div>

        <div className="mx-auto max-w-3xl px-8 py-10 space-y-2">

          {/* ── Overview ───────────────────────────────────── */}
          <Section id="overview">
            <InfoCallout className="mb-6">
              The ChimeDeck MCP server lets AI assistants — Claude, Cursor, and any
              MCP-compatible client — take actions inside ChimeDeck on your behalf. It bridges
              MCP tool calls to ChimeDeck's REST API using your personal API token.
            </InfoCallout>
            <P>
              The server supports two transport modes:
            </P>
            <ol className="mb-4 space-y-2 text-sm text-subtle">
              {[
                '<strong>stdio</strong> — a local Bun subprocess that communicates over stdin/stdout. Best for Claude Desktop and Cursor.',
                `<strong>Remote HTTP</strong> — a persistent HTTP endpoint (<code class="${inlineCodeClass}">/api/mcp</code>) served on the same port as ChimeDeck. Best for remote agents, CI, and web-based AI assistants.`,
              ].map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-700 text-xs font-bold text-inverse">
                    {i + 1}
                  </span>
                  <span dangerouslySetInnerHTML={{ __html: step }} />
                </li>
              ))}
            </ol>
          </Section>

          <Divider />

          {/* ── Authentication ─────────────────────────────── */}
          <Section id="authentication">
            <H2>
              <KeyIcon className="mr-2 inline h-5 w-5 text-indigo-400" />
              Authentication
            </H2>
            <P>
              All MCP access requires a personal API token. Tokens are prefixed with{' '}
              <Code>hf_</Code> and are generated in User Settings.
            </P>

            <H3>Generate a token</H3>
            <ol className="mb-4 space-y-2 text-sm text-subtle">
              {[
                'Open ChimeDeck in your browser and sign in.',
                'Go to <strong>User Settings → API Tokens</strong>.',
                'Click <strong>Generate new token</strong> and copy the value.',
              ].map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-700 text-xs font-bold text-inverse">
                    {i + 1}
                  </span>
                  <span dangerouslySetInnerHTML={{ __html: step }} />
                </li>
              ))}
            </ol>
            <WarnCallout>
              <strong>Keep your token secret.</strong> Treat it like a password. Anyone who has
              it can perform any action on your behalf.
            </WarnCallout>

            <H3>Using the token</H3>
            <Table
              headers={['Transport', 'How to supply the token']}
              rows={[
                {
                  rowId: 'auth-stdio',
                  cells: [
                    { key: 'transport', content: <Badge color="bg-bg-overlay text-subtle">stdio</Badge> },
                    { key: 'how', content: <><Code>CHIMEDECK_TOKEN</Code> environment variable</> },
                  ],
                },
                {
                  rowId: 'auth-http',
                  cells: [
                    { key: 'transport', content: <Badge color="bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300">HTTP</Badge> },
                    { key: 'how', content: <><Code>Authorization: Bearer hf_your_token_here</Code> request header</> },
                  ],
                },
              ]}
            />
          </Section>

          <Divider />

          {/* ── Connecting ─────────────────────────────────── */}
          <Section id="connecting">
            <H2>
              <BoltIcon className="mr-2 inline h-5 w-5 text-indigo-400" />
              Connecting
            </H2>
            <P>
              The ChimeDeck MCP server runs as a remote HTTP endpoint — you do not need to install
              anything locally. Point your AI client at the server URL and supply your API token
              as a bearer header.
            </P>

            <H3>Claude Desktop</H3>
            <P>
              Edit <Code>~/.claude/claude_desktop_config.json</Code> (create it if it does not
              exist) and add the <Code>chimedeck</Code> entry under <Code>mcpServers</Code>:
            </P>
            <Pre>{`{
  "mcpServers": {
    "chimedeck": {
      "url": "${appUrl}/api/mcp",
      "headers": {
        "Authorization": "Bearer hf_your_token_here"
      }
    }
  }
}`}</Pre>
            <P>
              Restart Claude Desktop to pick up the change.
              Restart Claude Desktop to pick up the change.
            </P>

            <H3>Cursor</H3>
            <P>
              Create or edit <Code>~/.cursor/mcp.json</Code> (or <Code>.cursor/mcp.json</Code> at
              the project root for project-scoped config):
            </P>
            <Pre>{`{
  "mcpServers": {
    "chimedeck": {
      "url": "${appUrl}/api/mcp",
      "headers": {
        "Authorization": "Bearer hf_your_token_here"
      }
    }
  }
}`}</Pre>
            <P>Reload Cursor after saving the file.</P>

            <H3>Other MCP clients</H3>
            <P>
              Any MCP-compatible client that supports remote HTTP / SSE transport can connect.
              Configure the endpoint URL to <Code>{appUrl}/api/mcp</Code>{' '}
              and pass <Code>Authorization: Bearer hf_your_token_here</Code> as a request header.
            </P>
          </Section>

          <Divider />

          {/* ── Endpoint Reference ─────────────────────────── */}
          <Section id="endpoint-reference">
            <H2>
              <ServerStackIcon className="mr-2 inline h-5 w-5 text-indigo-400" />
              Endpoint Reference (Remote HTTP)
            </H2>
            <P>
              The HTTP MCP endpoint is served at <Code>/api/mcp</Code> on the same port as
              ChimeDeck (default <Code>3000</Code>). No additional ports or env vars are required.
            </P>

            <H3>Session lifecycle</H3>
            <ol className="mb-4 space-y-2 text-sm text-subtle">
              {[
                `<strong>Initialize</strong> — <code class="${inlineCodeClass}">POST /api/mcp</code> (no <code class="${inlineCodeClass}">mcp-session-id</code> header) creates a new isolated session. The response returns an <code class="${inlineCodeClass}">mcp-session-id</code> header.`,
                `<strong>Interact</strong> — subsequent <code class="${inlineCodeClass}">POST</code> requests (tool calls / notifications) or <code class="${inlineCodeClass}">GET</code> requests (SSE stream) must include the <code class="${inlineCodeClass}">mcp-session-id</code> header.`,
                `<strong>Terminate</strong> — <code class="${inlineCodeClass}">DELETE /api/mcp</code> with the session ID tears down the session immediately.`,
              ].map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-700 text-xs font-bold text-inverse">
                    {i + 1}
                  </span>
                  <span dangerouslySetInnerHTML={{ __html: step }} />
                </li>
              ))}
            </ol>
            <P>Sessions expire automatically after <strong>30 minutes</strong> of inactivity.</P>

            <H3>curl examples</H3>
            <P>1. Initialize a session:</P>
            <Pre>{`curl -i -X POST http://localhost:3000/api/mcp \\
  -H "Authorization: Bearer hf_your_token_here" \\
  -H "Content-Type: application/json" \\
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

# Response headers will include:
# mcp-session-id: <uuid>`}</Pre>

            <P>2. Call a tool:</P>
            <Pre>{`SESSION_ID="<uuid-from-step-1>"

curl -X POST http://localhost:3000/api/mcp \\
  -H "Authorization: Bearer hf_your_token_here" \\
  -H "Content-Type: application/json" \\
  -H "mcp-session-id: $SESSION_ID" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "write_comment",
      "arguments": { "cardId": "123", "text": "Done!" }
    }
  }'`}</Pre>

            <P>3. Open an SSE stream:</P>
            <Pre>{`curl -N -X GET http://localhost:3000/api/mcp \\
  -H "Authorization: Bearer hf_your_token_here" \\
  -H "mcp-session-id: $SESSION_ID"`}</Pre>

            <P>4. Terminate a session:</P>
            <Pre>{`curl -X DELETE http://localhost:3000/api/mcp \\
  -H "Authorization: Bearer hf_your_token_here" \\
  -H "mcp-session-id: $SESSION_ID"
# Returns 204 No Content`}</Pre>

            <H3>Error responses</H3>
            <Table
              headers={['Status', 'name', 'Meaning']}
              rows={[
                {
                  rowId: 'err-400',
                  cells: [
                    { key: 'status', content: <Badge color="bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300">400</Badge> },
                    { key: 'name', content: <Code>bad-request</Code> },
                    { key: 'meaning', content: 'mcp-session-id header missing on a non-initialize request' },
                  ],
                },
                {
                  rowId: 'err-401',
                  cells: [
                    { key: 'status', content: <Badge color="bg-red-100 dark:bg-red-900/60 text-red-700 dark:text-red-300">401</Badge> },  // [theme-exception]
                    { key: 'name', content: <Code>unauthorized</Code> },
                    { key: 'meaning', content: 'Token absent or invalid' },
                  ],
                },
                {
                  rowId: 'err-403',
                  cells: [
                    { key: 'status', content: <Badge color="bg-red-100 dark:bg-red-900/60 text-red-700 dark:text-red-300">403</Badge> },  // [theme-exception]
                    { key: 'name', content: <Code>forbidden</Code> },
                    { key: 'meaning', content: 'Token belongs to a different user than the session owner' },
                  ],
                },
                {
                  rowId: 'err-404',
                  cells: [
                    { key: 'status', content: <Badge color="bg-bg-overlay text-subtle">404</Badge> },
                    { key: 'name', content: <Code>session-not-found</Code> },
                    { key: 'meaning', content: 'Session expired or never existed — re-initialize' },
                  ],
                },
              ]}
            />
          </Section>

          <Divider />

          {/* ── Available Tools ────────────────────────────── */}
          <Section id="available-tools">
            <H2>Available Tools</H2>
            <P>
              Each tool maps to a specific REST API endpoint. The board coverage tools (from <Code>get_me</Code> on) use the same names and arguments as the local Python <Code>chimedeck-mcp</Code> server, and every write returns the object read back after the change.
            </P>
            <Table
              headers={['Tool', 'Description', 'Endpoint']}
              rows={[
                {
                  rowId: 'tool-move-card',
                  cells: [
                    { key: 'tool', content: <Code>move_card</Code> },
                    { key: 'desc', content: 'Move a card to a different list, optionally at a specific position' },
                    { key: 'endpoint', content: <Code>PATCH /api/v1/cards/:cardId/move</Code> },
                  ],
                },
                {
                  rowId: 'tool-write-comment',
                  cells: [
                    { key: 'tool', content: <Code>write_comment</Code> },
                    { key: 'desc', content: 'Post a comment on a card' },
                    { key: 'endpoint', content: <Code>POST /api/v1/cards/:cardId/comments</Code> },
                  ],
                },
                {
                  rowId: 'tool-create-board',
                  cells: [
                    { key: 'tool', content: <Code>create_board</Code> },
                    { key: 'desc', content: 'Create a board in a workspace' },
                    { key: 'endpoint', content: <Code>POST /api/v1/workspaces/:workspaceId/boards</Code> },
                  ],
                },
                {
                  rowId: 'tool-create-list',
                  cells: [
                    { key: 'tool', content: <Code>create_list</Code> },
                    { key: 'desc', content: 'Create a new list on a board' },
                    { key: 'endpoint', content: <Code>POST /api/v1/boards/:boardId/lists</Code> },
                  ],
                },
                {
                  rowId: 'tool-create-card',
                  cells: [
                    { key: 'tool', content: <Code>create_card</Code> },
                    { key: 'desc', content: 'Create a new card in a list' },
                    { key: 'endpoint', content: <Code>POST /api/v1/lists/:listId/cards</Code> },
                  ],
                },
                {
                  rowId: 'tool-edit-card-description',
                  cells: [
                    { key: 'tool', content: <Code>edit_card_description</Code> },
                    { key: 'desc', content: 'Update the description of a card' },
                    { key: 'endpoint', content: <Code>PATCH /api/v1/cards/:cardId/description</Code> },
                  ],
                },
                {
                  rowId: 'tool-set-card-price',
                  cells: [
                    { key: 'tool', content: <Code>set_card_price</Code> },
                    { key: 'desc', content: 'Set or clear the price on a card' },
                    { key: 'endpoint', content: <Code>PATCH /api/v1/cards/:cardId/money</Code> },
                  ],
                },
                {
                  rowId: 'tool-invite-to-board',
                  cells: [
                    { key: 'tool', content: <Code>invite_to_board</Code> },
                    { key: 'desc', content: 'Invite a user to a board by email (requires board admin)' },
                    { key: 'endpoint', content: <Code>POST /api/v1/boards/:boardId/members</Code> },
                  ],
                },
                {
                  rowId: 'tool-search-cards',
                  cells: [
                    { key: 'tool', content: <Code>search_cards</Code> },
                    { key: 'desc', content: 'Full-text search over cards within a workspace' },
                    { key: 'endpoint', content: <Code>GET /api/v1/workspaces/:workspaceId/search</Code> },
                  ],
                },
                {
                  rowId: 'tool-search-board',
                  cells: [
                    { key: 'tool', content: <Code>search_board</Code> },
                    { key: 'desc', content: 'Full-text search over cards and lists scoped to a single board' },
                    { key: 'endpoint', content: <Code>GET /api/v1/boards/:boardId/search</Code> },
                  ],
                },
                {
                  rowId: 'tool-get-card',
                  cells: [
                    { key: 'tool', content: <Code>get_card</Code> },
                    { key: 'desc', content: 'Retrieve the full details of a single card by its ID' },
                    { key: 'endpoint', content: <Code>GET /api/v1/cards/:cardId</Code> },
                  ],
                },
                {
                  rowId: 'tool-get-card-discussion',
                  cells: [
                    { key: 'tool', content: <Code>get_card_discussion</Code> },
                    { key: 'desc', content: 'Read comments and replies with explicit completeness status' },
                    { key: 'endpoint', content: <Code>GET /api/v1/cards/:cardId/comments + GET /api/v1/comments/:commentId/replies</Code> },
                  ],
                },
                {
                  rowId: 'tool-get-comment-replies',
                  cells: [
                    { key: 'tool', content: <Code>get_comment_replies</Code> },
                    { key: 'desc', content: 'Read one parent’s non-deleted direct replies' },
                    { key: 'endpoint', content: <Code>GET /api/v1/comments/:commentId/replies</Code> },
                  ],
                },
                {
                  rowId: 'tool-get-state-transitions',
                  cells: [
                    { key: 'tool', content: <Code>get_state_transitions</Code> },
                    { key: 'desc', content: 'Retrieve state transition graph and enabled flag for a board' },
                    { key: 'endpoint', content: <Code>GET /api/v1/boards/:boardId/state-transitions</Code> },
                  ],
                },
                {
                  rowId: 'tool-set-state-transitions',
                  cells: [
                    { key: 'tool', content: <Code>set_state_transitions</Code> },
                    { key: 'desc', content: 'Update state transition graph and/or enabled flag for a board' },
                    { key: 'endpoint', content: <Code>PUT /api/v1/boards/:boardId/state-transitions</Code> },
                  ],
                },
                {
                  rowId: 'tool-get-state-transition-rules',
                  cells: [
                    { key: 'tool', content: <Code>get_state_transition_rules</Code> },
                    { key: 'desc', content: 'Retrieve enforceable state-transition rules for a board' },
                    { key: 'endpoint', content: <Code>GET /api/v1/boards/:boardId/state-transitions/rules</Code> },
                  ],
                },
                {
                  rowId: 'tool-copy-state-transitions',
                  cells: [
                    { key: 'tool', content: <Code>copy_state_transitions</Code> },
                    { key: 'desc', content: 'Copy state transition graph from one board to another' },
                    { key: 'endpoint', content: <Code>POST /api/v1/boards/:boardId/state-transitions/copy</Code> },
                  ],
                },
                {
                  rowId: 'tool-get-me',
                  cells: [
                    { key: 'tool', content: <Code>get_me</Code> },
                    { key: 'desc', content: 'Return the user the token belongs to' },
                    { key: 'endpoint', content: <Code>GET /api/v1/users/me</Code> },
                  ],
                },
                {
                  rowId: 'tool-list-workspaces',
                  cells: [
                    { key: 'tool', content: <Code>list_workspaces</Code> },
                    { key: 'desc', content: 'List the workspaces the token can see' },
                    { key: 'endpoint', content: <Code>GET /api/v1/workspaces</Code> },
                  ],
                },
                {
                  rowId: 'tool-list-workspace-boards',
                  cells: [
                    { key: 'tool', content: <Code>list_workspace_boards</Code> },
                    { key: 'desc', content: 'List the boards in a workspace' },
                    { key: 'endpoint', content: <Code>GET /api/v1/workspaces/:workspaceId/boards</Code> },
                  ],
                },
                {
                  rowId: 'tool-list-workspace-members',
                  cells: [
                    { key: 'tool', content: <Code>list_workspace_members</Code> },
                    { key: 'desc', content: 'List workspace members (userId, email, name, role)' },
                    { key: 'endpoint', content: <Code>GET /api/v1/workspaces/:workspaceId/members</Code> },
                  ],
                },
                {
                  rowId: 'tool-get-board',
                  cells: [
                    { key: 'tool', content: <Code>get_board</Code> },
                    { key: 'desc', content: 'Retrieve a board with its lists and cards' },
                    { key: 'endpoint', content: <Code>GET /api/v1/boards/:boardId</Code> },
                  ],
                },
                {
                  rowId: 'tool-list-lists',
                  cells: [
                    { key: 'tool', content: <Code>list_lists</Code> },
                    { key: 'desc', content: 'List a board\'s lists in board order' },
                    { key: 'endpoint', content: <Code>GET /api/v1/boards/:boardId/lists</Code> },
                  ],
                },
                {
                  rowId: 'tool-list-labels',
                  cells: [
                    { key: 'tool', content: <Code>list_labels</Code> },
                    { key: 'desc', content: 'List the labels defined on a board' },
                    { key: 'endpoint', content: <Code>GET /api/v1/boards/:boardId/labels</Code> },
                  ],
                },
                {
                  rowId: 'tool-list-board-members',
                  cells: [
                    { key: 'tool', content: <Code>list_board_members</Code> },
                    { key: 'desc', content: 'List board members (user_id, email, display_name, role)' },
                    { key: 'endpoint', content: <Code>GET /api/v1/boards/:boardId/members</Code> },
                  ],
                },
                {
                  rowId: 'tool-list-cards',
                  cells: [
                    { key: 'tool', content: <Code>list_cards</Code> },
                    { key: 'desc', content: 'List the open cards in a list, in board order' },
                    { key: 'endpoint', content: <Code>GET /api/v1/lists/:listId/cards</Code> },
                  ],
                },
                {
                  rowId: 'tool-list-archived-cards',
                  cells: [
                    { key: 'tool', content: <Code>list_archived_cards</Code> },
                    { key: 'desc', content: 'List the archived cards on a board' },
                    { key: 'endpoint', content: <Code>GET /api/v1/boards/:boardId/archived-cards</Code> },
                  ],
                },
                {
                  rowId: 'tool-update-card',
                  cells: [
                    { key: 'tool', content: <Code>update_card</Code> },
                    { key: 'desc', content: 'Update a card\'s title, description, due date and/or completion tick' },
                    { key: 'endpoint', content: <Code>PATCH /api/v1/cards/:cardId</Code> },
                  ],
                },
                {
                  rowId: 'tool-set-card-due',
                  cells: [
                    { key: 'tool', content: <Code>set_card_due</Code> },
                    { key: 'desc', content: 'Set or clear a card\'s due date and completion tick' },
                    { key: 'endpoint', content: <Code>PATCH /api/v1/cards/:cardId</Code> },
                  ],
                },
                {
                  rowId: 'tool-archive-card',
                  cells: [
                    { key: 'tool', content: <Code>archive_card</Code> },
                    { key: 'desc', content: 'Archive or restore a card' },
                    { key: 'endpoint', content: <Code>PATCH /api/v1/cards/:cardId/archive</Code> },
                  ],
                },
                {
                  rowId: 'tool-delete-card',
                  cells: [
                    { key: 'tool', content: <Code>delete_card</Code> },
                    { key: 'desc', content: 'Permanently delete a card' },
                    { key: 'endpoint', content: <Code>DELETE /api/v1/cards/:cardId</Code> },
                  ],
                },
                {
                  rowId: 'tool-copy-card',
                  cells: [
                    { key: 'tool', content: <Code>copy_card</Code> },
                    { key: 'desc', content: 'Copy a card into a list' },
                    { key: 'endpoint', content: <Code>POST /api/v1/cards/:cardId/copy</Code> },
                  ],
                },
                {
                  rowId: 'tool-get-comments',
                  cells: [
                    { key: 'tool', content: <Code>get_comments</Code> },
                    { key: 'desc', content: 'List a card\'s top-level comments, oldest first' },
                    { key: 'endpoint', content: <Code>GET /api/v1/cards/:cardId/comments</Code> },
                  ],
                },
                {
                  rowId: 'tool-edit-comment',
                  cells: [
                    { key: 'tool', content: <Code>edit_comment</Code> },
                    { key: 'desc', content: 'Edit the text of an existing comment' },
                    { key: 'endpoint', content: <Code>PATCH /api/v1/comments/:commentId</Code> },
                  ],
                },
                {
                  rowId: 'tool-delete-comment',
                  cells: [
                    { key: 'tool', content: <Code>delete_comment</Code> },
                    { key: 'desc', content: 'Delete a comment (the server keeps a placeholder)' },
                    { key: 'endpoint', content: <Code>DELETE /api/v1/comments/:commentId</Code> },
                  ],
                },
                {
                  rowId: 'tool-get-attachments',
                  cells: [
                    { key: 'tool', content: <Code>get_attachments</Code> },
                    { key: 'desc', content: 'List the attachments on a card' },
                    { key: 'endpoint', content: <Code>GET /api/v1/cards/:cardId/attachments</Code> },
                  ],
                },
                {
                  rowId: 'tool-download-attachment',
                  cells: [
                    { key: 'tool', content: <Code>download_attachment</Code> },
                    { key: 'desc', content: 'Fetch an uploaded attachment\'s bytes (max 10 MB)' },
                    { key: 'endpoint', content: <Code>GET /api/v1/attachments/:attachmentId/view</Code> },
                  ],
                },
                {
                  rowId: 'tool-add-url-attachment',
                  cells: [
                    { key: 'tool', content: <Code>add_url_attachment</Code> },
                    { key: 'desc', content: 'Attach a link to a card' },
                    { key: 'endpoint', content: <Code>POST /api/v1/cards/:cardId/attachments/url</Code> },
                  ],
                },
                {
                  rowId: 'tool-delete-attachment',
                  cells: [
                    { key: 'tool', content: <Code>delete_attachment</Code> },
                    { key: 'desc', content: 'Remove an attachment from a card' },
                    { key: 'endpoint', content: <Code>DELETE /api/v1/attachments/:attachmentId</Code> },
                  ],
                },
                {
                  rowId: 'tool-add-card-label',
                  cells: [
                    { key: 'tool', content: <Code>add_card_label</Code> },
                    { key: 'desc', content: 'Add an existing board label to a card' },
                    { key: 'endpoint', content: <Code>POST /api/v1/cards/:cardId/labels</Code> },
                  ],
                },
                {
                  rowId: 'tool-remove-card-label',
                  cells: [
                    { key: 'tool', content: <Code>remove_card_label</Code> },
                    { key: 'desc', content: 'Remove a label from a card' },
                    { key: 'endpoint', content: <Code>DELETE /api/v1/cards/:cardId/labels/:labelId</Code> },
                  ],
                },
                {
                  rowId: 'tool-create-label',
                  cells: [
                    { key: 'tool', content: <Code>create_label</Code> },
                    { key: 'desc', content: 'Create a label on a board' },
                    { key: 'endpoint', content: <Code>POST /api/v1/boards/:boardId/labels</Code> },
                  ],
                },
                {
                  rowId: 'tool-delete-label',
                  cells: [
                    { key: 'tool', content: <Code>delete_label</Code> },
                    { key: 'desc', content: 'Delete a board label from the board and every card' },
                    { key: 'endpoint', content: <Code>DELETE /api/v1/labels/:labelId</Code> },
                  ],
                },
                {
                  rowId: 'tool-add-card-member',
                  cells: [
                    { key: 'tool', content: <Code>add_card_member</Code> },
                    { key: 'desc', content: 'Assign a board member to a card' },
                    { key: 'endpoint', content: <Code>POST /api/v1/cards/:cardId/members</Code> },
                  ],
                },
                {
                  rowId: 'tool-remove-card-member',
                  cells: [
                    { key: 'tool', content: <Code>remove_card_member</Code> },
                    { key: 'desc', content: 'Unassign a member from a card' },
                    { key: 'endpoint', content: <Code>DELETE /api/v1/cards/:cardId/members/:userId</Code> },
                  ],
                },
                {
                  rowId: 'tool-add-board-member',
                  cells: [
                    { key: 'tool', content: <Code>add_board_member</Code> },
                    { key: 'desc', content: 'Add a workspace member to a board by user ID (requires board admin)' },
                    { key: 'endpoint', content: <Code>POST /api/v1/boards/:boardId/members</Code> },
                  ],
                },
                {
                  rowId: 'tool-set-board-member-role',
                  cells: [
                    { key: 'tool', content: <Code>set_board_member_role</Code> },
                    { key: 'desc', content: 'Change an existing board member\'s role (requires board admin)' },
                    { key: 'endpoint', content: <Code>PATCH /api/v1/boards/:boardId/members/:userId</Code> },
                  ],
                },
                {
                  rowId: 'tool-create-checklist',
                  cells: [
                    { key: 'tool', content: <Code>create_checklist</Code> },
                    { key: 'desc', content: 'Create a checklist on a card' },
                    { key: 'endpoint', content: <Code>POST /api/v1/cards/:cardId/checklists</Code> },
                  ],
                },
                {
                  rowId: 'tool-add-checklist-item',
                  cells: [
                    { key: 'tool', content: <Code>add_checklist_item</Code> },
                    { key: 'desc', content: 'Add an item to a checklist' },
                    { key: 'endpoint', content: <Code>POST /api/v1/checklists/:checklistId/items</Code> },
                  ],
                },
                {
                  rowId: 'tool-set-checklist-item',
                  cells: [
                    { key: 'tool', content: <Code>set_checklist_item</Code> },
                    { key: 'desc', content: 'Check, uncheck or rename a checklist item' },
                    { key: 'endpoint', content: <Code>PATCH /api/v1/checklist-items/:itemId</Code> },
                  ],
                },
                {
                  rowId: 'tool-rename-checklist',
                  cells: [
                    { key: 'tool', content: <Code>rename_checklist</Code> },
                    { key: 'desc', content: 'Rename a checklist' },
                    { key: 'endpoint', content: <Code>PATCH /api/v1/checklists/:checklistId</Code> },
                  ],
                },
                {
                  rowId: 'tool-delete-checklist',
                  cells: [
                    { key: 'tool', content: <Code>delete_checklist</Code> },
                    { key: 'desc', content: 'Delete a checklist and all its items' },
                    { key: 'endpoint', content: <Code>DELETE /api/v1/checklists/:checklistId</Code> },
                  ],
                },
                {
                  rowId: 'tool-delete-checklist-item',
                  cells: [
                    { key: 'tool', content: <Code>delete_checklist_item</Code> },
                    { key: 'desc', content: 'Delete one checklist item' },
                    { key: 'endpoint', content: <Code>DELETE /api/v1/checklist-items/:itemId</Code> },
                  ],
                },
                {
                  rowId: 'tool-rename-list',
                  cells: [
                    { key: 'tool', content: <Code>rename_list</Code> },
                    { key: 'desc', content: 'Rename a list' },
                    { key: 'endpoint', content: <Code>PATCH /api/v1/lists/:listId</Code> },
                  ],
                },
                {
                  rowId: 'tool-archive-list',
                  cells: [
                    { key: 'tool', content: <Code>archive_list</Code> },
                    { key: 'desc', content: 'Archive a list' },
                    { key: 'endpoint', content: <Code>PATCH /api/v1/lists/:listId/archive</Code> },
                  ],
                },
                {
                  rowId: 'tool-delete-list',
                  cells: [
                    { key: 'tool', content: <Code>delete_list</Code> },
                    { key: 'desc', content: 'Permanently delete an empty list' },
                    { key: 'endpoint', content: <Code>DELETE /api/v1/lists/:listId</Code> },
                  ],
                },
                {
                  rowId: 'tool-update-board',
                  cells: [
                    { key: 'tool', content: <Code>update_board</Code> },
                    { key: 'desc', content: 'Update a board\'s title, description or visibility' },
                    { key: 'endpoint', content: <Code>PATCH /api/v1/boards/:boardId</Code> },
                  ],
                },
              ]}
            />
          </Section>

          <Divider />

          {/* ── Tool Details ───────────────────────────────── */}
          <Section id="tool-details">
            <H2>Tool Details</H2>
            <P>
              Each tool accepts a JSON object of parameters. Required fields are marked with ✅.
            </P>
          </Section>

          {/* move_card */}
          <Section id="tool-move-card">
            <H3>move_card</H3>
            <P>Move a card to a different list. Optionally specify a zero-based position within the target list.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'mc-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card to move' },
                  ],
                },
                {
                  rowId: 'mc-targetListId',
                  cells: [
                    { key: 'param', content: <Code>targetListId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the destination list' },
                  ],
                },
                {
                  rowId: 'mc-position',
                  cells: [
                    { key: 'param', content: <Code>position</Code> },
                    { key: 'type', content: 'number' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'Zero-based position within the target list' },
                  ],
                },
              ]}
            />
          </Section>

          {/* write_comment */}
          <Section id="tool-write-comment">
            <H3>write_comment</H3>
            <P>Post a comment on a card.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'wc-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card to comment on' },
                  ],
                },
                {
                  rowId: 'wc-text',
                  cells: [
                    { key: 'param', content: <Code>text</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'Comment body text' },
                  ],
                },
              ]}
            />
          </Section>

          {/* create_board */}
          <Section id="tool-create-board">
            <H3>create_board</H3>
            <P>Create a board in a workspace. Existing API authorization enforces workspace membership and defaults visibility to <Code>PRIVATE</Code>.</P>
            <Table headers={['Parameter', 'Type', 'Required', 'Description']} rows={[
              { rowId: 'cb-workspaceId', cells: [{ key: 'param', content: <Code>workspaceId</Code> }, { key: 'type', content: 'string' }, { key: 'req', content: '✅' }, { key: 'desc', content: 'Target workspace ID' }] },
              { rowId: 'cb-title', cells: [{ key: 'param', content: <Code>title</Code> }, { key: 'type', content: 'string' }, { key: 'req', content: '✅' }, { key: 'desc', content: 'Board title' }] },
              { rowId: 'cb-visibility', cells: [{ key: 'param', content: <Code>visibility</Code> }, { key: 'type', content: 'PRIVATE | WORKSPACE | PUBLIC' }, { key: 'req', content: 'No' }, { key: 'desc', content: 'Defaults to PRIVATE' }] },
              { rowId: 'cb-description', cells: [{ key: 'param', content: <Code>description</Code> }, { key: 'type', content: 'string' }, { key: 'req', content: 'No' }, { key: 'desc', content: 'Optional description' }] },
              { rowId: 'cb-background', cells: [{ key: 'param', content: <Code>background</Code> }, { key: 'type', content: 'string' }, { key: 'req', content: 'No' }, { key: 'desc', content: 'Optional background value' }] },
            ]} />
          </Section>

          {/* create_list */}
          <Section id="tool-create-list">
            <H3>create_list</H3>
            <P>Create a list on a board. Existing API authorization enforces board writable-member permission.</P>
            <Table headers={['Parameter', 'Type', 'Required', 'Description']} rows={[
              { rowId: 'cl-boardId', cells: [{ key: 'param', content: <Code>boardId</Code> }, { key: 'type', content: 'string' }, { key: 'req', content: '✅' }, { key: 'desc', content: 'Target board ID' }] },
              { rowId: 'cl-title', cells: [{ key: 'param', content: <Code>title</Code> }, { key: 'type', content: 'string' }, { key: 'req', content: '✅' }, { key: 'desc', content: 'List title' }] },
              { rowId: 'cl-afterId', cells: [{ key: 'param', content: <Code>afterId</Code> }, { key: 'type', content: 'string | null' }, { key: 'req', content: 'No' }, { key: 'desc', content: 'Optional insertion anchor' }] },
            ]} />
          </Section>

          {/* create_card */}
          <Section id="tool-create-card">
            <H3>create_card</H3>
            <P>Create a new card in a list.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'cc-listId',
                  cells: [
                    { key: 'param', content: <Code>listId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the list to create the card in' },
                  ],
                },
                {
                  rowId: 'cc-title',
                  cells: [
                    { key: 'param', content: <Code>title</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'Title of the new card' },
                  ],
                },
                {
                  rowId: 'cc-description',
                  cells: [
                    { key: 'param', content: <Code>description</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'Optional card description' },
                  ],
                },
              ]}
            />
          </Section>

          {/* edit_card_description */}
          <Section id="tool-edit-card-description">
            <H3>edit_card_description</H3>
            <P>Update the description of an existing card.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'ecd-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card to update' },
                  ],
                },
                {
                  rowId: 'ecd-description',
                  cells: [
                    { key: 'param', content: <Code>description</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'New description text' },
                  ],
                },
              ]}
            />
          </Section>

          {/* set_card_price */}
          <Section id="tool-set-card-price">
            <H3>set_card_price</H3>
            <P>Set or clear the price on a card. Pass <Code>null</Code> for <Code>amount</Code> to remove the price.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'scp-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card' },
                  ],
                },
                {
                  rowId: 'scp-amount',
                  cells: [
                    { key: 'param', content: <Code>amount</Code> },
                    { key: 'type', content: 'number | null' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'Price amount, or null to clear the price' },
                  ],
                },
                {
                  rowId: 'scp-currency',
                  cells: [
                    { key: 'param', content: <Code>currency</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'ISO 4217 currency code (e.g. USD)' },
                  ],
                },
                {
                  rowId: 'scp-label',
                  cells: [
                    { key: 'param', content: <Code>label</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'Display label for the price' },
                  ],
                },
              ]}
            />
          </Section>

          {/* invite_to_board */}
          <Section id="tool-invite-to-board">
            <H3>invite_to_board</H3>
            <P>Invite a user to a board by email. Requires board-management permission.</P>
            <WarnCallout className="mb-3">
              <strong>Access control:</strong> Workspace ADMIN/OWNER or explicit board ADMIN
              permission is required. Failures return a structured API error such as{' '}
              <Code>insufficient-role</Code> instead of crashing.
            </WarnCallout>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'itb-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the board' },
                  ],
                },
                {
                  rowId: 'itb-email',
                  cells: [
                    { key: 'param', content: <Code>email</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'Email address of the user to invite' },
                  ],
                },
                {
                  rowId: 'itb-role',
                  cells: [
                    { key: 'param', content: <Code>role</Code> },
                    { key: 'type', content: '"member" | "admin"' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'Role to assign (defaults to "member")' },
                  ],
                },
              ]}
            />
          </Section>

          {/* search_cards */}
          <Section id="tool-search-cards">
            <H3>search_cards</H3>
            <P>Full-text search over all cards within a workspace. Returns matching cards with title, list, and board context.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'sc-workspaceId',
                  cells: [
                    { key: 'param', content: <Code>workspaceId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the workspace to search within' },
                  ],
                },
                {
                  rowId: 'sc-q',
                  cells: [
                    { key: 'param', content: <Code>q</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'Full-text search query' },
                  ],
                },
                {
                  rowId: 'sc-limit',
                  cells: [
                    { key: 'param', content: <Code>limit</Code> },
                    { key: 'type', content: 'number' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'Maximum number of results to return (default: 20)' },
                  ],
                },
              ]}
            />
          </Section>

          {/* search_board */}
          <Section id="tool-search-board">
            <H3>search_board</H3>
            <P>Full-text search over cards and lists scoped to a single board.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'sb-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the board to search within' },
                  ],
                },
                {
                  rowId: 'sb-q',
                  cells: [
                    { key: 'param', content: <Code>q</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'Full-text search query' },
                  ],
                },
                {
                  rowId: 'sb-limit',
                  cells: [
                    { key: 'param', content: <Code>limit</Code> },
                    { key: 'type', content: 'number' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'Maximum number of results to return' },
                  ],
                },
              ]}
            />
          </Section>

          {/* get_card */}
          <Section id="tool-get-card">
            <H3>get_card</H3>
            <P>Retrieve the full details of a single card by its ID, including title, description, list, price, labels, and members.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'gc-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card to retrieve' },
                  ],
                },
              ]}
            />
          </Section>

          <Section id="tool-get-card-discussion">
            <H3>get_card_discussion</H3>
            <P>Read the complete discussion using a required <Code>cardId</Code> string (card UUID or short ID). Use this tool for comments; <Code>get_card</Code> is not a comment source.</P>
            <Pre>{`{"name":"get_card_discussion","arguments":{"cardId":"<card UUID or short ID>"}}`}</Pre>
            <P>Returns <Code>{'{data, complete, issues}'}</Code>. The flat array preserves author, body, timestamps, reactions and <Code>parent_id</Code>. Parents are oldest first, each followed by their oldest-first replies. Equal timestamps retain server order; threads are grouped rather than globally interleaved.</P>
            <WarnCallout>Check <Code>complete</Code> before treating results as exhaustive. Failed threads, changed reply counts and unexpected metadata set it to false with per-parent issues. Successful threads remain available; a failed initial read returns an MCP error.</WarnCallout>
            <P>The current API has one reply level and no pagination. Deleted parent placeholders remain, but deleted replies are unavailable. Reads are not an atomic snapshot; re-read after concurrent edits.</P>
          </Section>

          <Section id="tool-get-comment-replies">
            <H3>get_comment_replies</H3>
            <P>Read one parent’s non-deleted direct replies using a required <Code>commentId</Code> UUID string from <Code>get_card_discussion</Code>. UUID case is normalized. Returns the same <Code>{'{data, complete, issues}'}</Code> envelope, oldest first. The tool does not verify that the requested comment is top-level; a reply itself has no children. Failed reads return MCP errors.</P>
            <Pre>{`{"name":"get_comment_replies","arguments":{"commentId":"<parent comment UUID>"}}`}</Pre>
            <InfoCallout>Both tools are read-only and use your existing permissions in stdio and HTTP sessions. Reconnect after deployment and add both names if your client uses an explicit tool allowlist.</InfoCallout>
          </Section>

          {/* get_state_transitions */}
          <Section id="tool-get-state-transitions">
            <H3>get_state_transitions</H3>
            <P>Retrieve state transition graph and enabled flag for a board.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'gst-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the board' },
                  ],
                },
              ]}
            />
          </Section>

          {/* set_state_transitions */}
          <Section id="tool-set-state-transitions">
            <H3>set_state_transitions</H3>
            <P>Update state transition graph and/or enabled flag for a board.</P>
            <WarnCallout className="mb-3">
              Provide at least one of <Code>enabled</Code> or <Code>graph</Code>.
            </WarnCallout>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'sst-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the board' },
                  ],
                },
                {
                  rowId: 'sst-enabled',
                  cells: [
                    { key: 'param', content: <Code>enabled</Code> },
                    { key: 'type', content: 'boolean' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'Enable or disable state transition enforcement' },
                  ],
                },
                {
                  rowId: 'sst-graph',
                  cells: [
                    { key: 'param', content: <Code>graph</Code> },
                    { key: 'type', content: 'object' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'State transition graph payload' },
                  ],
                },
              ]}
            />
          </Section>

          {/* get_state_transition_rules */}
          <Section id="tool-get-state-transition-rules">
            <H3>get_state_transition_rules</H3>
            <P>Retrieve enforceable state-transition rules for a board.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'gstr-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the board' },
                  ],
                },
              ]}
            />
          </Section>

          {/* copy_state_transitions */}
          <Section id="tool-copy-state-transitions">
            <H3>copy_state_transitions</H3>
            <P>Copy state transition graph from one board to another.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'cst-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'Source board ID' },
                  ],
                },
                {
                  rowId: 'cst-targetBoardId',
                  cells: [
                    { key: 'param', content: <Code>targetBoardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'Target board ID' },
                  ],
                },
                {
                  rowId: 'cst-copyEnabled',
                  cells: [
                    { key: 'param', content: <Code>copyEnabled</Code> },
                    { key: 'type', content: 'boolean' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'Copy source board enabled flag when true' },
                  ],
                },
              ]}
            />
          </Section>

          {/* get_me */}
          <Section id="tool-get-me">
            <H3>get_me</H3>
            <P>Return the user the token belongs to.</P>
            <P>No parameters.</P>
          </Section>

          {/* list_workspaces */}
          <Section id="tool-list-workspaces">
            <H3>list_workspaces</H3>
            <P>List the workspaces the token can see.</P>
            <P>No parameters.</P>
          </Section>

          {/* list_workspace_boards */}
          <Section id="tool-list-workspace-boards">
            <H3>list_workspace_boards</H3>
            <P>List the boards in a workspace.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'lwb-workspaceId',
                  cells: [
                    { key: 'param', content: <Code>workspaceId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the workspace' },
                  ],
                },
              ]}
            />
          </Section>

          {/* list_workspace_members */}
          <Section id="tool-list-workspace-members">
            <H3>list_workspace_members</H3>
            <P>List workspace members (userId, email, name, role).</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'lwm-workspaceId',
                  cells: [
                    { key: 'param', content: <Code>workspaceId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the workspace' },
                  ],
                },
              ]}
            />
          </Section>

          {/* get_board */}
          <Section id="tool-get-board">
            <H3>get_board</H3>
            <P>Retrieve a board with its lists and cards.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'gb-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'Board UUID or the short ID from its URL' },
                  ],
                },
              ]}
            />
          </Section>

          {/* list_lists */}
          <Section id="tool-list-lists">
            <H3>list_lists</H3>
            <P>List a board’s lists in board order.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'll-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the board' },
                  ],
                },
              ]}
            />
          </Section>

          {/* list_labels */}
          <Section id="tool-list-labels">
            <H3>list_labels</H3>
            <P>List the labels defined on a board.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'llb-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the board' },
                  ],
                },
              ]}
            />
          </Section>

          {/* list_board_members */}
          <Section id="tool-list-board-members">
            <H3>list_board_members</H3>
            <P>List board members (user_id, email, display_name, role).</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'lbm-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the board' },
                  ],
                },
              ]}
            />
          </Section>

          {/* list_cards */}
          <Section id="tool-list-cards">
            <H3>list_cards</H3>
            <P>List the open cards in a list, in board order. Archived cards are not included; use <Code>list_archived_cards</Code>.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'lc-listId',
                  cells: [
                    { key: 'param', content: <Code>listId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the list' },
                  ],
                },
                {
                  rowId: 'lc-limit',
                  cells: [
                    { key: 'param', content: <Code>limit</Code> },
                    { key: 'type', content: 'integer' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'Maximum number of cards to return (min 1)' },
                  ],
                },
                {
                  rowId: 'lc-offset',
                  cells: [
                    { key: 'param', content: <Code>offset</Code> },
                    { key: 'type', content: 'integer' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'Number of cards to skip (min 0)' },
                  ],
                },
              ]}
            />
          </Section>

          {/* list_archived_cards */}
          <Section id="tool-list-archived-cards">
            <H3>list_archived_cards</H3>
            <P>List the archived cards on a board.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'lac-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the board' },
                  ],
                },
              ]}
            />
          </Section>

          {/* update_card */}
          <Section id="tool-update-card">
            <H3>update_card</H3>
            <P>Update a card’s title, description, due date and/or completion tick. Give at least one field, otherwise the tool fails with <Code>nothing-to-update</Code> before any request. The PATCH body uses the server’s snake_case fields (<Code>due_date</Code>, <Code>due_complete</Code>). Returns the card read back with its includes.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'uc-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card' },
                  ],
                },
                {
                  rowId: 'uc-title',
                  cells: [
                    { key: 'param', content: <Code>title</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'New title' },
                  ],
                },
                {
                  rowId: 'uc-description',
                  cells: [
                    { key: 'param', content: <Code>description</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'New description' },
                  ],
                },
                {
                  rowId: 'uc-dueDate',
                  cells: [
                    { key: 'param', content: <Code>dueDate</Code> },
                    { key: 'type', content: 'string | null' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'ISO-8601 due date; null or empty string clears it' },
                  ],
                },
                {
                  rowId: 'uc-dueComplete',
                  cells: [
                    { key: 'param', content: <Code>dueComplete</Code> },
                    { key: 'type', content: 'boolean' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'Mark the due date complete (the visible tick) or not' },
                  ],
                },
              ]}
            />
          </Section>

          {/* set_card_due */}
          <Section id="tool-set-card-due">
            <H3>set_card_due</H3>
            <P>Set or clear a card’s due date and completion tick. Give <Code>dueDate</Code>, <Code>dueComplete</Code> or both (<Code>nothing-to-update</Code> otherwise). Returns the card read back with its includes.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'scd-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card' },
                  ],
                },
                {
                  rowId: 'scd-dueDate',
                  cells: [
                    { key: 'param', content: <Code>dueDate</Code> },
                    { key: 'type', content: 'string | null' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'ISO-8601 due date; null or empty string clears it' },
                  ],
                },
                {
                  rowId: 'scd-dueComplete',
                  cells: [
                    { key: 'param', content: <Code>dueComplete</Code> },
                    { key: 'type', content: 'boolean' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'Mark complete (true) or not (false)' },
                  ],
                },
              ]}
            />
          </Section>

          {/* archive_card */}
          <Section id="tool-archive-card">
            <H3>archive_card</H3>
            <P>Archive or restore a card. The server route toggles, so the tool reads the card first and only PATCHes when its state differs from <Code>archived</Code>. Returns the card read back; a mismatch is <Code>readback-failed</Code>.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'ac-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card' },
                  ],
                },
                {
                  rowId: 'ac-archived',
                  cells: [
                    { key: 'param', content: <Code>archived</Code> },
                    { key: 'type', content: 'boolean' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'true to archive (default), false to restore' },
                  ],
                },
              ]}
            />
          </Section>

          {/* delete_card */}
          <Section id="tool-delete-card">
            <H3>delete_card</H3>
            <P>Permanently delete a card. Destructive. Prefer <Code>archive_card</Code>. Verifies the card now returns 404 and returns <Code>&#123;deleted: true, id, title&#125;</Code>.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'dc-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card' },
                  ],
                },
              ]}
            />
          </Section>

          {/* copy_card */}
          <Section id="tool-copy-card">
            <H3>copy_card</H3>
            <P>Copy a card into a list. Returns the new card read back with its includes.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'cc-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card to copy' },
                  ],
                },
                {
                  rowId: 'cc-targetListId',
                  cells: [
                    { key: 'param', content: <Code>targetListId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the destination list' },
                  ],
                },
                {
                  rowId: 'cc-title',
                  cells: [
                    { key: 'param', content: <Code>title</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'Title for the copy (defaults to the original)' },
                  ],
                },
                {
                  rowId: 'cc-keepChecklists',
                  cells: [
                    { key: 'param', content: <Code>keepChecklists</Code> },
                    { key: 'type', content: 'boolean' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'Copy checklists too' },
                  ],
                },
                {
                  rowId: 'cc-keepMembers',
                  cells: [
                    { key: 'param', content: <Code>keepMembers</Code> },
                    { key: 'type', content: 'boolean' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'Copy members too' },
                  ],
                },
              ]}
            />
          </Section>

          {/* get_comments */}
          <Section id="tool-get-comments">
            <H3>get_comments</H3>
            <P>List a card’s top-level comments, oldest first. Replies are not included; use <Code>get_card_discussion</Code>.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'gcm-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card' },
                  ],
                },
              ]}
            />
          </Section>

          {/* edit_comment */}
          <Section id="tool-edit-comment">
            <H3>edit_comment</H3>
            <P>Edit the text of an existing comment. Returns the comment read back from the card’s top-level comments, or for a reply from its parent’s replies.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'ec-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card the comment is on' },
                  ],
                },
                {
                  rowId: 'ec-commentId',
                  cells: [
                    { key: 'param', content: <Code>commentId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the comment' },
                  ],
                },
                {
                  rowId: 'ec-content',
                  cells: [
                    { key: 'param', content: <Code>content</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'New comment text' },
                  ],
                },
              ]}
            />
          </Section>

          {/* delete_comment */}
          <Section id="tool-delete-comment">
            <H3>delete_comment</H3>
            <P>Delete a comment (the server keeps a placeholder). Destructive. The server soft-deletes: for a top-level comment the tool requires the re-read row to have <Code>deleted: true</Code> and returns that <Code>[deleted]</Code> placeholder; a deleted reply must be absent from its parent’s replies, and the tool returns <Code>&#123;deleted: true, id&#125;</Code>.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'dcm-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card the comment is on' },
                  ],
                },
                {
                  rowId: 'dcm-commentId',
                  cells: [
                    { key: 'param', content: <Code>commentId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the comment' },
                  ],
                },
              ]}
            />
          </Section>

          {/* get_attachments */}
          <Section id="tool-get-attachments">
            <H3>get_attachments</H3>
            <P>List the attachments on a card.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'ga-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card' },
                  ],
                },
              ]}
            />
          </Section>

          {/* download_attachment */}
          <Section id="tool-download-attachment">
            <H3>download_attachment</H3>
            <P>Fetch an uploaded attachment’s bytes (max 10 MB). Returns the attachment metadata as text, then the file as an image block for <Code>image/*</Code> types or an embedded resource with a base64 blob and <Code>mimeType</Code> otherwise. Nothing is written to the server’s disk. Files over 10 MB fail with <Code>attachment-too-large</Code>; link attachments fail with <Code>not-a-file</Code>; an upload that is not finished fails with <Code>not-ready</Code>; any non-200 view response fails with <Code>http-&lt;status&gt;</Code>.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'da-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card the attachment is on' },
                  ],
                },
                {
                  rowId: 'da-attachmentId',
                  cells: [
                    { key: 'param', content: <Code>attachmentId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the attachment (from get_attachments)' },
                  ],
                },
              ]}
            />
          </Section>

          {/* add_url_attachment */}
          <Section id="tool-add-url-attachment">
            <H3>add_url_attachment</H3>
            <P>Attach a link to a card. The server requires a name, so an omitted <Code>name</Code> is sent as the URL. Returns the attachment read back from the card’s attachment list.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'aua-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card' },
                  ],
                },
                {
                  rowId: 'aua-url',
                  cells: [
                    { key: 'param', content: <Code>url</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'Link URL' },
                  ],
                },
                {
                  rowId: 'aua-name',
                  cells: [
                    { key: 'param', content: <Code>name</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'Display name' },
                  ],
                },
              ]}
            />
          </Section>

          {/* delete_attachment */}
          <Section id="tool-delete-attachment">
            <H3>delete_attachment</H3>
            <P>Remove an attachment from a card. Destructive. Verifies the attachment is absent from the card’s attachment list.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'dat-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card the attachment is on' },
                  ],
                },
                {
                  rowId: 'dat-attachmentId',
                  cells: [
                    { key: 'param', content: <Code>attachmentId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the attachment' },
                  ],
                },
              ]}
            />
          </Section>

          {/* add_card_label */}
          <Section id="tool-add-card-label">
            <H3>add_card_label</H3>
            <P>Add an existing board label to a card. Returns the card read back; the label must appear in its includes.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'acl-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card' },
                  ],
                },
                {
                  rowId: 'acl-labelId',
                  cells: [
                    { key: 'param', content: <Code>labelId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the label (see list_labels)' },
                  ],
                },
              ]}
            />
          </Section>

          {/* remove_card_label */}
          <Section id="tool-remove-card-label">
            <H3>remove_card_label</H3>
            <P>Remove a label from a card. Returns the card read back; the label must be gone from its includes.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'rcl-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card' },
                  ],
                },
                {
                  rowId: 'rcl-labelId',
                  cells: [
                    { key: 'param', content: <Code>labelId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the label' },
                  ],
                },
              ]}
            />
          </Section>

          {/* create_label */}
          <Section id="tool-create-label">
            <H3>create_label</H3>
            <P>Create a label on a board. Returns the label read back from the board’s label list.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'cl-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the board' },
                  ],
                },
                {
                  rowId: 'cl-name',
                  cells: [
                    { key: 'param', content: <Code>name</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'Label name (must not be empty)' },
                  ],
                },
                {
                  rowId: 'cl-color',
                  cells: [
                    { key: 'param', content: <Code>color</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'Hex color, e.g. #0079BF' },
                  ],
                },
              ]}
            />
          </Section>

          {/* delete_label */}
          <Section id="tool-delete-label">
            <H3>delete_label</H3>
            <P>Delete a board label from the board and every card. Destructive. Verifies the label is absent from the board’s label list.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'dl-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the board the label belongs to' },
                  ],
                },
                {
                  rowId: 'dl-labelId',
                  cells: [
                    { key: 'param', content: <Code>labelId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the label' },
                  ],
                },
              ]}
            />
          </Section>

          {/* add_card_member */}
          <Section id="tool-add-card-member">
            <H3>add_card_member</H3>
            <P>Assign a board member to a card. Returns the card read back; the member must appear in its includes.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'acm-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card' },
                  ],
                },
                {
                  rowId: 'acm-userId',
                  cells: [
                    { key: 'param', content: <Code>userId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'User ID (see list_board_members)' },
                  ],
                },
              ]}
            />
          </Section>

          {/* remove_card_member */}
          <Section id="tool-remove-card-member">
            <H3>remove_card_member</H3>
            <P>Unassign a member from a card. Returns the card read back; the member must be gone from its includes.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'rcm-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card' },
                  ],
                },
                {
                  rowId: 'rcm-userId',
                  cells: [
                    { key: 'param', content: <Code>userId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'User ID' },
                  ],
                },
              ]}
            />
          </Section>

          {/* add_board_member */}
          <Section id="tool-add-board-member">
            <H3>add_board_member</H3>
            <P>Add a workspace member to a board by user ID (requires board admin). An existing member fails with <Code>board-member-exists</Code>; use <Code>set_board_member_role</Code>. Returns the member row read back from the board roster.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'abm-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the board' },
                  ],
                },
                {
                  rowId: 'abm-userId',
                  cells: [
                    { key: 'param', content: <Code>userId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'User ID (see list_workspace_members)' },
                  ],
                },
                {
                  rowId: 'abm-role',
                  cells: [
                    { key: 'param', content: <Code>role</Code> },
                    { key: 'type', content: 'admin | member' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'Role to assign (defaults to "member")' },
                  ],
                },
              ]}
            />
          </Section>

          {/* set_board_member_role */}
          <Section id="tool-set-board-member-role">
            <H3>set_board_member_role</H3>
            <P>Change an existing board member’s role (requires board admin). Demoting the last admin fails with <Code>last-board-admin</Code>. Returns the member row read back with the new role.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'sbmr-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the board' },
                  ],
                },
                {
                  rowId: 'sbmr-userId',
                  cells: [
                    { key: 'param', content: <Code>userId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'User ID (see list_board_members)' },
                  ],
                },
                {
                  rowId: 'sbmr-role',
                  cells: [
                    { key: 'param', content: <Code>role</Code> },
                    { key: 'type', content: 'admin | member' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'New role' },
                  ],
                },
              ]}
            />
          </Section>

          {/* create_checklist */}
          <Section id="tool-create-checklist">
            <H3>create_checklist</H3>
            <P>Create a checklist on a card. Returns <Code>&#123;checklist, items, card&#125;</Code> read back from the card.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'ccl-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card' },
                  ],
                },
                {
                  rowId: 'ccl-title',
                  cells: [
                    { key: 'param', content: <Code>title</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'Checklist title' },
                  ],
                },
              ]}
            />
          </Section>

          {/* add_checklist_item */}
          <Section id="tool-add-checklist-item">
            <H3>add_checklist_item</H3>
            <P>Add an item to a checklist. Returns <Code>&#123;item, card&#125;</Code> read back from the card.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'aci-checklistId',
                  cells: [
                    { key: 'param', content: <Code>checklistId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the checklist' },
                  ],
                },
                {
                  rowId: 'aci-title',
                  cells: [
                    { key: 'param', content: <Code>title</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'Item text' },
                  ],
                },
              ]}
            />
          </Section>

          {/* set_checklist_item */}
          <Section id="tool-set-checklist-item">
            <H3>set_checklist_item</H3>
            <P>Check, uncheck or rename a checklist item. Give <Code>checked</Code>, <Code>title</Code> or both (<Code>nothing-to-update</Code> otherwise). Returns <Code>&#123;item, card&#125;</Code>.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'sci-itemId',
                  cells: [
                    { key: 'param', content: <Code>itemId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the checklist item' },
                  ],
                },
                {
                  rowId: 'sci-checked',
                  cells: [
                    { key: 'param', content: <Code>checked</Code> },
                    { key: 'type', content: 'boolean' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'true to tick, false to untick' },
                  ],
                },
                {
                  rowId: 'sci-title',
                  cells: [
                    { key: 'param', content: <Code>title</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'New item text' },
                  ],
                },
              ]}
            />
          </Section>

          {/* rename_checklist */}
          <Section id="tool-rename-checklist">
            <H3>rename_checklist</H3>
            <P>Rename a checklist. Returns <Code>&#123;checklist, items, card&#125;</Code>.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'rc-checklistId',
                  cells: [
                    { key: 'param', content: <Code>checklistId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the checklist' },
                  ],
                },
                {
                  rowId: 'rc-title',
                  cells: [
                    { key: 'param', content: <Code>title</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'New title' },
                  ],
                },
              ]}
            />
          </Section>

          {/* delete_checklist */}
          <Section id="tool-delete-checklist">
            <H3>delete_checklist</H3>
            <P>Delete a checklist and all its items. Destructive. Verifies the checklist is absent from the card and returns <Code>&#123;deleted: true, id&#125;</Code>.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'dcl-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card the checklist is on' },
                  ],
                },
                {
                  rowId: 'dcl-checklistId',
                  cells: [
                    { key: 'param', content: <Code>checklistId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the checklist' },
                  ],
                },
              ]}
            />
          </Section>

          {/* delete_checklist_item */}
          <Section id="tool-delete-checklist-item">
            <H3>delete_checklist_item</H3>
            <P>Delete one checklist item. Destructive. Verifies the item is absent from the card and returns <Code>&#123;deleted: true, id&#125;</Code>.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'dci-cardId',
                  cells: [
                    { key: 'param', content: <Code>cardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the card the item is on' },
                  ],
                },
                {
                  rowId: 'dci-itemId',
                  cells: [
                    { key: 'param', content: <Code>itemId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the checklist item' },
                  ],
                },
              ]}
            />
          </Section>

          {/* rename_list */}
          <Section id="tool-rename-list">
            <H3>rename_list</H3>
            <P>Rename a list. Returns the list read back from the board’s lists.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'rl-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the board the list is on' },
                  ],
                },
                {
                  rowId: 'rl-listId',
                  cells: [
                    { key: 'param', content: <Code>listId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the list' },
                  ],
                },
                {
                  rowId: 'rl-title',
                  cells: [
                    { key: 'param', content: <Code>title</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'New title' },
                  ],
                },
              ]}
            />
          </Section>

          {/* archive_list */}
          <Section id="tool-archive-list">
            <H3>archive_list</H3>
            <P>Archive a list. The server route toggles, so a list already in the board’s archived lists is returned without a PATCH. Returns the list read back from the archived lists.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'al-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the board the list is on' },
                  ],
                },
                {
                  rowId: 'al-listId',
                  cells: [
                    { key: 'param', content: <Code>listId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the list' },
                  ],
                },
              ]}
            />
          </Section>

          {/* delete_list */}
          <Section id="tool-delete-list">
            <H3>delete_list</H3>
            <P>Permanently delete an empty list. Destructive. Prefer <Code>archive_list</Code>. The server refuses a list that still has cards (<Code>delete-requires-confirmation</Code>); this tool sends no confirmation, matching the local Python server. Verifies the list is absent from the board and returns <Code>&#123;deleted: true, id&#125;</Code>.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'dli-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the board the list is on' },
                  ],
                },
                {
                  rowId: 'dli-listId',
                  cells: [
                    { key: 'param', content: <Code>listId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the list' },
                  ],
                },
              ]}
            />
          </Section>

          {/* update_board */}
          <Section id="tool-update-board">
            <H3>update_board</H3>
            <P>Update a board’s title, description or visibility. Give at least one field (<Code>nothing-to-update</Code> otherwise). Returns the board read back.</P>
            <Table
              headers={['Parameter', 'Type', 'Required', 'Description']}
              rows={[
                {
                  rowId: 'ub-boardId',
                  cells: [
                    { key: 'param', content: <Code>boardId</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: '✅' },
                    { key: 'desc', content: 'ID of the board' },
                  ],
                },
                {
                  rowId: 'ub-title',
                  cells: [
                    { key: 'param', content: <Code>title</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'New title' },
                  ],
                },
                {
                  rowId: 'ub-description',
                  cells: [
                    { key: 'param', content: <Code>description</Code> },
                    { key: 'type', content: 'string' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'New description' },
                  ],
                },
                {
                  rowId: 'ub-visibility',
                  cells: [
                    { key: 'param', content: <Code>visibility</Code> },
                    { key: 'type', content: 'PRIVATE | WORKSPACE | PUBLIC' },
                    { key: 'req', content: 'No' },
                    { key: 'desc', content: 'New visibility' },
                  ],
                },
              ]}
            />
          </Section>

        </div>
      </main>
    </div>
  );
};

export default McpDocsPage;
