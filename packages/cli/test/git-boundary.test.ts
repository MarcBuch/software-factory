import { expect, test } from "bun:test";
import { execFile as childExecFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  symlink,
  writeFile,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { captureGitBoundary, compareGitBoundary, restoreGitBoundary } from "../src/git-boundary";

const exec = promisify(childExecFile);
const run = async (cwd: string, ...args: string[]) => exec("git", args, { cwd });
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "factory-boundary-"));
  await run(root, "init", "-q");
  await run(root, "config", "user.email", "test@example.invalid");
  await run(root, "config", "user.name", "Boundary Test");
  await run(root, "config", "commit.gpgsign", "false");
  return root;
}
async function commit(root: string, path = "file.txt", value = "one") {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), value);
  await run(root, "add", "--", path);
  await run(root, "commit", "-qm", "initial");
}
const options = (repositoryRoot: string, runtimeDirectory?: string) => ({
  repositoryRoot,
  runtimeDirectory,
});

test("clean and dirty staged/unstaged baselines restore exactly", async () => {
  const root = await repo();
  await commit(root);
  const clean = await captureGitBoundary(options(root));
  expect((await compareGitBoundary(clean, options(root))).equal).toBe(true);
  await writeFile(join(root, "file.txt"), "two");
  await run(root, "add", "file.txt");
  const staged = await captureGitBoundary(options(root));
  await writeFile(join(root, "file.txt"), "three");
  expect((await compareGitBoundary(staged, options(root))).equal).toBe(false);
  await restoreGitBoundary(staged, options(root));
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("two");
});

test("rename and delete mutations restore", async () => {
  const root = await repo();
  await commit(root);
  const s = await captureGitBoundary(options(root));
  await run(root, "mv", "file.txt", "renamed.txt");
  await run(root, "rm", "-f", "renamed.txt");
  await restoreGitBoundary(s, options(root));
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("one");
});

test("rejects external untracked, excepts .factory", async () => {
  const root = await repo();
  await commit(root);
  await mkdir(join(root, ".factory"));
  await writeFile(join(root, ".factory", "run"), "x");
  expect(await captureGitBoundary(options(root))).toBeTruthy();
  await writeFile(join(root, "surprise"), "x");
  await expect(captureGitBoundary(options(root))).rejects.toThrow("untracked");
});

test("empty untracked directories are outside the Git boundary", async () => {
  const root = await repo();
  await commit(root);
  const empty = join(root, "empty", "nested");
  await mkdir(empty, { recursive: true });
  const snapshot = await captureGitBoundary(options(root));
  await (await import("node:fs/promises")).rm(join(root, "empty"), { recursive: true });
  expect((await compareGitBoundary(snapshot, options(root))).equal).toBe(true);
  await restoreGitBoundary(snapshot, options(root));
  await expect(lstat(empty)).rejects.toThrow();
});

test("runtime changes are ignored and created untracked files are removed", async () => {
  const root = await repo();
  await commit(root);
  const runtime = join(root, ".factory", "run");
  await mkdir(runtime, { recursive: true });
  const s = await captureGitBoundary(options(root, runtime));
  await writeFile(join(runtime, "log"), "runtime");
  await writeFile(join(root, "agent.txt"), "agent");
  const c = await compareGitBoundary(s, options(root, runtime));
  expect(c.equal).toBe(false);
  expect(c.runtimeChanges).toContain(".factory/run/log");
  await restoreGitBoundary(s, options(root, runtime));
  await expect(lstat(join(root, "agent.txt"))).rejects.toThrow();
});

test("newline filenames compare and restore", async () => {
  const root = await repo();
  await commit(root, "line\nname", "x");
  const s = await captureGitBoundary(options(root));
  await writeFile(join(root, "line\nname"), "y");
  expect((await compareGitBoundary(s, options(root))).trackedChanged).toContain("line\nname");
  await restoreGitBoundary(s, options(root));
  expect(await readFile(join(root, "line\nname"), "utf8")).toBe("x");
});

test("symlink replacement never writes externally and restores file", async () => {
  const root = await repo();
  await commit(root, "safe", "baseline");
  const outside = await mkdtemp(join(tmpdir(), "boundary-out-"));
  const target = join(outside, "target");
  await writeFile(target, "outside");
  const s = await captureGitBoundary(options(root));
  await (await import("node:fs/promises")).unlink(join(root, "safe"));
  await symlink(target, join(root, "safe"));
  await restoreGitBoundary(s, options(root));
  expect(await readFile(target, "utf8")).toBe("outside");
  expect(await readFile(join(root, "safe"), "utf8")).toBe("baseline");
});

test("symlinked runtime parent prevents external evidence writes", async () => {
  const root = await repo();
  await commit(root);
  const outside = await mkdtemp(join(tmpdir(), "runtime-out-"));
  await symlink(outside, join(root, ".factory"));
  const s = await captureGitBoundary(options(root, join(root, ".factory", "run")));
  await writeFile(join(root, "file.txt"), "changed");
  await expect(
    restoreGitBoundary(s, {
      ...options(root, join(root, ".factory", "run")),
      restoreFailure: () => {
        throw new Error("injected");
      },
    }),
  ).rejects.toThrow();
  await expect(lstat(join(outside, "run"))).rejects.toThrow();
});

