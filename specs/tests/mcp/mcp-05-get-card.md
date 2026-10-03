# MCP 05. get_card

**Prerequisites:** Flow 08 (Add Cards) completed. `$cardId` is `Test Card 1`.

---

## Steps

1. Call `get_card`:
   ```json
   { "cardId": "$cardId" }
   ```
   - **Expected:** `isError` false. Response has `id`, `title` (`Test Card 1`), `listId`.

2. Verify optional fields are present if set (from flow 11):
   - `description` (from flow 10)
   - `members` array
   - `dueDate`

3. Call with an invalid `cardId`:
   - **Expected:** `isError: true`, `card-not-found`.

4. Call on a card from a PRIVATE board with a non-member token:
   - **Expected:** `isError: true`, access denied.

5. Archive a card (UI or API). Call `get_card` on the archived card.
   - **Expected:** `isError` false, `archived: true`.

6. Call without authorization:
   - **Expected:** `401 Unauthorized`.

7. Call `get_card` with `include_activities`:
   ```json
   { "cardId": "$cardId", "include_activities": true }
   ```
   - **Expected:** `isError` false. `includes.activities` is non-empty and
     oldest first; when present, its `card_created` row's `actor_id` is the card's creator (some cards, e.g. duplicated or copied ones, have none).
   - Repeat with `include_activities` false or omitted: `includes.activities`
     is `[]`.
