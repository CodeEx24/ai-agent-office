// Test-only teardown for the run_events integration scripts (AGO-102).
// run_events is append-only and its parents are ON DELETE RESTRICT, so a test cannot clean up by
// deleting its workspace. This SQL runs as the postgres owner in ONE transaction: it switches the
// row-delete guard off, removes the test's events, switches the guard back on (ENABLE ALWAYS, as in
// the migration), then deletes the test workspaces. If anything fails the whole transaction rolls
// back, so the guard is never left disabled. Production code paths never use this.
export function teardownRunEventsSql(workspaceIds) {
  const ids = workspaceIds.map((id) => `'${id}'`).join(', ');
  return `
    begin;
    alter table public.run_events disable trigger run_events_block_update_delete;
    delete from public.run_events where workspace_id in (${ids});
    alter table public.run_events enable always trigger run_events_block_update_delete;
    delete from public.workspaces where id in (${ids});
    commit;`;
}
