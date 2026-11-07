import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSourcePath, walkFiles } from "../src/agent/tools/fs-shared.ts";

test("curriculum source boundary confines resolved paths and recursive walks", async () => {
 const scratch = path.join(os.homedir(), ".cache/inference-learning-tests"); fs.mkdirSync(scratch, {recursive:true});
 const root = fs.mkdtempSync(path.join(scratch, "lh-scope-"));
 const allowed = path.join(root, "materials"); fs.mkdirSync(allowed);
 const outside = path.join(root, "private.md"); fs.writeFileSync(outside, "not learning material");
 fs.writeFileSync(path.join(allowed, "lesson.md"), "lesson");
 fs.writeFileSync(path.join(allowed, ".env"), "not learning material");
 fs.symlinkSync(outside, path.join(allowed, "escape.md"));
 const before = process.env.LH_SOURCE_ROOTS;
 process.env.LH_SOURCE_ROOTS = JSON.stringify([allowed]);
 try {
  assert.equal(resolveSourcePath(), fs.realpathSync(allowed));
  assert.equal(resolveSourcePath("lesson.md"), path.join(allowed, "lesson.md"));
  assert.throws(() => resolveSourcePath(outside), /approved|scope|learning/i);
  assert.throws(() => resolveSourcePath("../private.md"), /approved|scope|learning/i);
  assert.throws(() => resolveSourcePath("escape.md"), /approved|scope|learning/i);
  assert.throws(() => resolveSourcePath(".env"), /sensitive|excluded/i);
  const visited: string[] = [];
  await walkFiles(allowed, p => { visited.push(path.basename(p)); return false; });
  assert.deepEqual(visited, ["lesson.md"]);
 } finally {
  if (before === undefined) delete process.env.LH_SOURCE_ROOTS; else process.env.LH_SOURCE_ROOTS = before;
  fs.rmSync(root, {recursive:true, force:true});
 }
});
