import { execFile as nodeExecFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rmdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

export type GitBoundaryOptions = Readonly<{
  repositoryRoot: string;
  runtimeDirectory?: string;
  gitExecutable?: string;
  /** Test hook: throw at a named restore step, before changing anything at that step. */
  restoreFailure?: (step: string) => void;
}>;

export type GitFileSnapshot = Readonly<{
  path: string;
  kind: "file" | "symlink" | "missing" | "other";
  mode: number;
  content?: string;
  target?: string;
  gitMode: string;
}>;

export type GitBoundarySnapshot = Readonly<{
  version: 2;
  repositoryRoot: string;
  index: string;
  tracked: readonly GitFileSnapshot[];
  untracked: readonly string[];
}>;

export type GitBoundaryComparison = Readonly<{
  equal: boolean;
  indexChanged: boolean;
  trackedChanged: readonly string[];
  untrackedCreated: readonly string[];
  untrackedDeleted: readonly string[];
  runtimeChanges: readonly string[];
}>;

const enc = (v: Uint8Array) => Buffer.from(v).toString("base64");
const dec = (v: string) => Buffer.from(v, "base64");

async function git(o: GitBoundaryOptions, args: string[]) {
  const r = await execFile(o.gitExecutable ?? "git", args, {
    cwd: o.repositoryRoot,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return Buffer.from(r.stdout);
}

function runtimeRoots(o: GitBoundaryOptions) {
  return [
    resolve(o.repositoryRoot, ".factory"),
    ...(o.runtimeDirectory ? [resolve(o.runtimeDirectory)] : []),
  ];
}
function isRuntime(o: GitBoundaryOptions, path: string) {
  const p = resolve(o.repositoryRoot, path);
  return runtimeRoots(o).some((root) => {
    const r = relative(root, p);
    return r === "" || (!r.startsWith(`..${sep}`) && r !== "..");
  });
}
function safePath(o: GitBoundaryOptions, path: string) {
  const root = resolve(o.repositoryRoot);
  const absolute = resolve(root, path);
  const r = relative(root, absolute);
  if (!r || r.startsWith(`..${sep}`) || isAbsolute(r))
    throw new Error(`Unsafe repository path: ${path}`);
  return absolute;
}

type Entry = { path: string; gitMode: string };
function indexEntries(bytes: Uint8Array): Entry[] {
  return Buffer.from(bytes)
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      const head = record.slice(0, tab).split(" ");
      return { path: record.slice(tab + 1), gitMode: head[0] ?? "100644" };
    });
}

async function fileSnapshot(o: GitBoundaryOptions, entry: Entry): Promise<GitFileSnapshot> {
  const path = safePath(o, entry.path);
  try {
    const s = await lstat(path);
    if (s.isSymbolicLink())
      return {
        path: entry.path,
        kind: "symlink",
        mode: s.mode & 0o7777,
        target: await readlink(path),
        gitMode: entry.gitMode,
      };
    if (s.isFile())
      return {
        path: entry.path,
        kind: "file",
        mode: s.mode & 0o7777,
        content: enc(await readFile(path)),
        gitMode: entry.gitMode,
      };
    return { path: entry.path, kind: "other", mode: s.mode & 0o7777, gitMode: entry.gitMode };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { path: entry.path, kind: "missing", mode: 0, gitMode: entry.gitMode };
    throw e;
  }
}

async function indexPath(o: GitBoundaryOptions) {
  const p = (await git(o, ["rev-parse", "--git-path", "index"])).toString().trim();
  return resolve(o.repositoryRoot, p);
}
async function untracked(o: GitBoundaryOptions) {
  const bytes = await git(o, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return Buffer.from(bytes)
    .toString()
    .split("\0")
    .filter(Boolean)
    .filter((p) => !isRuntime(o, p));
}
async function current(o: GitBoundaryOptions) {
  const index = await readFile(await indexPath(o));
  const entries = indexEntries(await git(o, ["ls-files", "--stage", "-z"]));
  const tracked = (await Promise.all(entries.map((e) => fileSnapshot(o, e)))).filter(
    (f) => !isRuntime(o, f.path),
  );
  return { index, tracked, untracked: await untracked(o) };
}

export async function captureGitBoundary(o: GitBoundaryOptions): Promise<GitBoundarySnapshot> {
  const c = await current(o);
  if (c.untracked.length)
    throw new Error(
      `Pre-existing untracked files outside runtime directory: ${c.untracked.join(", ")}`,
    );
  return {
    version: 2,
    repositoryRoot: resolve(o.repositoryRoot),
    index: enc(c.index),
    tracked: c.tracked,
    untracked: [],
  };
}

export async function compareGitBoundary(
  s: GitBoundarySnapshot,
  o: GitBoundaryOptions,
): Promise<GitBoundaryComparison> {
  const c = await current(o);
  const before = new Map(s.tracked.map((f) => [f.path, f]));
  const after = new Map(c.tracked.map((f) => [f.path, f]));
  const trackedChanged = [...new Set([...before.keys(), ...after.keys()])].filter(
    (p) => JSON.stringify(before.get(p)) !== JSON.stringify(after.get(p)),
  );
  const created = c.untracked.filter((p) => !s.untracked.includes(p));
  const deleted = s.untracked.filter((p) => !c.untracked.includes(p));
  const runtimeChanges = (await git(o, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .toString()
    .split("\0")
    .filter(Boolean)
    .filter((p) => isRuntime(o, p));
  const indexChanged = enc(c.index) !== s.index;
  return {
    equal: !indexChanged && !trackedChanged.length && !created.length && !deleted.length,
    indexChanged,
    trackedChanged,
    untrackedCreated: created,
    untrackedDeleted: deleted,
    runtimeChanges,
  };
}

async function evidence(s: GitBoundarySnapshot, o: GitBoundaryOptions, error: unknown) {
  if (!o.runtimeDirectory) return;
  const dir = resolve(o.runtimeDirectory);
  await ensureDirectoryContained(o.repositoryRoot, dir);
  const dirStat = await lstat(dir).catch(() => undefined);
  if (dirStat?.isSymbolicLink() || (dirStat && !dirStat.isDirectory()))
    throw new Error("Unsafe evidence directory");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const put = async (name: string, data: string | Uint8Array) => {
    const p = resolve(dir, name);
    const existing = await lstat(p).catch(() => undefined);
    if (existing?.isSymbolicLink() || (existing && !existing.isFile()))
      throw new Error(`Unsafe evidence path: ${name}`);
    await writeFile(p, data, { mode: 0o600 });
    await chmod(p, 0o600);
  };
  await put("boundary-snapshot.json", JSON.stringify(s, null, 2));
  await put("boundary-error.txt", String(error));
  try {
    await put(
      "boundary-status.txt",
      (await git(o, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toString(),
    );
  } catch {
    /* best effort */
  }
  try {
    await put("boundary-diff.patch", await git(o, ["diff", "HEAD", "--binary"]));
  } catch {
    /* best effort */
  }
}

/** Validate/create every runtime parent with lstat; never let mkdir follow a link. */
async function ensureDirectoryContained(rootInput: string, directory: string) {
  const root = resolve(rootInput);
  const r = relative(root, directory);
  if (!r || r.startsWith(`..${sep}`) || isAbsolute(r))
    throw new Error("Evidence directory is outside repository");
  let at = root;
  for (const part of r.split(sep)) {
    at = resolve(at, part);
    const existing = await lstat(at).catch(() => undefined);
    if (existing?.isSymbolicLink()) throw new Error(`Symlink evidence parent refused: ${at}`);
    if (existing && !existing.isDirectory())
      throw new Error(`Non-directory evidence parent: ${at}`);
    if (!existing) await mkdir(at, { mode: 0o700 });
  }
}

function restoreHook(o: GitBoundaryOptions, step: string) {
  o.restoreFailure?.(step);
}
async function parentSafe(o: GitBoundaryOptions, path: string) {
  const root = resolve(o.repositoryRoot);
  const parts = relative(root, path).split(sep);
  let at = root;
  for (const part of parts.slice(0, -1)) {
    at = resolve(at, part);
    const s = await lstat(at).catch(() => undefined);
    if (s?.isSymbolicLink()) throw new Error(`Symlink parent refused: ${path}`);
    if (!s) await mkdir(at, { mode: 0o755 });
  }
}
async function removeTreeWithoutLinks(path: string): Promise<void> {
  const s = await lstat(path);
  // Links are leaf nodes: unlink the directory entry and never inspect its target.
  if (s.isSymbolicLink()) {
    await unlink(path);
    return;
  }
  if (s.isDirectory()) {
    for (const name of await readdir(path)) await removeTreeWithoutLinks(resolve(path, name));
  }
  if (s.isDirectory()) await rmdir(path);
  else await unlink(path);
}
async function restoreOne(o: GitBoundaryOptions, f: GitFileSnapshot | undefined) {
  if (!f) return;
  const path = safePath(o, f.path);
  await parentSafe(o, path);
  const existing = await lstat(path).catch(() => undefined);
  if (f.kind === "symlink") {
    if (existing) {
      if (existing.isDirectory() && !existing.isSymbolicLink()) await removeTreeWithoutLinks(path);
      else await unlink(path);
    }
    await symlink(f.target!, path);
    return;
  }
  // A changed symlink must be removed before restoring a baseline regular file.
  if (existing?.isSymbolicLink()) {
    await unlink(path);
  }
  if (f.kind === "missing" || f.kind === "other") {
    if (existing) await rm(path, { force: true });
    return;
  }
  const afterLink = await lstat(path).catch(() => undefined);
  if (afterLink && !afterLink.isFile()) throw new Error(`Unsafe non-file at ${f.path}`);
  await writeFile(path, dec(f.content!));
  await chmod(path, f.mode);
}

export async function restoreGitBoundary(
  s: GitBoundarySnapshot,
  o: GitBoundaryOptions,
): Promise<void> {
  try {
    const comparison = await compareGitBoundary(s, o);
    if (comparison.untrackedDeleted.length)
      throw new Error(
        `Pre-existing untracked file was deleted: ${comparison.untrackedDeleted.join(", ")}`,
      );
    const wanted = new Map(s.tracked.map((f) => [f.path, f]));
    for (const path of comparison.untrackedCreated) {
      restoreHook(o, `untracked:${path}`);
      const p = safePath(o, path);
      await parentSafe(o, p);
      await rm(p, { recursive: true, force: true });
    }
    for (const path of comparison.trackedChanged) {
      restoreHook(o, `tracked:${path}`);
      await restoreOne(o, wanted.get(path));
    }
    restoreHook(o, "index");
    const ip = await indexPath(o);
    const is = await lstat(ip);
    if (is.isSymbolicLink()) throw new Error("Git index symlink refused");
    await writeFile(ip, dec(s.index));
    const verified = await compareGitBoundary(s, o);
    if (!verified.equal)
      throw new Error(`Boundary recovery verification failed: ${JSON.stringify(verified)}`);
  } catch (error) {
    await evidence(s, o, error);
    throw error;
  }
}

export const captureBoundary = captureGitBoundary;
export const compareBoundary = compareGitBoundary;
export const restoreBoundary = restoreGitBoundary;
