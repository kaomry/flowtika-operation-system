-- Gmail connection and the bank of past cold emails the Outreach Writer learns from.
create table google_accounts (
  email         text primary key,
  refresh_token text        not null,
  scopes        text        not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table outreach_examples (
  id               bigserial primary key,
  gmail_message_id text        not null unique,
  gmail_thread_id  text        not null,
  account          text        not null,
  sent_at          timestamptz not null,
  to_address       text        not null,
  to_name          text,
  subject          text        not null default '',
  body             text        not null,
  language         text        not null check (language in ('he', 'en', 'mixed')),
  word_count       integer     not null,
  replied          boolean     not null default false,
  replied_at       timestamptz,
  status           text        not null default 'candidate'
                     check (status in ('candidate', 'kept', 'skipped')),
  gold             boolean     not null default false,
  reviewed_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index outreach_examples_review on outreach_examples (sent_at desc) where status = 'candidate';
