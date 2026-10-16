-- Client notes: free-form internal notes per client, edited on the Setup tab
-- or from the "notes" chip on a client card, and copied into the Trello
-- handoff card's description. Internal only (not in the looker_* views).
-- Idempotent; safe to run more than once.
alter table clients
  add column if not exists notes text;
