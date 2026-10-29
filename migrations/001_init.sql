-- Phase 0 foundation: conversation memory, approvals, audit log.
-- pgvector is enabled now so the Phase 1 knowledge layer can add embeddings without a new image.
create extension if not exists vector;

create table messages (
  id          bigserial primary key,
  chat_id     bigint      not null,
  role        text        not null check (role in ('user', 'assistant')),
  agent       text,
  content     text        not null,
  created_at  timestamptz not null default now()
);
create index messages_chat_created on messages (chat_id, created_at desc);

create table approvals (
  id                  uuid primary key default gen_random_uuid(),
  kind                text        not null,
  summary             text        not null,
  payload             jsonb       not null default '{}'::jsonb,
  requested_by        text        not null,
  status              text        not null default 'pending'
                        check (status in ('pending', 'approved', 'rejected', 'executed', 'failed')),
  telegram_chat_id    bigint,
  telegram_message_id bigint,
  result              jsonb,
  created_at          timestamptz not null default now(),
  decided_at          timestamptz,
  executed_at         timestamptz
);
create index approvals_status on approvals (status, created_at desc);

create table audit_log (
  id          bigserial primary key,
  actor       text        not null,
  action      text        not null,
  detail      jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_log_created on audit_log (created_at desc);
