import { z } from 'zod';
import { ToolError } from './toolSupport';

export const viewSchema = z.enum(['compact', 'full']).default('compact');
export const rowView = { view: viewSchema, includeDescription: z.boolean().optional() };
export type Row = Record<string, unknown>;
export const identity = (value: string): string =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : value;
export const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (!isRow(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'ip_address' && key !== 'user_agent')
      .map(([key, item]) => [key, scrub(item)])
  );
}

export const cardFields = new Set(
  'id short_id title description board_id board_short_id workspace_id state type listId list_id position archived due_date due_complete created_at updated_at created_by creator_id money_amount money_currency money_label amount currency label labels members comment_count checklist_count checklist_items_count checklist_items_checked'.split(
    ' '
  )
);
const commentFields = new Set(
  'id parent_id content author_id author_name user_id author user created_by created_at updated_at deleted reply_count'.split(
    ' '
  )
);
export const relationFields: Record<string, Set<string>> = {
  labels: new Set('id board_id name color'.split(' ')),
  members: new Set('id user_id name display_name email role'.split(' ')),
  checklists: new Set('id card_id title position created_at updated_at'.split(' ')),
  checklistItems: new Set(
    'id card_id checklist_id title checked position created_at updated_at'.split(' ')
  ),
};
export function fields(value: unknown, keys: Set<string>): unknown {
  if (!isRow(value)) return scrub(value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => keys.has(key) && item !== null)
      .map(([key, item]) => [
        key,
        Array.isArray(item) && relationFields[key]
          ? item.map((row) => fields(row, relationFields[key] ?? new Set()))
          : scrub(item),
      ])
  );
}
export function projectRows(
  response: unknown,
  args: { view?: string | undefined; includeDescription?: boolean | undefined },
  comments = false
): unknown {
  if (args.view === 'full') return scrub(response);
  const project = (row: unknown) => {
    const keys = new Set(comments ? commentFields : cardFields);
    if (!comments && !args.includeDescription) keys.delete('description');
    const out = fields(row, keys);
    if (comments && isRow(row) && isRow(out) && 'parent_id' in row) out.parent_id = row.parent_id;
    return out;
  };
  if (Array.isArray(response)) return response.map(project);
  if (!isRow(response)) return scrub(response);
  return Object.fromEntries(
    Object.entries(response).map(([key, item]) => [
      key,
      key === 'data' && Array.isArray(item) ? item.map(project) : scrub(item),
    ])
  );
}
export function projectCard(response: Row, view?: string): unknown {
  if (view === 'full') return scrub(response);
  const out = Object.fromEntries(
    Object.entries(response).filter(([key]) => key !== 'data' && key !== 'includes')
  );
  out.data = fields(response.data, cardFields);
  if ('includes' in response && !isRow(response.includes)) {
    out.includes = scrub(response.includes);
    return scrub(out);
  }
  const includes = isRow(response.includes) ? response.includes : {};
  out.includes = Object.fromEntries(
    Object.entries(includes)
      .filter(([key]) =>
        [
          'list',
          'board',
          'labels',
          'members',
          'checklists',
          'checklistItems',
          'activities',
        ].includes(key)
      )
      .map(([key, value]) => {
        const keys = relationFields[key];
        if (keys && Array.isArray(value)) value = value.map((row) => fields(row, keys));
        else if (key === 'activities' && Array.isArray(value))
          value = value.map((row) =>
            fields(
              row,
              new Set(
                'id actor_id actor actor_name action type payload created_at updated_at'.split(' ')
              )
            )
          );
        else if (key === 'list' || key === 'board')
          value = fields(
            value,
            new Set('id short_id title board_id workspace_id archived'.split(' '))
          );
        return [key, scrub(value)];
      })
  );
  return scrub(out);
}

// Date carries whole seconds only; fractional microseconds remain integers.
export function timestamp(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value
    );
  if (!match) return null;
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = match
    .slice(1, 7)
    .map(Number);
  if (!year || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59)
    return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const offsetHour = Number(match[10] ?? 0),
    offsetMinute = Number(match[11] ?? 0);
  if (offsetHour > 23 || offsetMinute > 59) return null;
  const offset = (offsetHour * 60 + offsetMinute) * (match[9] === '-' ? -1 : 1);
  return BigInt(date.getTime() - offset * 60000) * 1000n + BigInt((match[7] ?? '').padEnd(6, '0'));
}

