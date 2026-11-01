-- Drafts the Outreach Writer produces, each revision a row, and the rules learned from comments.
create table outreach_drafts (
  id                  bigserial primary key,
  lead_page_id        text        not null,
  lead_name           text        not null,
  to_address          text,
  subject             text        not null,
  body                text        not null,
  angle               text        not null default '',
  status              text        not null default 'pending'
                        check (status in ('pending', 'saved', 'dropped', 'superseded')),
  revision            integer     not null default 1,
  parent_id           bigint      references outreach_drafts (id),
  feedback            text,
  telegram_message_id bigint,
  gmail_draft_id      text,
  created_at          timestamptz not null default now(),
  decided_at          timestamptz
);
create index outreach_drafts_lead on outreach_drafts (lead_page_id);
create index outreach_drafts_message on outreach_drafts (telegram_message_id);

create table outreach_rules (
  id              bigserial primary key,
  rule            text        not null,
  source_draft_id bigint      references outreach_drafts (id),
  active          boolean     not null default true,
  created_at      timestamptz not null default now()
);
