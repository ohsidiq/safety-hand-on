-- Spike S-3: tabel bisnis dan efek untuk uji outbox saat crash.
drop table if exists s3_effect, s3_business;
truncate outbox_event restart identity;
create table s3_business (id bigserial primary key, v int not null);
create table s3_effect   (event_id bigint primary key, business_id bigint not null);
