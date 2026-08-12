-- step_runs may be marked "skipped" by conditional branches
alter table step_runs
  drop constraint step_runs_status_check,
  add constraint step_runs_status_check
    check (status in ('pending','running','paused','completed','failed','skipped'));
