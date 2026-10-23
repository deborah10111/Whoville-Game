create table if not exists public.game_rooms (
  id uuid primary key default gen_random_uuid(),
  join_code text not null unique,
  host_user_id uuid not null references auth.users(id) on delete cascade,
  grinch_count integer not null check (grinch_count between 1 and 5),
  different_teams boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.game_teams (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.game_rooms(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 24),
  color text not null check (color ~ '^#[0-9A-Fa-f]{6}$'),
  cash bigint not null default 300000 check (cash >= 0),
  sort_order integer not null,
  created_at timestamptz not null default now(),
  unique (room_id, sort_order)
);

create table if not exists public.game_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.game_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  team_id uuid not null references public.game_teams(id),
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at timestamptz not null default now(),
  unique (room_id, user_id)
);

create table if not exists public.game_roles (
  player_id uuid primary key references public.game_players(id) on delete cascade,
  room_id uuid not null references public.game_rooms(id) on delete cascade,
  role text not null check (role in ('who', 'grinch')),
  assigned_at timestamptz not null default now()
);

create index if not exists game_players_room_id_idx on public.game_players(room_id);
create index if not exists game_players_user_id_idx on public.game_players(user_id);
create index if not exists game_roles_room_id_idx on public.game_roles(room_id);

alter table public.game_rooms enable row level security;
alter table public.game_teams enable row level security;
alter table public.game_players enable row level security;
alter table public.game_roles enable row level security;

create or replace function public.is_game_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.game_players p
    where p.room_id = p_room_id and p.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_game_host(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.game_rooms r
    where r.id = p_room_id and r.host_user_id = (select auth.uid())
  );
$$;

drop policy if exists "Members can read their room" on public.game_rooms;
drop policy if exists "Members can read team scores" on public.game_teams;
drop policy if exists "Players and their host can read the roster" on public.game_players;
drop policy if exists "Players can read only their own role" on public.game_roles;

create policy "Members can read their room"
  on public.game_rooms for select to authenticated
  using (public.is_game_member(id) or host_user_id = (select auth.uid()));

create policy "Members can read team scores"
  on public.game_teams for select to authenticated
  using (public.is_game_member(room_id));

create policy "Players and their host can read the roster"
  on public.game_players for select to authenticated
  using (user_id = (select auth.uid()) or public.is_game_host(room_id));

create policy "Players can read only their own role"
  on public.game_roles for select to authenticated
  using (
    exists (
      select 1
      from public.game_players p
      where p.id = player_id and p.user_id = (select auth.uid())
    )
  );

revoke all on public.game_rooms, public.game_teams, public.game_players, public.game_roles from anon, authenticated;
grant select on public.game_rooms, public.game_teams, public.game_players, public.game_roles to authenticated;

