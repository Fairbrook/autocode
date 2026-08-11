import fs from "node:fs";
import path from "node:path";

/**
 * Resolve `target` to its canonical form for containment checking.
 *
 * Bubblewrap-style symlink escapes are defeated by realpath-ing the nearest
 * EXISTING ancestor (not the full path) and rejoining the non-existent
 * remainder — this correctly rejects `evil-symlink -> /etc` while still
 * working for files the agent hasn't created yet.
 */
export function canonicalize(target: string): string {
  const abs = path.resolve(target);
  let ancestor = abs;
  let remainder: string[] = [];
  while (true) {
    if (fs.existsSync(ancestor)) break;
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break; // reached filesystem root without finding an existing ancestor
    remainder.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  let realAncestor: string;
  try {
    realAncestor = fs.realpathSync.native(ancestor);
  } catch {
    realAncestor = ancestor;
  }
  return remainder.length > 0 ? path.join(realAncestor, ...remainder) : realAncestor;
}

/** True iff `candidate` resolves to a path inside `root` (root itself counts as inside). */
export function isInsideRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = canonicalize(candidate);
  const resolvedRoot = canonicalize(root);
  if (resolvedCandidate === resolvedRoot) return true;
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface ContainmentResult {
  contained: boolean;
  /** True when `candidate` is inside an allowed root but also inside one of the deny-write carve-outs (e.g. .git/hooks). */
  deniedByCarveOut: boolean;
  matchedRoot?: string;
}

export function checkContainment(
  candidate: string,
  allowRoots: string[],
  denyRoots: string[]
): ContainmentResult {
  const deniedByCarveOut = denyRoots.some((deny) => isInsideRoot(candidate, deny));
  const matchedRoot = allowRoots.find((root) => isInsideRoot(candidate, root));
  return {
    contained: matchedRoot !== undefined && !deniedByCarveOut,
    deniedByCarveOut,
    matchedRoot,
  };
}
