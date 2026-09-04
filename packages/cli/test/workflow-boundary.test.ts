import { expect, test } from "bun:test";
import { execFile as nodeExecFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { BackendAdapter } from "../src/backend";
import { startWorkflow } from "../src/workflow-service";

const execFile = promisify(nodeExecFile);

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
