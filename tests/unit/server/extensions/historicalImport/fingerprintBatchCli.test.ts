import { describe, expect, it } from 'bun:test';
import process from 'node:process';
import {
  CARD_FINGERPRINT_FIELDS,
  fingerprintFields,
  fingerprintJson,
} from '../../../../../server/extensions/historicalImport/core/fingerprint';

const script = new URL(
  '../../../../../scripts/historical-import-fingerprint-batch.ts',
  import.meta.url
).pathname;

describe('candidate-native historical import fingerprint batch', () => {
  it('projects database timestamps into the exact candidate serializer for every input row', async () => {
    const iso = '2026-01-01T00:00:00.000Z';
    const card = {
      title: 'Card',
      description: null,
      position: 'p',
      archived: false,
      due_date: null,
      due_complete: false,
      start_date: iso,
      list_id: 'list-1',
    };
    const board = { id: 'board-1', created_at: iso, title: 'Board' };
    const child = Bun.spawn([process.execPath, 'run', script], {
      stdin: new Blob([
        JSON.stringify({
          rows: [
            { key: 'card:1', entity_type: 'card', row: card, timestamp_fields: ['start_date'] },
            {
              key: 'board:1',
              entity_type: 'board',
              row: board,
              timestamp_fields: ['created_at'],
            },
          ],
        }),
      ]),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(stderr).toBe('');
    const result = JSON.parse(stdout) as {
      algorithm: string;
      count: number;
      fingerprints: Record<string, string>;
    };
    expect(result.algorithm).toBe('sha256-fingerprint-v1');
    expect(result.count).toBe(2);
    expect(result.fingerprints['card:1']).toBe(
      fingerprintFields({ ...card, start_date: new Date(iso) }, CARD_FINGERPRINT_FIELDS)
    );
    expect(result.fingerprints['board:1']).toBe(
      fingerprintJson({ ...board, created_at: new Date(iso) })
    );
  });
});