test("baseline symlink replaced by directory restores exactly", async () => {
  const root = await repo();
  await mkdir(join(root, "target-parent"), { recursive: true });
  await symlink("target-parent", join(root, "link"));
  await run(root, "add", "link");
  await run(root, "commit", "-qm", "symlink");
  const s = await captureGitBoundary(options(root));
  await (await import("node:fs/promises")).unlink(join(root, "link"));
  await mkdir(join(root, "link"));
  await writeFile(join(root, "link", "junk"), "junk");
  await restoreGitBoundary(s, options(root));
  expect(await readlink(join(root, "link"))).toBe("target-parent");
});

test("nested symlinks in replacement directory are unlinked without external writes", async () => {
  const root = await repo();
  const outside = await mkdtemp(join(tmpdir(), "nested-link-out-"));
  const external = join(outside, "external.txt");
  await writeFile(external, "must remain");
  await symlink("target-parent", join(root, "link"));
  await run(root, "add", "link");
  await run(root, "commit", "-qm", "symlink");
  const snapshot = await captureGitBoundary(options(root));
  await (await import("node:fs/promises")).unlink(join(root, "link"));
  await mkdir(join(root, "link", "nested"), { recursive: true });
  await symlink(external, join(root, "link", "nested", "external-link"));
  await restoreGitBoundary(snapshot, options(root));
  expect(await readlink(join(root, "link"))).toBe("target-parent");
  expect(await readFile(external, "utf8")).toBe("must remain");
});

test("deleted parent directories are safely recreated", async () => {
  const root = await repo();
  await commit(root, "nested/deep.txt", "deep");
  const s = await captureGitBoundary(options(root));
  await (await import("node:fs/promises")).rm(join(root, "nested"), { recursive: true });
  await restoreGitBoundary(s, options(root));
  expect(await readFile(join(root, "nested/deep.txt"), "utf8")).toBe("deep");
});

test("failure injection produces private evidence and refuses evidence symlink", async () => {
  const root = await repo();
  await commit(root);
  const runtime = join(root, ".factory", "run");
  await mkdir(runtime, { recursive: true });
  const s = await captureGitBoundary(options(root, runtime));
  await writeFile(join(root, "file.txt"), "changed");
  let outside = await mkdtemp(join(tmpdir(), "evidence-out-"));
  const external = join(outside, "external");
  await writeFile(external, "keep");
  await symlink(external, join(runtime, "boundary-error.txt"));
  await expect(
    restoreGitBoundary(s, {
      ...options(root, runtime),
      restoreFailure: () => {
        throw new Error("injected");
      },
    }),
  ).rejects.toThrow();
  expect(await readFile(external, "utf8")).toBe("keep");
  const ds = await lstat(runtime);
  expect(ds.mode & 0o7777).toBe(0o700);
  expect((await lstat(join(runtime, "boundary-snapshot.json"))).mode & 0o7777).toBe(0o600);
});

test("v3 evidence ignores a changed completion runtime directory", async () => {
  const root = await repo();
  await commit(root);
  const runtime = join(root, ".factory", "run");
  const redirected = join(root, "redirected-runtime");
  await mkdir(runtime, { recursive: true });
  const snapshot = await captureGitBoundary(options(root, runtime));
  await writeFile(join(root, "file.txt"), "changed");
  await expect(
    restoreGitBoundary(snapshot, {
      ...options(root, redirected),
      restoreFailure: () => {
        throw new Error("injected");
      },
    }),
  ).rejects.toThrow();
  expect(await readFile(join(runtime, "boundary-error.txt"), "utf8")).toContain("injected");
  await expect(lstat(join(redirected, "boundary-error.txt"))).rejects.toThrow();
});

test("v2 path-only baseline fails closed without deleting its path", async () => {
  const root = await repo();
  await commit(root);
  await writeFile(join(root, "old.txt"), "keep");
  const v3 = await captureGitBoundary({ ...options(root), allowPreExistingUntracked: true });
  const legacy = {
    version: 2 as const,
    repositoryRoot: v3.repositoryRoot,
    index: v3.index,
    tracked: v3.tracked,
    untracked: ["old.txt"],
  };
  await writeFile(join(root, "old.txt"), "changed");
  await writeFile(join(root, "new.txt"), "new");
  await expect(restoreGitBoundary(legacy, options(root))).rejects.toThrow(
    "recovery verification failed",
  );
  expect(await readFile(join(root, "old.txt"), "utf8")).toBe("changed");
  await expect(lstat(join(root, "new.txt"))).rejects.toThrow();
});

test("allowed untracked snapshots include ancestor directory modes", async () => {
  const root = await repo();
  await commit(root);
  await mkdir(join(root, "untracked", "nested"), { recursive: true });
  await writeFile(join(root, "untracked", "nested", "file.txt"), "one");
  await chmod(join(root, "untracked"), 0o751);
  const snapshot = await captureGitBoundary({ ...options(root), allowPreExistingUntracked: true });
  expect(snapshot.untracked.find((entry) => entry.path === "untracked")?.mode).toBe(0o751);
  await chmod(join(root, "untracked"), 0o700);
  await restoreGitBoundary(snapshot, options(root));
  expect((await lstat(join(root, "untracked"))).mode & 0o7777).toBe(0o751);
});