create or replace function public.create_game(
  p_team_names text[],
  p_team_colors text[],
  p_grinch_count integer,
  p_different_teams boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_room_id uuid;
  new_join_code text;
  team_index integer;
begin
  if auth.uid() is null then
    raise exception 'Sign in before creating a game.';
  end if;
  if coalesce(array_length(p_team_names, 1), 0) not between 2 and 5
     or array_length(p_team_colors, 1) is distinct from array_length(p_team_names, 1) then
    raise exception 'Choose between two and five teams.';
  end if;
  if p_grinch_count not between 1 and 5 then
    raise exception 'Choose between one and five Grinches.';
  end if;
  if p_different_teams and p_grinch_count > array_length(p_team_names, 1) then
    raise exception 'There must be at least as many teams as Grinches when they must be on different teams.';
  end if;
  if exists (
    select 1 from unnest(p_team_names) as names(name)
    where name is null or char_length(trim(name)) not between 1 and 24
  ) or exists (
    select 1 from unnest(p_team_colors) as colors(color)
    where color is null or color !~ '^#[0-9A-Fa-f]{6}$'
  ) then
    raise exception 'Check each team name and color.';
  end if;

  loop
    new_join_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
    exit when not exists (select 1 from public.game_rooms r where r.join_code = new_join_code);
  end loop;

  insert into public.game_rooms (join_code, host_user_id, grinch_count, different_teams)
  values (new_join_code, auth.uid(), p_grinch_count, coalesce(p_different_teams, false))
  returning id into new_room_id;

  for team_index in 1..array_length(p_team_names, 1) loop
    insert into public.game_teams (room_id, name, color, sort_order)
    values (new_room_id, trim(p_team_names[team_index]), p_team_colors[team_index], team_index);
  end loop;

  return jsonb_build_object('room_id', new_room_id, 'join_code', new_join_code);
end;
$$;

create or replace function public.join_game(p_join_code text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  room_row public.game_rooms%rowtype;
  assigned_team_id uuid;
  new_player_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in before joining a game.';
  end if;
  if char_length(trim(coalesce(p_display_name, ''))) not between 1 and 40 then
    raise exception 'Enter a player name between 1 and 40 characters.';
  end if;
  select * into room_row
  from public.game_rooms r
  where r.join_code = upper(trim(coalesce(p_join_code, '')));
  if not found then
    raise exception 'That game code was not found.';
  end if;
  if exists (
    select 1 from public.game_players p
    where p.room_id = room_row.id and p.user_id = auth.uid()
  ) then
    raise exception 'This account already joined that game.';
  end if;

  select t.id into assigned_team_id
  from public.game_teams t
  left join public.game_players p on p.team_id = t.id and p.room_id = room_row.id
  where t.room_id = room_row.id
  group by t.id
  order by count(p.id), random()
  limit 1;

  insert into public.game_players (room_id, user_id, team_id, display_name)
  values (room_row.id, auth.uid(), assigned_team_id, trim(p_display_name))
  returning id into new_player_id;

  delete from public.game_roles where room_id = room_row.id;
  insert into public.game_roles (player_id, room_id, role)
  select p.id, p.room_id, 'who'
  from public.game_players p
  where p.room_id = room_row.id;

  return new_player_id;
end;
$$;

create or replace function public.distribute_players(p_room_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_game_host(p_room_id) then
    raise exception 'Only the game host can distribute players.';
  end if;

  with ranked_players as (
    select p.id, row_number() over (order by random()) - 1 as player_index
    from public.game_players p
    where p.room_id = p_room_id
  ),
  ranked_teams as (
    select t.id, row_number() over (order by t.sort_order) - 1 as team_index
    from public.game_teams t
    where t.room_id = p_room_id
  ),
  assignments as (
    select rp.id as player_id, rt.id as team_id
    from ranked_players rp
    join ranked_teams rt on rt.team_index = mod(rp.player_index, (select count(*) from ranked_teams))
  )
  update public.game_players p
  set team_id = assignments.team_id
  from assignments
  where p.id = assignments.player_id;

  delete from public.game_roles where room_id = p_room_id;
  insert into public.game_roles (player_id, room_id, role)
  select p.id, p.room_id, 'who'
  from public.game_players p
  where p.room_id = p_room_id;

  return true;
end;
$$;

create or replace function public.assign_grinches(p_room_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  room_row public.game_rooms%rowtype;
  player_count integer;
  team_count integer;
  selected_player_ids uuid[];
begin
  if not public.is_game_host(p_room_id) then
    raise exception 'Only the game host can assign secret roles.';
  end if;

  select * into room_row from public.game_rooms r where r.id = p_room_id;
  select count(*) into player_count from public.game_players p where p.room_id = p_room_id;
  if player_count < room_row.grinch_count then
    raise exception 'There are not enough players for the selected number of Grinches.';
  end if;

  if room_row.different_teams then
    select count(distinct p.team_id) into team_count
    from public.game_players p where p.room_id = p_room_id;
    if team_count < room_row.grinch_count then
      raise exception 'Not enough represented teams for the selected number of Grinches.';
    end if;
    select array_agg(selected.id) into selected_player_ids
    from (
      select one_per_team.id
      from (
        select distinct on (p.team_id) p.id, p.team_id
        from public.game_players p
        where p.room_id = p_room_id
        order by p.team_id, random()
      ) as one_per_team
      order by random()
      limit room_row.grinch_count
    ) as selected;
  else
    select array_agg(selected.id) into selected_player_ids
    from (
      select p.id
      from public.game_players p
      where p.room_id = p_room_id
      order by random()
      limit room_row.grinch_count
    ) as selected;
  end if;

  delete from public.game_roles where room_id = p_room_id;
  insert into public.game_roles (player_id, room_id, role)
  select p.id, p.room_id,
    case when p.id = any(selected_player_ids) then 'grinch' else 'who' end
  from public.game_players p
  where p.room_id = p_room_id;

  return true;
end;
$$;

create or replace function public.update_game_player(
  p_room_id uuid,
  p_player_id uuid,
  p_display_name text,
  p_team_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_team_id uuid;
begin
  if not public.is_game_host(p_room_id) then
    raise exception 'Only the game host can edit the roster.';
  end if;
  if char_length(trim(coalesce(p_display_name, ''))) not between 1 and 40 then
    raise exception 'Player names must be between 1 and 40 characters.';
  end if;
  if not exists (
    select 1 from public.game_teams t
    where t.id = p_team_id and t.room_id = p_room_id
  ) then
    raise exception 'Choose a team in this game.';
  end if;

  select p.team_id into old_team_id
  from public.game_players p
  where p.id = p_player_id and p.room_id = p_room_id;
  if not found then
    raise exception 'That player is not in this game.';
  end if;

  update public.game_players
  set display_name = trim(p_display_name), team_id = p_team_id
  where id = p_player_id and room_id = p_room_id;

  if old_team_id <> p_team_id then
    delete from public.game_roles where room_id = p_room_id;
    insert into public.game_roles (player_id, room_id, role)
    select p.id, p.room_id, 'who'
    from public.game_players p
    where p.room_id = p_room_id;
  end if;
  return true;
end;
$$;

create or replace function public.remove_game_player(p_room_id uuid, p_player_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_game_host(p_room_id) then
    raise exception 'Only the game host can remove players.';
  end if;
  if exists (
    select 1 from public.game_players p
    where p.id = p_player_id and p.room_id = p_room_id and p.user_id = auth.uid()
  ) then
    raise exception 'The host cannot remove their own player account.';
  end if;

  delete from public.game_players
  where id = p_player_id and room_id = p_room_id;
  if not found then
    raise exception 'That player is not in this game.';
  end if;

  delete from public.game_roles where room_id = p_room_id;
  insert into public.game_roles (player_id, room_id, role)
  select p.id, p.room_id, 'who'
  from public.game_players p
  where p.room_id = p_room_id;
  return true;
end;
$$;

create or replace function public.update_game_team(
  p_room_id uuid,
  p_team_id uuid,
  p_name text,
  p_color text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_game_host(p_room_id) then
    raise exception 'Only the game host can edit teams.';
  end if;
  if char_length(trim(coalesce(p_name, ''))) not between 1 and 24 then
    raise exception 'Team names must be between 1 and 24 characters.';
  end if;
  if p_color !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception 'Choose a valid team color.';
  end if;

  update public.game_teams
  set name = trim(p_name), color = p_color
  where id = p_team_id and room_id = p_room_id;
  if not found then
    raise exception 'That team is not in this game.';
  end if;
  return true;
end;
$$;

create or replace function public.get_my_game()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  player_row public.game_players%rowtype;
  room_row public.game_rooms%rowtype;
  player_role text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to view your game.';
  end if;
  select p.* into player_row
  from public.game_players p
  where p.user_id = auth.uid()
  order by p.created_at desc
  limit 1;
  if not found then
    return null;
  end if;
  select r.* into room_row
  from public.game_rooms r
  where r.id = player_row.room_id;
  if not found then
    return null;
  end if;

  select coalesce(r.role, 'who') into player_role
  from (select player_row.id as id) own_player
  left join public.game_roles r on r.player_id = own_player.id;

  return jsonb_build_object(
    'room_id', room_row.id,
    'join_code', room_row.join_code,
    'player_id', player_row.id,
    'player_name', player_row.display_name,
    'is_host', room_row.host_user_id = auth.uid(),
    'role', player_role,
    'grinch_count', room_row.grinch_count,
    'teams', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'color', t.color, 'cash', t.cash
      ) order by t.sort_order), '[]'::jsonb)
      from public.game_teams t where t.room_id = room_row.id
    ),
    'players', case when room_row.host_user_id = auth.uid() then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'display_name', p.display_name, 'team_id', p.team_id
      ) order by p.created_at), '[]'::jsonb)
      from public.game_players p where p.room_id = room_row.id
    ) else '[]'::jsonb end,
    'mission', case when player_role = 'grinch'
      then 'You have been selected as a GRINCH; your mission is to cause discourse within other teams or maybe your own.'
      else null end,
    'grinch_names', case when player_role = 'grinch' then (
      select coalesce(jsonb_agg(p.display_name order by p.display_name), '[]'::jsonb)
      from public.game_players p
      join public.game_roles gr on gr.player_id = p.id
      where p.room_id = room_row.id and gr.role = 'grinch' and p.id <> player_row.id
    ) else '[]'::jsonb end
  );
