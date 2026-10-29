-- Phase 1: tasks with statuses, due dates, priorities and reminders.
create table tasks (
  id           bigserial primary key,
  title        text        not null,
  notes        text,
  status       text        not null default 'todo'
                 check (status in ('todo', 'in_progress', 'waiting', 'done', 'cancelled')),
  priority     text        not null default 'normal'
                 check (priority in ('low', 'normal', 'high')),
  due_at       timestamptz,
  reminded_at  timestamptz,
  source       text        not null default 'owner',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index tasks_open_due on tasks (due_at) where status in ('todo', 'in_progress', 'waiting');
