-- Down migration: drop view first (it depends on tables), then tables in
-- reverse foreign-key dependency order.
drop view if exists org_usage;
drop table if exists step_runs;
drop table if exists workflow_runs;
drop table if exists workflow_triggers;
drop table if exists workflow_steps;
drop table if exists workflows;
drop table if exists org_members;
drop table if exists organizations;