end;
$$;

revoke all on function public.is_game_member(uuid) from public, anon;
revoke all on function public.is_game_host(uuid) from public, anon;
revoke all on function public.create_game(text[], text[], integer, boolean) from public, anon;
revoke all on function public.join_game(text, text) from public, anon;
revoke all on function public.distribute_players(uuid) from public, anon;
revoke all on function public.assign_grinches(uuid) from public, anon;
revoke all on function public.update_game_player(uuid, uuid, text, uuid) from public, anon;
revoke all on function public.remove_game_player(uuid, uuid) from public, anon;
revoke all on function public.update_game_team(uuid, uuid, text, text) from public, anon;
revoke all on function public.get_my_game() from public, anon;

grant execute on function public.is_game_member(uuid) to authenticated;
grant execute on function public.is_game_host(uuid) to authenticated;
grant execute on function public.create_game(text[], text[], integer, boolean) to authenticated;
grant execute on function public.join_game(text, text) to authenticated;
grant execute on function public.distribute_players(uuid) to authenticated;
grant execute on function public.assign_grinches(uuid) to authenticated;
grant execute on function public.update_game_player(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.remove_game_player(uuid, uuid) to authenticated;
grant execute on function public.update_game_team(uuid, uuid, text, text) to authenticated;
grant execute on function public.get_my_game() to authenticated;
