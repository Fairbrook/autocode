import type { Db } from "../index.ts";
import { nowIso } from "../index.ts";
import type { ProjectRow } from "../../types.ts";
import type { ProjectSeed } from "../../config.ts";

export function upsertProjectSeeds(db: Db, seeds: ProjectSeed[]): void {
  const upsert = db.prepare(`
    INSERT INTO projects (name, repo_path, default_base_ref, rule_profile, allowed_network_domains, setup_command, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(name) DO UPDATE SET
      repo_path = excluded.repo_path,
      default_base_ref = excluded.default_base_ref,
      rule_profile = excluded.rule_profile,
      allowed_network_domains = excluded.allowed_network_domains,
      setup_command = excluded.setup_command
  `);
  for (const seed of seeds) {
    upsert.run(
      seed.name,
      seed.repoPath,
      seed.defaultBaseRef,
      seed.ruleProfile,
      JSON.stringify(seed.allowedNetworkDomains),
      seed.setupCommand,
      nowIso()
    );
  }
}

export function listProjects(db: Db): ProjectRow[] {
  return db
    .prepare("SELECT * FROM projects WHERE enabled = 1 ORDER BY name")
    .all() as unknown as ProjectRow[];
}

export function getProject(db: Db, id: number): ProjectRow | undefined {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
    | ProjectRow
    | undefined;
}

export function createProject(
  db: Db,
  input: {
    name: string;
    repoPath: string;
    defaultBaseRef?: string;
    ruleProfile?: string | null;
    allowedNetworkDomains?: string[];
    setupCommand?: string | null;
  }
): ProjectRow {
  const result = db
    .prepare(
      `INSERT INTO projects (name, repo_path, default_base_ref, rule_profile, allowed_network_domains, setup_command, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(
      input.name,
      input.repoPath,
      input.defaultBaseRef ?? "HEAD",
      input.ruleProfile ?? null,
      JSON.stringify(input.allowedNetworkDomains ?? []),
      input.setupCommand ?? null,
      nowIso()
    );
  const row = getProject(db, Number(result.lastInsertRowid));
  if (!row) throw new Error("failed to read back created project");
  return row;
}