function decimal(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
  )
    return null;
  const text = String(value);
  if (typeof value === 'string' && !/^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(text)) return null;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return null;
  let coefficient = BigInt(`${match[1] === '-' ? '-' : ''}${String(match[2])}${match[3] ?? ''}`);
  let scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
  if (coefficient === 0n) return '0';
  while (coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale--;
  }
  return `${String(coefficient)}:${String(scale)}`;
}
export function equal(key: string, actual: unknown, desired: unknown): boolean {
  if (key === 'description' && desired === '' && actual === null) return true;
  if (key === 'due_date') {
    if (desired === null || desired === '') return actual === null || actual === '';
    const left = timestamp(actual),
      right = timestamp(desired);
    return left !== null && right !== null && left === right;
  }
  if (key.endsWith('_id') && typeof actual === 'string' && typeof desired === 'string')
    return identity(actual) === identity(desired);
  if (key === 'amount' && actual !== null && desired !== null) {
    const left = decimal(actual),
      right = decimal(desired);
    return typeof desired === 'number' && left !== null && right !== null && left === right;
  }
  return typeof actual === typeof desired && actual === desired;
}

export interface Verified {
  id: string;
  observed: Row;
  verified: boolean;
  verified_fields: string[];
  unverified?: string[];
}
export function verified(row: Row, desired: Row, unverified: string[] = []): Verified {
  if (typeof row.id !== 'string' || !row.id) throw new ToolError('invalid-response');
  for (const [key, value] of Object.entries(desired))
    if (!(key in row) || !equal(key, row[key], value)) throw new ToolError('readback-mismatch');
  return {
    id: row.id,
    observed: Object.fromEntries(Object.keys(desired).map((key) => [key, row[key]])),
    verified: unverified.length === 0,
    verified_fields: Object.keys(desired),
    ...(unverified.length ? { unverified } : {}),
  };
}
export function children(card: { data: Row; includes?: unknown }, key: string): Row[] {
  const rows = isRow(card.includes) ? card.includes[key] : undefined;
  if (!Array.isArray(rows) || typeof card.data.id !== 'string')
    throw new ToolError('invalid-response');
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRow(row) || typeof row.id !== 'string' || !row.id)
      throw new ToolError('invalid-response');
    const id = identity(row.id);
    if (
      seen.has(id) ||
      ('card_id' in row &&
        (typeof row.card_id !== 'string' || identity(row.card_id) !== identity(card.data.id)))
    )
      throw new ToolError('invalid-response');
    seen.add(id);
  }
  return rows as Row[];
}

export type Creation =
  | { request_outcome: 'unknown'; verified: false; verification_error: { code: string } }
  | ({ request_outcome: 'succeeded'; id: string } & (
      | Verified
      | { verified: false; verification_error: { code: string } }
    ));
type CreationObservation = (
  | { row: Row; selected?: false; extra?: Row }
  | {
      row: Row;
      selected: true;
      extra:
        | { item: Row; card_id: string }
        | { checklist: Row; card_id: string }
        | { board: Row }
        | { list: Row }
        | { label: Row }
        | { attachment: Row };
    }
) & { unverified?: string[] };
export const ambiguous = (error: unknown): boolean =>
  !(error instanceof ToolError) ||
  error.phase === 'response' ||
  error.phase === 'transport' ||
  (error.status !== undefined && error.status >= 500);
export const errorCode = (error: unknown): string =>
  error instanceof ToolError ? error.code : 'internal';
export async function acknowledgedCreate(
  write: () => Promise<unknown>,
  observe: (ack: Row) => Promise<CreationObservation>,
  desired: Row,
  unverified: string[] = []
): Promise<Creation & Row> {
  let response: unknown;
  try {
    response = await write();
  } catch (error) {
    if (!ambiguous(error)) throw error;
    return {
      request_outcome: 'unknown',
      verified: false,
      verification_error: { code: errorCode(error) },
    };
  }
  const ack = isRow(response) ? response.data : undefined;
  if (!isRow(ack) || typeof ack.id !== 'string' || !ack.id)
    return {
      request_outcome: 'unknown',
      verified: false,
      verification_error: { code: 'invalid-response' },
    };
  const id = ack.id;
  try {
    const { row, extra, selected, unverified: observedUnverified = [] } = await observe(ack);
    if (typeof row.id !== 'string' || identity(row.id) !== identity(id))
      throw new ToolError('readback-mismatch');
    const remaining = Object.fromEntries(
      Object.entries(desired).filter(([key]) => !observedUnverified.includes(key))
    );
    const result = verified(row, remaining, [...unverified, ...observedUnverified]);
    if (selected) result.observed = {};
    return { ...result, ...extra, id, request_outcome: 'succeeded' };
  } catch (error) {
    return {
      id,
      request_outcome: 'succeeded',
      verified: false,
      verification_error: { code: errorCode(error) },
    };
  }
}
