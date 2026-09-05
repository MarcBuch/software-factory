import { expect, test } from "bun:test";
import { execFile as nodeExecFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { BackendAdapter } from "../src/backend";
import { lookupRegistry } from "../src/roster";
import { startWorkflow, validateRuntimeRequirements } from "../src/workflow-service";

const execFile = promisify(nodeExecFile);

function fakeProcess() {
  return {
    pid: process.pid,
    command: ["fake-adapter"],
    exit: Promise.resolve({ code: 0, signal: null, signalCode: null }),
    kill() {},
    cancel() {},
    continue() {
      return this;
    },
    async *[Symbol.asyncIterator]() {},
  } as any;
}

test("rejects an adapter that lacks a required runtime capability", () => {
  expect(() =>
    validateRuntimeRequirements(lookupRegistry("planner"), {
      id: "read-only-fake",
      capabilities: ["repository.read"],
    }),
  ).toThrow("missing capabilities: repository.write");
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "factory-embedded-boundary-"));
  const git = (...args: string[]) => execFile("git", args, { cwd: root });
  await git("init", "-q");
  await git("config", "user.email", "boundary@example.invalid");
  await git("config", "user.name", "Embedded Boundary Test");
  await git("config", "commit.gpgsign", "false");
  await writeFile(join(root, "tracked.txt"), "baseline\n");
  await git("add", "tracked.txt");
  await git("commit", "-qm", "baseline");
  return root;
}

test("embedded startup failure restores writes made before backend failure", async () => {
  const root = await repository();
  try {
    const adapter: BackendAdapter = {
      id: "fake-boundary",
      capabilities: ["repository.read"],
      supportsConcurrent: true,
      start() {
        // Model this as an embedded SDK host doing synchronous setup before
        // reporting its startup failure. This file is outside planner/runtime
        // paths and must be classified and removed.
        writeFileSync(join(root, "forbidden-startup-write.txt"), "must be removed\n");
        throw new Error("deterministic embedded backend failure");
      },
    };
    const launch = await startWorkflow(
      root,
      { agentName: "scout", request: "inspect" },
      { adapter },
    );
    const run = await launch.completion;
    expect(run?.status).toBe("failed");
    expect(run?.failure?.code).toBe("BACKEND_FAILURE");
    expect(run?.failure?.message).toContain("Git boundary violation");
    await expect(readFile(join(root, "forbidden-startup-write.txt"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded workflows in one repository serialize boundary restoration", async () => {
  const root = await repository();
  try {
    const written = join(root, "forbidden-concurrent-write.txt");
    let starts = 0;
    let secondStartSawPreviousWrite: boolean | undefined;
    const adapter: BackendAdapter = {
      id: "fake-boundary",
      capabilities: ["repository.read"],
      supportsConcurrent: true,
      start() {
        starts += 1;
        if (starts === 2) secondStartSawPreviousWrite = existsSync(written);
        writeFileSync(written, `attempt ${starts}\n`);
        throw new Error("deterministic embedded backend failure");
      },
    };
    const first = startWorkflow(root, { agentName: "scout", request: "first" }, { adapter });
    const second = startWorkflow(root, { agentName: "scout", request: "second" }, { adapter });
    const launches = await Promise.all([first, second]);
    await Promise.all(launches.map((launch) => launch.completion));
    expect(starts).toBe(2);
    expect(secondStartSawPreviousWrite).toBe(false);
    await expect(readFile(written)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Scout restores allowed pre-existing untracked content at the workflow boundary", async () => {
  const root = await repository();
  try {
    const ancestor = join(root, "pre-existing", "nested");
    const original = join(ancestor, "original.txt");
    await (await import("node:fs/promises")).mkdir(ancestor, { recursive: true });
    await writeFile(original, "original bytes\n");
    await chmod(join(root, "pre-existing"), 0o751);
    await chmod(ancestor, 0o751);
    await chmod(original, 0o640);
    let starts = 0;
    const adapter: BackendAdapter = {
      id: "fake-boundary",
      capabilities: ["repository.read"],
      start() {
        starts += 1;
        return fakeProcess();
      },
    };
    const launch = await startWorkflow(
      root,
      { agentName: "scout", request: "inspect" },
      {
        adapter,
        executorFactory: () => ({
          async execute() {
            await rm(join(root, "pre-existing"), { recursive: true });
            await (await import("node:fs/promises")).mkdir(ancestor, { recursive: true });
            await writeFile(original, "mutated bytes\n");
            await chmod(join(root, "pre-existing"), 0o700);
            await chmod(ancestor, 0o700);
            await chmod(original, 0o600);
            await writeFile(join(root, "new-file.txt"), "remove me\n");
            await writeFile(join(root, ".factory", "runtime-marker"), "allowed\n");
            return {
              kind: "success" as const,
              attempts: 1,
              result: { status: "success" as const, summary: "ok", artifacts: [], notes: [] },
              events: [],
            };
          },
        }),
      },
    );
    const run = await launch.completion;
    expect(starts).toBe(1);
    expect(run?.status).toBe("failed");
    expect(run?.failure?.code).toBe("BOUNDARY_VIOLATION");
    expect(await readFile(original, "utf8")).toBe("original bytes\n");
    expect((await lstat(join(root, "pre-existing"))).mode & 0o7777).toBe(0o751);
    expect((await lstat(ancestor)).mode & 0o7777).toBe(0o751);
    expect((await lstat(original)).mode & 0o7777).toBe(0o640);
    await expect(lstat(join(root, "new-file.txt"))).rejects.toThrow();
    expect(await readFile(join(root, ".factory", "runtime-marker"), "utf8")).toBe("allowed\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Planner rejects pre-existing untracked content before adapter start", async () => {
  const root = await repository();
  try {
    await (
      await import("node:fs/promises")
    ).mkdir(join(root, "pre-existing", "nested"), {
      recursive: true,
    });
    await writeFile(join(root, "pre-existing", "nested", "file.txt"), "existing\n");
    let starts = 0;
    const adapter: BackendAdapter = {
      id: "fake-boundary",
      capabilities: ["repository.read", "repository.write", "workflow.delegate", "workflow.skill"],
      start() {
        starts += 1;
        return fakeProcess();
      },
    };
    await expect(
      startWorkflow(root, { agentName: "planner", request: "plan" }, { adapter }),
    ).rejects.toThrow("Pre-existing untracked files");
    expect(starts).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an untouched Scout succeeds with the same boundary policy", async () => {
  const root = await repository();
  try {
    const adapter: BackendAdapter = {
      id: "fake-boundary",
      capabilities: ["repository.read"],
      start: () => fakeProcess(),
    };
    const launch = await startWorkflow(
      root,
      { agentName: "scout", request: "inspect" },
      {
        adapter,
        executorFactory: () => ({
          async execute() {
            return {
              kind: "success" as const,
              attempts: 1,
              result: { status: "success" as const, summary: "ok", artifacts: [], notes: [] },
              events: [],
            };
          },
        }),
      },
    );
    expect((await launch.completion)?.status).toBe("succeeded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
