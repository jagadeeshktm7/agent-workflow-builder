-- Phase 1: core schema for AI Agent Workflow Builder
-- References auth.users(id) — nhost's built-in auth schema, already exists.

create extension if not exists pgcrypto;

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  quota_limit int not null default 1000,
  quota_used int not null default 0,
  created_at timestamptz not null default now()
);

create table org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','editor','viewer')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index on org_members (org_id);
create index on org_members (user_id);

create table workflows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on workflows (org_id);

create table workflow_steps (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  position int not null,
  type text not null check (type in
    ('llm_call','http_request','db_write','notify','conditional_branch','approval_gate')),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workflow_id, position)
);
create index on workflow_steps (workflow_id);

create table workflow_triggers (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  type text not null check (type in ('manual','webhook','scheduled','db_event')),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on workflow_triggers (workflow_id);

create table workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  status text not null check (status in
    ('pending','running','paused','completed','failed')) default 'pending',
  triggered_by uuid references auth.users(id),
  trigger_type text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create index on workflow_runs (workflow_id);
create index on workflow_runs (org_id);

create table step_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references workflow_runs(id) on delete cascade,
  workflow_step_id uuid not null references workflow_steps(id) on delete cascade,
  status text not null check (status in
    ('pending','running','paused','completed','failed')) default 'pending',
  input jsonb,
  output jsonb,
  error text,
  attempt_count int not null default 0,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz
);
create index on step_runs (workflow_run_id);
create index on step_runs (workflow_step_id);

-- Aggregation: org-level usage view (calls used this "period" = lifetime quota_used for now)
create view org_usage as
select
  o.id as org_id,
  o.name as org_name,
  o.quota_limit,
  o.quota_used,
  count(distinct wr.id) as total_runs,
  count(distinct wr.id) filter (where wr.status = 'completed') as completed_runs
from organizations o
left join workflow_runs wr on wr.org_id = o.id
group by o.id, o.name, o.quota_limit, o.quota_used;