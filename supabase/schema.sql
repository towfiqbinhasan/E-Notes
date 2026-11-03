-- NoteSheet database schema.
-- Run this whole file once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- It is safe to re-run: every statement checks whether the object already exists.

-- ============ Tables ============

create table if not exists notebooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Untitled',
  position int not null default 0,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  synced_at timestamptz not null default now()   -- set by the server on every write (pull cursor)
);

create table if not exists sheets (
  id uuid primary key default gen_random_uuid(),
  notebook_id uuid not null references notebooks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  position int not null default 0,
  height int not null default 1300,
  pdf_path text,          -- path in storage bucket "pdfs"
  pdf_page int,           -- page number inside that pdf
  pdf_name text,          -- original file name (used for "export one PDF")
  margin_side text not null default 'right',   -- 'right' | 'left' (note margin next to the PDF page)
  margin_width real not null default 0.4,      -- fraction of the sheet width used for notes
  strokes jsonb not null default '[]',         -- ink strokes AND text boxes, each with a unique id
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  synced_at timestamptz not null default now()
);

-- Added later: paper pattern of the notes area ('plain' | 'lined' | 'grid' | 'dotted').
alter table sheets add column if not exists paper text not null default 'plain';

create index if not exists notebooks_user_synced on notebooks (user_id, synced_at);
create index if not exists sheets_user_synced on sheets (user_id, synced_at);
create index if not exists sheets_notebook on sheets (notebook_id);

-- ============ Row level security ============

alter table notebooks enable row level security;
alter table sheets enable row level security;

drop policy if exists "own notebooks" on notebooks;
create policy "own notebooks" on notebooks for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own sheets" on sheets;
create policy "own sheets" on sheets for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============ Server timestamp (pull cursor, immune to device clock skew) ============

create or replace function set_synced_at() returns trigger language plpgsql as $$
begin
  new.synced_at := now();
  return new;
end $$;

drop trigger if exists notebooks_synced_at on notebooks;
create trigger notebooks_synced_at before insert or update on notebooks
  for each row execute function set_synced_at();

drop trigger if exists sheets_synced_at on sheets;
create trigger sheets_synced_at before insert or update on sheets
  for each row execute function set_synced_at();

-- ============ Merge helpers ============

-- Union of two stroke arrays by "id".
-- A tombstone (deleted_at set) always wins; otherwise the newest "updated" (or "created") wins.
create or replace function merge_strokes(a jsonb, b jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(s order by (s->>'created')::bigint, s->>'id'), '[]'::jsonb)
  from (
    select distinct on (x->>'id') x as s
    from (
      select jsonb_array_elements(coalesce(a, '[]'::jsonb)) as x
      union all
      select jsonb_array_elements(coalesce(b, '[]'::jsonb)) as x
    ) u
    order by x->>'id',
             (x->>'deleted_at') is null,                                    -- tombstones first
             coalesce((x->>'updated')::bigint, (x->>'created')::bigint, 0) desc
  ) t;
$$;

-- Notebook upsert with last-write-wins on updated_at. Tombstones are never undone.
create or replace function upsert_notebook(n jsonb) returns notebooks
language plpgsql security invoker as $$
declare r notebooks;
begin
  insert into notebooks as t (id, user_id, title, position, updated_at, deleted_at)
  values (
    (n->>'id')::uuid, auth.uid(),
    coalesce(n->>'title', 'Untitled'),
    coalesce((n->>'position')::int, 0),
    coalesce((n->>'updated_at')::timestamptz, now()),
    (n->>'deleted_at')::timestamptz
  )
  on conflict (id) do update set
    title      = case when excluded.updated_at > t.updated_at then excluded.title else t.title end,
    position   = case when excluded.updated_at > t.updated_at then excluded.position else t.position end,
    updated_at = greatest(t.updated_at, excluded.updated_at),
    deleted_at = coalesce(t.deleted_at, excluded.deleted_at)
  returning * into r;
  return r;
end $$;

-- Sheet upsert: strokes are merged (union by id), metadata is last-write-wins.
create or replace function upsert_sheet(s jsonb) returns sheets
language plpgsql security invoker as $$
declare r sheets;
begin
  insert into sheets as t (id, notebook_id, user_id, position, height, pdf_path, pdf_page, pdf_name,
                           margin_side, margin_width, paper, strokes, updated_at, deleted_at)
  values (
    (s->>'id')::uuid, (s->>'notebook_id')::uuid, auth.uid(),
    coalesce((s->>'position')::int, 0),
    coalesce((s->>'height')::int, 1300),
    s->>'pdf_path', (s->>'pdf_page')::int, s->>'pdf_name',
    coalesce(s->>'margin_side', 'right'),
    coalesce((s->>'margin_width')::real, 0.4),
    coalesce(s->>'paper', 'plain'),
    coalesce(s->'strokes', '[]'::jsonb),
    coalesce((s->>'updated_at')::timestamptz, now()),
    (s->>'deleted_at')::timestamptz
  )
  on conflict (id) do update set
    strokes      = merge_strokes(t.strokes, excluded.strokes),
    position     = case when excluded.updated_at > t.updated_at then excluded.position else t.position end,
    height       = case when excluded.updated_at > t.updated_at then excluded.height else t.height end,
    margin_side  = case when excluded.updated_at > t.updated_at then excluded.margin_side else t.margin_side end,
    margin_width = case when excluded.updated_at > t.updated_at then excluded.margin_width else t.margin_width end,
    paper        = case when excluded.updated_at > t.updated_at then excluded.paper else t.paper end,
    updated_at   = greatest(t.updated_at, excluded.updated_at),
    deleted_at   = coalesce(t.deleted_at, excluded.deleted_at)
  returning * into r;
  return r;
end $$;

grant execute on function upsert_notebook(jsonb) to authenticated;
grant execute on function upsert_sheet(jsonb) to authenticated;
grant execute on function merge_strokes(jsonb, jsonb) to authenticated;

-- ============ Live ink (Realtime broadcast on a private channel) ============
-- Strokes still being drawn are broadcast on the topic "enotes-live-<user id>".
-- Only that user's signed-in devices may send or receive on it.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'realtime' and table_name = 'messages') then
    drop policy if exists "enotes live ink receive" on realtime.messages;
    create policy "enotes live ink receive" on realtime.messages for select to authenticated
      using (realtime.topic() = 'enotes-live-' || auth.uid()::text);
    drop policy if exists "enotes live ink send" on realtime.messages;
    create policy "enotes live ink send" on realtime.messages for insert to authenticated
      with check (realtime.topic() = 'enotes-live-' || auth.uid()::text);
  end if;
end $$;

-- ============ Storage: private bucket "pdfs" ============
-- Files live at <user_id>/<sha256>.pdf. Users can only touch their own folder.

insert into storage.buckets (id, name, public)
values ('pdfs', 'pdfs', false)
on conflict (id) do nothing;

drop policy if exists "pdfs read own" on storage.objects;
create policy "pdfs read own" on storage.objects for select to authenticated
  using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "pdfs insert own" on storage.objects;
create policy "pdfs insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "pdfs update own" on storage.objects;
create policy "pdfs update own" on storage.objects for update to authenticated
  using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "pdfs delete own" on storage.objects;
create policy "pdfs delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text);
