# CAP Manager Security Specification (Phase 0)

## 1. Data Invariants
1. Every `/groups/{groupId}` document ID must match `^[a-zA-Z0-9_-]+$` (1–128 chars) and strictly equal `data.id`.
2. `/groups/{groupId}` never stores plaintext passwords or credential hashes; credentials are isolated in `/groupCredentials/{groupId}` as salted SHA-256 hashes (`salt` + `passwordHash`).
3. Every `/groupCredentials/{groupId}` document creation must atomically accompany `/groups/{groupId}` (`existsAfter`), updates must keep `groupId` immutable and stay synced with `getAfter(/groups/{groupId}).leaderUsername`, and deletion is only allowed atomically when deleting a non-default group (`groupId != 'group-1'`).
4. Every `/groups/{groupId}/history/{historyId}` record must reference an existing parent group (`exists(/databases/.../groups/$(groupId))`), match `data.groupId == groupId`, use `createdAt == request.time`, and remain immutable after creation (`allow update: if false`).
5. Updates on `/groups/{groupId}` must preserve `id`, `visibility`, and `createdAt`, update `updatedAt == request.time`, and match strictly enumerated `affectedKeys().hasOnly(...)` action allowlists (Tier 1 Leader management, Tier 2 Viewer shift-only updates that preserve `members.size()`, and Tier 3 bounded `completions` check-off toggles).
6. The primary default group `group-1` cannot be deleted.
7. Every string, map, number, and list has explicit type and upper size bounds to prevent resource exhaustion / shadow field injection.
8. `/groupTelegramBots/{groupId}` forbids collection `list` queries (`allow list: if false`), requires an existing parent `/groups/{groupId}` for `get`/`create`/`update`, enforces immutable `groupId` matching the document path, and validates strict schema bounds (`botToken` 20–512 chars, `botUsername` <= 64, `tokenMasked` <= 32, `encrypted` bool, `updatedAt == request.time`).
9. `settings.telegramTemplates` (when present) only allows keys `['capPublish', 'capUpdate', 'shiftReminder', 'testMessage']`, each bounded to strings `<= 800` characters; 2-way Telegram / AI Butler fields (`telegramInteractiveEnabled`, `aiButlerEnabled`, `telegramDeadlineReminderTime`, `telegramDailySummaryTime`) are strictly typed booleans and `HH:MM` strings (`<= 5` chars).
10. Every `/groups/{groupId}/transfers/{transferId}` record must reference an existing parent group, start in `status == 'pending'`, enforce `qty` 1..100, keep core transfer fields immutable, and lock terminal state (`approved` / `rejected`) so `existing().status == 'pending'` is required for updates.

## 2. The "Dirty Dozen" Payloads (Expected: PERMISSION_DENIED)
1. **Shadow/Ghost Field on Group Create**: `{ ..., isAdmin: true }` -> rejected by `keys().hasOnly(...)`.
2. **Shadow/Ghost Field on Group Update**: updating `{ members: [...], hacked: true, updatedAt: serverTimestamp() }` -> rejected by `isValidGroup` + `affectedKeys().hasOnly(...)`.
3. **ID Poisoning on Group Create**: `/groups/bad$id..with..chars` or `id != groupId` -> rejected by `isValidId(groupId)` & `data.id == groupId`.
4. **Client Timestamp Tampering on Create**: `createdAt: Timestamp(2000-01-01)` -> rejected by `incoming().createdAt == request.time`.
5. **Immutable `createdAt` Mutation on Update**: changing `createdAt` during update -> rejected by `incoming().createdAt == existing().createdAt`.
6. **Orphaned Credential Create**: creating `/groupCredentials/nonexistent` without atomic `/groups/nonexistent` -> rejected by `existsAfter(...)`.
7. **Plaintext / Malformed Hash in Credential**: `passwordHash: "123456"` (length 6 != 64) -> rejected by `passwordHash.size() == 64 && matches('^[a-f0-9]+$')`.
8. **Credential Desync / Hijack Update**: updating `/groupCredentials/{groupId}.username` without atomically updating `/groups/{groupId}.leaderUsername` -> rejected by `getAfter(...).data.leaderUsername == incoming().username`.
9. **Orphaned History / Transfer Record**: creating `/groups/missing-group/history/h1` or `/groups/missing-group/transfers/t1` -> rejected by `exists(/databases/.../groups/$(groupId))`.
10. **Terminal State / History Tampering**: updating `/groups/group-1/history/h1` or modifying an already `'approved'` transfer -> rejected by `allow update: if false` / `existing().status == 'pending'`.
11. **Deleting Default Group**: deleting `/groups/group-1` or `/groupCredentials/group-1` -> rejected by `groupId != 'group-1'`.
12. **Unlisted Collection / Oversized Telegram Template / Invalid Transfer Qty / Bot Token Listing**: accessing `/admins/x`, injecting ghost/oversized keys into `settings.telegramTemplates`, creating a transfer with `qty: 500` or `status: 'approved'` directly, or `list`ing `/groupTelegramBots` -> rejected by catch-all deny, `isValidTelegramTemplates`, `isValidTransfer`, and `allow list: if false`.
