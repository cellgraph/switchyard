import type { DatabaseSync } from "node:sqlite";

export function removeDurableAgentMigration(db: DatabaseSync): void {
  db.exec(`
    DROP INDEX agent_operations_by_workflow;
    DROP INDEX one_unresolved_agent_operation;
    ALTER TABLE agent_sessions DROP COLUMN execution;
    ALTER TABLE worktrees DROP COLUMN execution;
    ALTER TABLE operations DROP COLUMN owner_pid;
    DROP TABLE github_observation_generations; DROP TABLE fix_cycles; DROP TABLE review_publications; DROP TABLE finding_actions; DROP TABLE review_findings; DROP TABLE review_runs; DELETE FROM schema_migrations WHERE version>=8;
  `);
}
