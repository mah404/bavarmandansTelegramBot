# Group Moderation

After deployment, give the bot permission to pin messages in the support group.
Make sure the group has no other pinned message when initializing, then send
`/blockList` as a group administrator. The bot creates and pins its management
message with command reminders at the top.

- `/block`: permanently restrict a user.
- `/unblock`: remove a permanent or temporary restriction.
- `/ban1h`: restrict a user for one hour.
- `/blockList`: list active restrictions and refresh the pinned summary.

Reply to a bot-relayed user message, or append its `U-...` code to a command.
Only group administrators may use moderation commands. Anonymous administrator
messages are rejected; send commands using your personal administrator account.

The pinned message holds an authenticated, encrypted snapshot of user-code
mappings and restrictions. User names and Telegram IDs are not printed in it.
Each update reloads the snapshot before processing, so it can recover after a
server restart. Ordinary administrator replies also resolve the user code from
the relayed message after a restart. Existing conversation menus stay unchanged.

## Operational Limits

- Do not delete or unpin the management message, or pin a newer message.
  Telegram returns only the pinned message with the most recent sending date.
  Remove newer pins to make the management message discoverable again.
- If storage cannot be read or written, the bot reports a temporary error and
  does not deliver the user's input. It does not silently ignore restrictions.
- The snapshot has a 4,000-character budget including the guide and visible
  list. Capacity includes all registered user codes, not just blocked users.
  An over-capacity change is rejected instead of truncating saved data.
- Keep the same bot token: it derives the encryption key. Rotating the token
  requires migrating the snapshot with the previous key first.
- The visible list shows fixed expiry times in UTC. Expired bans stop applying
  on the next request; `/blockList` refreshes the visible list. No scheduled
  message is sent at expiry.
- Telegram message edits have no compare-and-set operation. Updates within one
  process are serialized, but overlapping writes from different Vercel instances
  can overwrite one another. Avoid simultaneous moderation changes. Set webhook
  `max_connections` to 1 when configuring the webhook to reduce overlap; this
  is not a replacement for transactional storage. For larger traffic or strict
  concurrency guarantees, use a database instead of the pinned snapshot.

Run verification with `node --test tests/moderation.test.cjs` and
`node node_modules/typescript/bin/tsc --noEmit --incremental false`.
