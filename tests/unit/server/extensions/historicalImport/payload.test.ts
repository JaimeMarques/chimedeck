import { describe, expect, it } from 'bun:test';
import {
  exactHistoricalCommentContent,
  validateStagedSourceReferences,
  type StagedPayload,
} from '../../../../../server/extensions/historicalImport/core/payload';
import {
  canonicalJson,
  sha256Hex,
} from '../../../../../server/extensions/historicalImport/core/fingerprint';

describe('exactHistoricalCommentContent', () => {
  it('returns a representable historical string unchanged', () => {
    const content = '  <img src="x" onerror="historical()">\r\n@alice  ';

    expect(exactHistoricalCommentContent({ content })).toBe(content);
  });

  it('fails closed for missing or PostgreSQL-TEXT-unrepresentable content', () => {
    expect(() => exactHistoricalCommentContent({})).toThrow(
      'historical comment payload requires string content'
    );
    expect(() => exactHistoricalCommentContent({ content: 'not representable\u0000' })).toThrow(
      'historical comment content is not representable by PostgreSQL text: contains U+0000'
    );
    expect(() => exactHistoricalCommentContent({ content: '\ud800' })).toThrow(
      'historical comment content is not representable by PostgreSQL text: contains an unpaired UTF-16 surrogate'
    );
  });
});

describe('validateStagedSourceReferences', () => {
  const list = { id: 'list-deleted', name: 'Complete' };
  const action = {
    id: 'action-delete-list',
    type: 'deleteList',
    idMemberCreator: 'member-1',
    data: { list, board: { id: 'source-board', name: 'Phoenix' } },
  };

  function payload(): StagedPayload {
    const listSnapshot = structuredClone(list);
    const actionSnapshot = structuredClone(action);
    return {
      entity_type: 'activity',
      source_id: action.id,
      historical_author: action.idMemberCreator,
      fields: {
        entity_type: 'board',
        entity_id: 'target-board',
        board_id: 'target-board',
        action: 'legacy.trello.list_deleted',
        actor_id: 'target-user',
        payload: {
          detached_historical_list_reference: listSnapshot,
          historical_source_action: actionSnapshot,
        },
      },
      source_references: [
        {
          source_system: 'trello',
          entity_type: 'list',
          source_id: list.id,
          relationship: 'subject',
          source_path: '/data/list',
          snapshot: structuredClone(list),
          snapshot_sha256: sha256Hex(canonicalJson(list)),
          source_snapshot_sha256: 'a'.repeat(64),
          evidence_ref: `trello:action:${action.id}#/data/list`,
        },
      ],
    };
  }

  it('accepts an exact detached list snapshot tied to the raw source action', () => {
    expect(validateStagedSourceReferences(payload())).toEqual(payload().source_references!);
  });

  it('rejects changed hashes, action identities, list identities, and invalid live anchors', () => {
    const badHash = payload();
    badHash.source_references![0]!.snapshot_sha256 = 'b'.repeat(64);
    expect(() => validateStagedSourceReferences(badHash)).toThrow('snapshot_sha256');

    const badAction = payload();
    (
      badAction.fields.payload as { historical_source_action: { id: string } }
    ).historical_source_action.id = 'different-action';
    expect(() => validateStagedSourceReferences(badAction)).toThrow('source action identity');

    const badList = payload();
    (
      badList.fields.payload as { historical_source_action: { data: { list: { id: string } } } }
    ).historical_source_action.data.list.id = 'different-list';
    expect(() => validateStagedSourceReferences(badList)).toThrow('source list evidence');

    const badAnchor = payload();
    badAnchor.fields.entity_id = 'different-board';
    expect(() => validateStagedSourceReferences(badAnchor)).toThrow('board anchor');
  });
});
