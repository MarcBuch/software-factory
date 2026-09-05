import { execFile as nodeExecFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

export type GitBoundaryOptions = Readonly<{
  repositoryRoot: string;
  runtimeDirectory?: string;
  gitExecutable?: string;
  /** Test hook: throw at a named restore step, before changing anything at that step. */
  restoreFailure?: (step: string) => void;
  allowPreExistingUntracked?: boolean;
}>;

export type GitFileSnapshot = Readonly<{
  path: string;
  kind: "file" | "symlink" | "directory" | "missing" | "other";
  mode: number;
  content?: string;
  target?: string;
  gitMode: string;
}>;

export type GitBoundarySnapshotV2 = Readonly<{
  version: 2;
  repositoryRoot: string;
  index: string;
  tracked: readonly GitFileSnapshot[];
  /** V2 stored only path names. These paths are opaque and never restorable. */
  untracked: readonly string[];
  /** Launch-time evidence location, when retained by a v2 producer. */
  runtimeDirectory?: string;
}>;
export type GitBoundarySnapshot = Readonly<{
  version: 3;
  repositoryRoot: string;
  index: string;
  tracked: readonly GitFileSnapshot[];
  untracked: readonly GitFileSnapshot[];
  /** Relative, normalized runtime roots captured at launch. */
  runtimeExemptions: readonly string[];
}>;
export type AnyGitBoundarySnapshot = GitBoundarySnapshot | GitBoundarySnapshotV2;

export type GitBoundaryComparison = Readonly<{
  equal: boolean;
  indexChanged: boolean;
  trackedChanged: readonly string[];
  untrackedCreated: readonly string[];
  untrackedDeleted: readonly string[];
  untrackedChanged: readonly string[];
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
function isRuntime(o: GitBoundaryOptions, path: string, exemptions = runtimeRoots(o)) {
  const p = resolve(o.repositoryRoot, path);
  return exemptions.some((root) => {
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
async function untracked(o: GitBoundaryOptions, exemptions = runtimeRoots(o)) {
  const bytes = await git(o, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return Buffer.from(bytes)
    .toString()
    .split("\0")
    .filter(Boolean)
    .filter((p) => !isRuntime(o, p, exemptions));
}
async function untrackedSnapshots(
  o: GitBoundaryOptions,
  paths: readonly string[],
  exemptions = runtimeRoots(o),
) {
  const result = new Map<string, GitFileSnapshot>();
  const visit = async (path: string) => {
    if (isRuntime(o, path, exemptions) || result.has(path)) return;
    const absolute = safePath(o, path);
    const parent = dirname(path);
    if (parent !== "." && parent !== path) await visit(parent);
    const stat = await lstat(absolute).catch(() => undefined);
    if (!stat) return;
    const snapshot: GitFileSnapshot = stat.isSymbolicLink()
      ? {
          path,
          kind: "symlink",
          mode: stat.mode & 0o7777,
          target: await readlink(absolute),
          gitMode: "100644",
        }
      : stat.isFile()
        ? {
            path,
            kind: "file",
            mode: stat.mode & 0o7777,
            content: enc(await readFile(absolute)),
            gitMode: "100644",
          }
        : stat.isDirectory()
          ? { path, kind: "directory", mode: stat.mode & 0o7777, gitMode: "100644" }
          : { path, kind: "other", mode: stat.mode & 0o7777, gitMode: "100644" };
    result.set(path, snapshot);
    if (stat.isDirectory())
      for (const name of await readdir(absolute)) await visit(`${path}/${name}`);
  };
  for (const path of paths) await visit(path);
  return [...result.values()];
}
async function current(o: GitBoundaryOptions, exemptions = runtimeRoots(o)) {
  const index = await readFile(await indexPath(o));
  const entries = indexEntries(await git(o, ["ls-files", "--stage", "-z"]));
  const tracked = (await Promise.all(entries.map((e) => fileSnapshot(o, e)))).filter(
    (f) => !isRuntime(o, f.path, exemptions),
  );
  return { index, tracked, untracked: await untracked(o, exemptions) };
}

function normalizedExemptions(o: GitBoundaryOptions) {
  return runtimeRoots(o)
    .map((p) => relative(resolve(o.repositoryRoot), resolve(p)))
    .filter(Boolean);
}

export async function captureGitBoundary(o: GitBoundaryOptions): Promise<GitBoundarySnapshot> {
  const c = await current(o);
  if (c.untracked.length && !o.allowPreExistingUntracked)
    throw new Error(
      `Pre-existing untracked files outside runtime directory: ${c.untracked.join(", ")}`,
    );
  return {
    version: 3,
    repositoryRoot: resolve(o.repositoryRoot),
    index: enc(c.index),
    tracked: c.tracked,
    untracked: o.allowPreExistingUntracked ? await untrackedSnapshots(o, c.untracked) : [],
    runtimeExemptions: normalizedExemptions(o),
  };
}

export async function compareGitBoundary(
  s: AnyGitBoundarySnapshot,
  o: GitBoundaryOptions,
): Promise<GitBoundaryComparison> {
  const legacy = s.version === 2;
  const exemptions = legacy
    ? runtimeRoots(o)
    : s.runtimeExemptions.map((p) => resolve(s.repositoryRoot, p));
  const c = await current(o, exemptions);
  const before = new Map(s.tracked.map((f) => [f.path, f]));
  const after = new Map(c.tracked.map((f) => [f.path, f]));
  const trackedChanged = [...new Set([...before.keys(), ...after.keys()])].filter(
    (p) => JSON.stringify(before.get(p)) !== JSON.stringify(after.get(p)),
  );
  const baseline = legacy
    ? s.untracked.map((path) => ({ path, kind: "other" as const, mode: 0, gitMode: "100644" }))
    : s.untracked;
  const currentUntracked = await untrackedSnapshots(o, await untracked(o, exemptions), exemptions);
  const beforeUntracked = new Map(baseline.map((f) => [f.path, f]));
  const afterUntracked = new Map(currentUntracked.map((f) => [f.path, f]));
  const created = [...afterUntracked.keys()].filter((p) => !beforeUntracked.has(p));
  const deleted = [...beforeUntracked.keys()].filter((p) => !afterUntracked.has(p));
  const changedUntracked = [
    ...new Set([...beforeUntracked.keys(), ...afterUntracked.keys()]),
  ].filter((p) => JSON.stringify(beforeUntracked.get(p)) !== JSON.stringify(afterUntracked.get(p)));
  const runtimeChanges = (await git(o, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .toString()
    .split("\0")
    .filter(Boolean)
    .filter((p) => isRuntime(o, p, exemptions));
  const indexChanged = enc(c.index) !== s.index;
  return {
    equal: !indexChanged && !trackedChanged.length && !changedUntracked.length,
    indexChanged,
    trackedChanged,
    untrackedCreated: created,
    untrackedDeleted: deleted,
    untrackedChanged: changedUntracked,
    runtimeChanges,
  };
}

function evidenceDirectory(s: AnyGitBoundarySnapshot, launchOptions?: GitBoundaryOptions) {
  const root = resolve(s.repositoryRoot);
  if (s.version === 2) {
    // Old snapshots have no runtime authority.  Only the immutable launch
    // options (or an explicitly retained v2 location) may supply it; never
    // guess from a completion-time options object.
    const runtime = s.runtimeDirectory ?? launchOptions?.runtimeDirectory;
    if (!runtime) return undefined;
    return { root, dir: resolve(runtime) };
  }
  // v3 records all runtime exemptions at capture time.  The deepest one is
  // the launch runtime directory, while the snapshot root remains authoritative.
  const candidates = s.runtimeExemptions
    .map((path) => resolve(root, path))
    .filter((path) => {
      const r = relative(root, path);
      return r && !r.startsWith(`..${sep}`) && !isAbsolute(r);
    })
    .sort((a, b) => b.length - a.length);
  const dir = candidates[0];
  if (!dir) return undefined;
  return { root, dir };
}

async function evidence(
  s: AnyGitBoundarySnapshot,
  o: GitBoundaryOptions,
  error: unknown,
  launchOptions?: GitBoundaryOptions,
) {
  const location = evidenceDirectory(s, launchOptions);
  // A legacy snapshot without retained launch options cannot safely identify
  // an evidence directory.  Preserve the restoration error and write nothing.
  if (!location) return;
  const { root, dir } = location;
  await ensureDirectoryContained(root, dir);
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
    if (s && !s.isDirectory()) throw new Error(`Non-directory parent refused: ${path}`);
    if (!s) await mkdir(at, { mode: 0o755 });
  }
}
async function removeCreated(o: GitBoundaryOptions, path: string) {
  const p = safePath(o, path);
  await parentSafe(o, p);
  // Revalidate the parent immediately before mutating the entry. The remover
  // itself uses lstat and treats symlinks as leaves, never as directories.
  const parent = dirname(p);
  const ps = await lstat(parent);
  if (ps.isSymbolicLink() || !ps.isDirectory()) throw new Error(`Unsafe removal parent: ${p}`);
  await removeTreeWithoutLinks(p).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
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
  if (f.kind === "directory") {
    if (existing && !existing.isDirectory()) await removeTreeWithoutLinks(path);
    if (!existing || !existing.isDirectory()) await mkdir(path, { mode: f.mode });
    await chmod(path, f.mode);
    return;
  }
  if (f.kind === "missing" || f.kind === "other") {
    if (existing) await removeTreeWithoutLinks(path);
    return;
  }
  const afterLink = await lstat(path).catch(() => undefined);
  if (afterLink && !afterLink.isFile()) {
    await removeTreeWithoutLinks(path);
  }
  await writeFile(path, dec(f.content!));
  await chmod(path, f.mode);
}

export async function restoreGitBoundary(
  s: AnyGitBoundarySnapshot,
  o: GitBoundaryOptions,
  launchOptions?: GitBoundaryOptions,
): Promise<void> {
  try {
    const comparison = await compareGitBoundary(s, o);
    const wanted = new Map(s.tracked.map((f) => [f.path, f]));
    // V2 path-only baselines have no content or mode authority. Never remove,
    // overwrite, or recreate them; compare deliberately fails closed instead.
    const baseline = s.version === 2 ? [] : s.untracked;
    const trackedPaths = s.tracked.map((f) => f.path);
    const removableCreated = comparison.untrackedCreated.filter(
      (path) =>
        !(
          s.version === 2 &&
          s.untracked.some((base) => path === base || path.startsWith(`${base}/`))
        ) &&
        !s.tracked.some(
          (f) => f.path.startsWith(`${path}/`) || f.path.startsWith(`${path}${sep}`),
        ) &&
        !trackedPaths.includes(path),
    );
    for (const path of [...removableCreated].sort((a, b) => b.length - a.length)) {
      restoreHook(o, `untracked:${path}`);
      await removeCreated(o, path);
    }
    for (const f of [...baseline].sort((a, b) => a.path.length - b.path.length)) {
      if (
        comparison.untrackedChanged.includes(f.path) ||
        comparison.untrackedDeleted.includes(f.path)
      ) {
        restoreHook(o, `untracked:${f.path}`);
        await restoreOne(o, f);
      }
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
    await evidence(s, o, error, launchOptions);
    throw error;
  }
}

export const captureBoundary = captureGitBoundary;
export const compareBoundary = compareGitBoundary;
export const restoreBoundary = restoreGitBoundary;
