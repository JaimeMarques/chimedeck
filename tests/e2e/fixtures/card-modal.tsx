import React, { useState, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import CardModal from '../../../src/extensions/Card/components/CardModal';
import { apiClient } from '../../../src/common/api/client';
import { store } from '../../../src/store';
import '../../../src/index.css';

// Every API call stays in memory; this fixture needs no server, account or database.
apiClient.defaults.adapter = async (config) => ({
  config, status: 200, statusText: 'OK', headers: {},
  data: { data: config.url?.endsWith('/attachments') ? [{
    id: 'attachment', card_id: 'card', name: 'Last attachment', alias: null,
    type: 'URL', status: 'READY', external_url: 'https://example.invalid/fixture',
    key: null, thumbnail_key: null, content_type: null, size_bytes: null,
    width: null, height: null, view_url: null, thumbnail_url: null,
    referenced_card_id: null, referenced_card: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  }] : [] },
});

const noop = async () => {};
const props: ComponentProps<typeof CardModal> = {
  boardId: 'board', open: true, listTitle: 'Mobile list', boardTitle: 'Fixture board',
  currentUserId: 'user', labels: [], allLabels: [], members: [], boardMembers: [],
  card: {
    id: 'card', list_id: 'list', title: 'Long mobile card', description: 'A card with a long checklist and activity feed.',
    position: '1', archived: false, due_date: null, due_complete: false, start_date: null,
    amount: null, currency: null, cover_color: new URLSearchParams(location.search).has('cover') ? '#2563EB' : null,
    cover_size: 'FULL', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    labels: [], members: [],
  },
  checklists: [{
    id: 'checklist', card_id: 'card', title: 'Long checklist', position: '1',
    items: Array.from({ length: 50 }, (_, index) => ({
      id: `item-${index}`, card_id: 'card', checklist_id: 'checklist',
      title: `Checklist item ${index + 1}`, checked: false, position: String(index),
    })),
  }],
  comments: Array.from({ length: 30 }, (_, index) => ({
    id: `comment-${index}`, card_id: 'card', user_id: 'user',
    content: `Activity comment ${index + 1}`, version: 1, deleted: false,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    author_name: 'Fixture user', author_email: 'fixture@example.invalid',
  })),
  activities: [], onClose: noop,
  onTitleSave: noop,
  onDescriptionSave: noop,
  onStartDateChange: noop,
  onDueDateChange: noop,
  onDueCompleteChange: noop,
  onArchive: noop,
  onDelete: noop,
  onCopyLink: noop,
  onCopyCard: noop,
  onMoveCard: noop,
  onPrint: noop,
  onCreateChecklist: noop,
  onRenameChecklist: noop,
  onDeleteChecklist: noop,
  onChecklistReorder: noop,
  onItemAdd: noop,
  onItemToggle: noop,
  onItemRename: noop,
  onItemDelete: noop,
  onItemAssign: noop,
  onItemDueDateChange: noop,
  onItemConvertToCard: noop,
  onItemReorder: noop,
  onLabelAttach: noop,
  onLabelDetach: noop,
  onLabelCreate: noop,
  onLabelUpdate: noop,
  onMemberAssign: noop,
  onMemberRemove: noop,
  onAddComment: noop,
  onEditComment: noop,
  onDeleteComment: noop,
  onMoneySave: noop,
  onCoverColorChange: noop,
  onCoverSizeChange: noop,
  onCoverAttachmentChange: noop,
};

function Fixture() {
  const [open, setOpen] = useState(true);
  return <Provider store={store}><CardModal {...props} open={open} onClose={() => { setOpen(false); }} /></Provider>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
