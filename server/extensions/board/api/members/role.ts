export type BoardMemberRole = 'ADMIN' | 'MEMBER';

const VALID_BOARD_MEMBER_ROLES = new Set<BoardMemberRole>(['ADMIN', 'MEMBER']);

export function normalizeBoardMemberRole(
  value: unknown,
  defaultWhenOmitted?: BoardMemberRole
): BoardMemberRole | null {
  if (value === undefined) return defaultWhenOmitted ?? null;
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toUpperCase();
  return VALID_BOARD_MEMBER_ROLES.has(normalized as BoardMemberRole)
    ? (normalized as BoardMemberRole)
    : null;
}
