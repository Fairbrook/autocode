import type { Db } from "../index.ts";
import { nowIso } from "../index.ts";
import type { ProjectRow } from "../../types.ts";
import type { ProjectSeed } from "../../config.ts";

export function upsertProjectSeeds(db: Db, seeds: ProjectSeed[]): void {
  const upsert = db.prepare(`
    INSERT INTO projects (name, repo_path, default_base_ref, rule_profile, allowed_network_domains, setup_command, allow_docker_socket, local_service_hosts, allow_unsandboxed_commands, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(name) DO UPDATE SET
      repo_path = excluded.repo_path,
      default_base_ref = excluded.default_base_ref,
      rule_profile = excluded.rule_profile,
      allowed_network_domains = excluded.allowed_network_domains,
      setup_command = excluded.setup_command,
      allow_docker_socket = excluded.allow_docker_socket,
      local_service_hosts = excluded.local_service_hosts,
      allow_unsandboxed_commands = excluded.allow_unsandboxed_commands
  `);
  for (const seed of seeds) {
    upsert.run(
      seed.name,
      seed.repoPath,
      seed.defaultBaseRef,
      seed.ruleProfile,
      JSON.stringify(seed.allowedNetworkDomains),
      seed.setupCommand,
      seed.allowDockerSocket ? 1 : 0,
      JSON.stringify(seed.localServiceHosts),
      seed.allowUnsandboxedCommands ? 1 : 0,
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
    /**
     * Root-equivalent; see ProjectSeed.allowDockerSocket. The HTTP handler for
     * POST /api/projects deliberately does not forward a client-supplied value
     * here — the grant belongs to config/projects.json, which needs filesystem
     * access to the server rather than just a session cookie.
     */
    allowDockerSocket?: boolean;
    /** See ProjectSeed.localServiceHosts. Same rule as allowDockerSocket: not forwarded from the HTTP handler. */
    localServiceHosts?: string[];
    /** See ProjectSeed.allowUnsandboxedCommands. Same rule as allowDockerSocket: not forwarded from the HTTP handler. */
    allowUnsandboxedCommands?: boolean;
  }
): ProjectRow {
  const result = db
    .prepare(
      `INSERT INTO projects (name, repo_path, default_base_ref, rule_profile, allowed_network_domains, setup_command, allow_docker_socket, local_service_hosts, allow_unsandboxed_commands, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(
      input.name,
      input.repoPath,
      input.defaultBaseRef ?? "HEAD",
      input.ruleProfile ?? null,
      JSON.stringify(input.allowedNetworkDomains ?? []),
      input.setupCommand ?? null,
      input.allowDockerSocket ? 1 : 0,
      JSON.stringify(input.localServiceHosts ?? []),
      input.allowUnsandboxedCommands ? 1 : 0,
      nowIso()
    );
  const row = getProject(db, Number(result.lastInsertRowid));
  if (!row) throw new Error("failed to read back created project");
  return row;
}
