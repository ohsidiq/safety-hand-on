-- Setup spike S-1: peran login uji dan daftar pengguna untuk pgbench.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='app_runtime') then
    create role app_runtime login in role app_authenticated;
  end if;
end $$;
drop schema if exists bench cascade;
create schema bench;
create table bench.users (grp text, n int, user_id uuid, primary key (grp, n));
insert into bench.users
select 'spv_big', row_number() over (order by u.email), u.id
from app_user u join organization o on o.id = u.organization_id
where o.name = 'Besar 1' and u.email like 'spv%';
insert into bench.users
select 'mgr_big', 1, u.id from app_user u join organization o on o.id = u.organization_id
where o.name = 'Besar 1' and u.email like 'hsemgr@%';
insert into bench.users
select 'mgr_all', row_number() over (order by o.name), u.id
from app_user u join organization o on o.id = u.organization_id where u.email like 'hsemgr@%';
create table bench.workers (n int primary key, worker_id uuid);
insert into bench.workers select row_number() over (order by w.id), w.id
from worker w join organization o on o.id = w.organization_id where o.name = 'Besar 1';
grant usage on schema bench to app_runtime;
grant select on all tables in schema bench to app_runtime;
analyze;
