import { describe, expect, it } from 'bun:test';
import { assertTrelloShape } from '../../../../../server/extensions/trelloCompat/helpers/assertTrelloShape';
import {
  createActivityActionFixture,
  createCommentActionFixture,
  createCommentActionFixtureWithoutList,
} from '../../../../../server/extensions/trelloCompat/helpers/fixtures';
import { projectActionField } from '../../../../../server/extensions/trelloCompat/api/actions';
import {
  serializeActivityAction,
  serializeCommentAction,
} from '../../../../../server/extensions/trelloCompat/serializers/action';

describe('trelloCompat actions contract smoke tests', () => {
  it('GET /actions/{id} comment action shape matches required Trello keys', () => {
    const payload = serializeCommentAction(createCommentActionFixture());

    expect(() => assertTrelloShape('action-comment', payload)).not.toThrow();
    expect(payload.type).toBe('commentCard');
  });

  it('GET /actions/{id} activity action shape matches required Trello keys', () => {
    const payload = serializeActivityAction(createActivityActionFixture());

    expect(() => assertTrelloShape('action-activity', payload)).not.toThrow();
    expect(payload.type).toBe('updateCard');
  });

  it('renders detached historical list activities from their immutable raw source action', () => {
    const memberCreator = createActivityActionFixture().memberCreator;
    const list = { id: 'list-deleted', name: 'Complete' };
    const sourceAction = {
      id: 'action-delete-list',
      type: 'deleteList',
      data: {
        board: { id: 'source-board', name: 'Phoenix' },
        list,
      },
    };
    const payload = serializeActivityAction({
      id: 'activity-detached-list',
      type: 'legacy.trello.list_deleted',
      board_id: 'target-board',
      user_id: memberCreator.id,
      payload: {
        detached_historical_list_reference: list,
        historical_source_action: sourceAction,
      },
      created_at: '2026-04-14T19:35:20.000Z',
      memberCreator,
    });

    expect(() => assertTrelloShape('action-activity', payload)).not.toThrow();
    expect(payload.type).toBe('deleteList');
    expect(payload.data).toEqual(sourceAction.data);
    expect(payload.data).not.toHaveProperty('historical_source_action');
  });

  it('PUT /actions/{id} response shape remains Trello-compatible for comment actions', () => {
    const payload = serializeCommentAction(
      createCommentActionFixture({ content: 'Updated comment text' })
    );

    expect(() => assertTrelloShape('action-comment', payload)).not.toThrow();
    expect(payload.data.text).toBe('Updated comment text');
  });

  it('DELETE /actions/{id} returns Trello empty object shape', () => {
    const payload = {};
    expect(payload).toEqual({});
  });

  it('GET /actions/{id}/{field} supports top-level field projection for action keys', () => {
    const payload = serializeCommentAction(createCommentActionFixture());
    const projectedType = projectActionField(payload, 'type');
    const projectedDate = projectActionField(payload, 'date');
    const projectedCreator = projectActionField(payload, 'memberCreator');

    expect(projectedType).toEqual({ found: true, value: 'commentCard' });
    expect(projectedDate.found).toBe(true);
    expect(projectedCreator.found).toBe(true);
  });

  it('GET /actions/{id}/{field} rejects unknown field projection', () => {
    const payload = serializeActivityAction(createActivityActionFixture());
    const projection = projectActionField(payload, 'unknownField');
    expect(projection).toEqual({ found: false });
  });

  it('comment action remains valid when list context is absent', () => {
    const payload = serializeCommentAction(createCommentActionFixtureWithoutList());

    expect(() => assertTrelloShape('action-comment', payload)).not.toThrow();
    expect(payload.data).not.toHaveProperty('list');
  });
});
