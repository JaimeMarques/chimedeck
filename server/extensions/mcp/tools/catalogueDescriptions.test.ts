import { strict as assert } from 'node:assert';
import { registerMcpTools } from '../registerTools';
import { defineToolScenarios, type Harness } from './toolSupport.fixture';

// Assert the public tools/list catalogue over the real SDK transport, not
// source strings or a mocked registerTool. The harness isolates module mocks.
function description(h: Harness, name: string): string {
  const tool = h.tools.find((entry) => entry.name === name);
  assert.ok(tool, `${name} not registered`);
  assert.ok(tool.description, `${name} description missing`);
  return tool.description;
}

function expectReceipt(h: Harness, name: string, fields: string[]): string {
  const text = description(h, name);
  assert.match(text, /compact.*receipt/i, name);
  for (const field of fields) assert.ok(text.includes(field), `${name} missing ${field}`);
  assert.doesNotMatch(text, /Returns.*(?:card with its includes|\{[^}]*\bcard\b)/i, name);
  return text;
}

function expectCreation(h: Harness, name: string, fields: string[]): void {
  const text = expectReceipt(h, name, ['request_outcome', 'verified', ...fields]);
  assert.match(text, /unknown/i, `${name} must explain uncertain outcomes`);
  assert.match(text, /(?:do not|never).*retry/i, `${name} must prevent duplicate creates`);
}

// Catalogue reads must not accidentally call the REST API.
function expectNoRequests(h: Harness): void {
  assert.deepEqual(h.requests, []);
}

defineToolScenarios(import.meta, registerMcpTools, {
  'checklist descriptions advertise selected children and compact receipts, not full cards': (
    h
  ) => {
    expectCreation(h, 'create_checklist', ['checklist', 'card_id']);
    expectCreation(h, 'add_checklist_item', ['item', 'card_id']);
    expectReceipt(h, 'set_checklist_item', ['verified', 'verified_fields', 'item', 'card_id']);
    expectReceipt(h, 'rename_checklist', ['verified', 'verified_fields', 'checklist', 'card_id']);
    expectNoRequests(h);
  },
  'card edit descriptions advertise verified fields and copy creation uncertainty': (h) => {
    for (const name of ['update_card', 'set_card_due', 'archive_card']) {
      expectReceipt(h, name, ['id', 'verified', 'verified_fields', 'observed']);
    }
    assert.ok(description(h, 'update_card').includes('normalized_fields'));
    assert.ok(description(h, 'archive_card').includes('write_skipped'));
    assert.ok(description(h, 'archive_card').includes('archive-state-conflict'));
    const copy = description(h, 'copy_card');
    expectCreation(h, 'copy_card', ['id', 'verified_fields', 'observed', 'unverified']);
    assert.ok(copy.includes('keepChecklists') && copy.includes('keepMembers'));
    expectNoRequests(h);
  },
  'label and member descriptions advertise verified relation receipts': (h) => {
    for (const [name, relation] of [
      ['add_card_label', 'labels'],
      ['remove_card_label', 'labels'],
      ['add_card_member', 'members'],
      ['remove_card_member', 'members'],
    ] as const) {
      expectReceipt(h, name, [
        'id',
        'verified',
        'verified_fields',
        'observed',
        'child_id',
        'present',
        relation,
      ]);
    }
    expectNoRequests(h);
  },
  'comment deletion describes a receipt rather than returning a placeholder body': (h) => {
    const text = expectReceipt(h, 'delete_comment', ['deleted', 'verified', 'id', 'card_id']);
    assert.ok(text.includes('[deleted]'));
    assert.doesNotMatch(text, /placeholder, which is returned/i);
    expectNoRequests(h);
  },
  'full card reads describe privacy filtering rather than promise every field': (h) => {
    const text = description(h, 'get_card');
    assert.match(text, /compact by default.*complete description/i);
    assert.ok(text.includes('view:full'));
    assert.ok(text.includes('ip_address') && text.includes('user_agent'));
    assert.match(text, /both views/i);
    assert.doesNotMatch(text, /includes all fields/i);
    assert.ok(text.includes('get_card_discussion'));
    for (const tool of h.tools) {
      assert.doesNotMatch(
        tool.description ?? '',
        /Returns (?:the (?:new )?card with its includes|\{(?:checklist, items|item), card\})/i,
        tool.name
      );
      assert.doesNotMatch(tool.description ?? '', /placeholder, which is returned/i, tool.name);
    }
    expectNoRequests(h);
  },
});
