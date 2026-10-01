import { strict as assert } from 'node:assert';
import { registerMcpTools } from './registerTools';
import { defineToolScenarios } from './tools/toolSupport.fixture';

// Names shared with the local Python chimedeck-mcp server; agents switch
// servers without changes, so these must stay registered verbatim.
const BOARD_COVERAGE_TOOLS = [
  'get_me', 'list_workspaces', 'list_workspace_boards', 'list_workspace_members', 'get_board',
  'list_lists', 'list_labels', 'list_board_members', 'list_cards', 'list_archived_cards',
  'update_card', 'set_card_due', 'archive_card', 'delete_card', 'copy_card',
  'get_comments', 'edit_comment', 'delete_comment',
  'get_attachments', 'download_attachment', 'add_url_attachment', 'delete_attachment',
  'add_card_label', 'remove_card_label', 'create_label', 'delete_label',
  'add_card_member', 'remove_card_member', 'add_board_member', 'set_board_member_role',
  'create_checklist', 'add_checklist_item', 'set_checklist_item', 'rename_checklist',
  'delete_checklist', 'delete_checklist_item',
  'rename_list', 'archive_list', 'delete_list', 'update_board',
];

defineToolScenarios(import.meta, registerMcpTools, {
  'registers 60 unique tools including the board coverage set': (h) => {
    const names = h.tools.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length, 'duplicate tool names');
    assert.equal(names.length, 60);
    assert.equal(BOARD_COVERAGE_TOOLS.length, 40);
    for (const name of BOARD_COVERAGE_TOOLS) assert.ok(names.includes(name), `${name} not registered`);
  },
});
