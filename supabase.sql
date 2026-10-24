-- Paste this into Supabase: SQL Editor -> New query -> Run.
-- One row per user holds all of that user's ratings, pins and settings.
create table if not exists public.app_state (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

-- Each person can only see and change their own row.
drop policy if exists "own row" on public.app_state;
create policy "own row" on public.app_state
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
