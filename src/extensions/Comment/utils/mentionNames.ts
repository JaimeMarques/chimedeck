type MentionMember = {
  user_id: string;
  email: string;
  display_name: string | null;
  nickname?: string | null;
};

type MentionGuest = {
  id: string;
  email: string;
  name: string;
};

// The membership endpoint intentionally excludes guests; the Guests endpoint
// supplies their names separately. Do not expose an email as a mention label.
export function buildMentionNames(
  members: readonly MentionMember[] = [],
  guests: readonly MentionGuest[] = [],
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const member of members) {
    const displayName = member.display_name?.trim();
    const readableDisplayName = displayName?.toLowerCase() === member.email.trim().toLowerCase()
      ? undefined : displayName;
    const name = member.nickname?.trim() || readableDisplayName;
    if (name) names.set(member.user_id.toLowerCase(), name);
  }
  for (const guest of guests) {
    const name = guest.name.trim();
    if (name && name.toLowerCase() !== guest.email.trim().toLowerCase()) names.set(guest.id.toLowerCase(), name);
  }
  return names;
}

// Board-wide comments are plain text, not HTML. React escapes this string; the
// stored comment remains unchanged. Leave URL paths and unknown IDs literal.
export function replaceUuidMentionLabels(text: string, names: ReadonlyMap<string, string>): string {
  return text.replace(/@[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\w-])/gi,
    (token, offset: number) => {
      if (offset > 0 && text[offset - 1] === '/') return token;
      const name = names.get(token.slice(1).toLowerCase());
      return name ? `@${name}` : token;
    });
}
