#!/usr/bin/env bash
# Creates (or resets) a throwaway git repo used for manual smoke testing and
# for the end-to-end verification in the plan's Gate 4. Not part of the
# automated test suite (those use their own mkdtemp'd repos).
set -euo pipefail

TARGET="${1:-$HOME/.local/share/autocode/test-repo}"

rm -rf "$TARGET"
mkdir -p "$TARGET/src" "$TARGET/test"
cd "$TARGET"

git init -q
git config user.email "autocode-test@example.com"
git config user.name "autocode test"

cat > package.json << 'JSON'
{
  "name": "autocode-test-repo",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "vitest run" },
  "devDependencies": { "vitest": "^4.0.0" }
}
JSON

cat > src/add.js << 'JS'
export function add(a, b) {
  return a + b;
}
JS

cat > test/add.test.js << 'JS'
import { describe, it, expect } from "vitest";
import { add } from "../src/add.js";

describe("add", () => {
  it("adds two numbers", () => {
    expect(add(2, 3)).toBe(5);
  });
});
JS

cat > README.md << 'MD'
# autocode test repo

A throwaway repo for exercising the autocode harness end to end.
MD

git add -A
git commit -q -m "initial commit"

echo "Test repo ready at: $TARGET"
