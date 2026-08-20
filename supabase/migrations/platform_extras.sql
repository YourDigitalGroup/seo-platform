-- Platform extras: featured images, internal-link targets, Trello linkage.
-- Idempotent; safe to run more than once.

-- Pexels-picked featured image per draft (image-search Edge Function).
alter table content_drafts
  add column if not exists image_url text,
  add column if not exists image_alt text;

-- Auto-picked internal-link target per piece (strategist can change it in
-- the queue); the deploy package links the focus keyword to this URL.
alter table content_topics
  add column if not exists link_target text;

-- Trello card created by "Submit to SEO/AEO specialist" (trello function);
-- approval comments post to this card.
alter table clients
  add column if not exists trello_card_id text;
