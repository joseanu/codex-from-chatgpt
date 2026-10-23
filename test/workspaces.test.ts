import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveWorkspace, validateWorkspace } from "../src/workspaces.js";

test("canonical workspace stays under the configured root", async () => {
  const result = await validateWorkspace(process.cwd());
  assert.equal(result, process.cwd());
});

test("workspace traversal, outside path and invalid root are rejected", async () => {
  await assert.rejects(validateWorkspace(`${process.cwd()}/../.codex`), /segmentos '\.\.'/);
  await assert.rejects(validateWorkspace("/tmp"), /dentro de .*workspace/);
  await assert.rejects(validateWorkspace("/tmp", "/path/../unsafe"), /segmentos '\.\.'/);
});

test("workspace symlink under the configured root resolves to its canonical target", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-workspace-root-"));
  const outside = mkdtempSync(path.join(tmpdir(), "codex-workspace-outside-"));
  const link = path.join(root, "escape");
  symlinkSync(outside, link, "dir");
  const resolution = await resolveWorkspace(link, root);
  assert.equal(resolution.logical, link);
  assert.equal(resolution.canonical, realpathSync(outside));
  assert.equal(await validateWorkspace(link, root), realpathSync(outside));
  mkdirSync(path.join(root, "valid"));
  assert.equal(await validateWorkspace(path.join(root, "valid"), root), realpathSync(path.join(root, "valid")));
  await assert.rejects(validateWorkspace(outside, root), /dentro de/);
});
