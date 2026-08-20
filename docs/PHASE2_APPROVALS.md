# Phase 2 — automated approval loop (spec, not yet built)

Scott's flow: strategist approval → client email approval/modification →
Trello → back to the strategist. Monthly batches so a client never faces six
months of blogs at once.

## Cadence
- **Cron on the 20th of each month** (pg_cron → a new `run-approvals` Edge
  Function, same Vault pattern as `run-scheduled`): for every active client,
  gather THIS month's approved-by-strategist pieces only.

## Loop per client, per month
1. Strategist approves drafts in the console (already built — approval also
   posts a comment to the client's Trello card).
2. On the 20th: `run-approvals` emails the client the month's content
   (the existing partner-branded "Client doc" HTML) with two links per
   piece: **Approve** / **Request changes** (signed tokens, no login).
3. A tiny public endpoint records the response:
   - Approve → piece marked `client_approved`; Trello card gets a
     "Client approved ✓" comment/checklist item.
   - Request changes → the note lands on the Trello card in the
     strategist's list, piece flips back to `drafted`, strategist notified.
4. Unanswered after 7 days → reminder email; after 14 → Trello comment
   flagging the stall (per contract, silence can count as approval — legal
   to confirm).

## Build inventory (rough)
- `run-approvals` Edge Function + cron row in schedules.sql (`0 15 20 * *`).
- Email provider secret (Resend/Postmark) — ~1 function to send.
- `content_topics.client_status` + `approval_tokens` migration.
- Public `approval-response` Edge Function (token → verdict).
- Console: client-status column in the queue.

## Also queued for a later phase
- **Reputation monitoring** — Scott has an API key coming; reserve secret
  name `REP_MONITORING_API_KEY` and a "Reputation" panel on tab ② when the
  provider + endpoints are known.
