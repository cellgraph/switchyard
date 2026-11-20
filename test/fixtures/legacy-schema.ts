import type { DatabaseSync } from "node:sqlite";

export function removeDurableAgentMigration(db: DatabaseSync): void {
  db.exec(`
    DROP INDEX agent_operations_by_workflow;
    DROP INDEX one_unresolved_agent_operation;
    ALTER TABLE agent_sessions DROP COLUMN execution;
    ALTER TABLE worktrees DROP COLUMN execution;
    DELETE FROM schema_migrations WHERE version=8;
  `);
}
