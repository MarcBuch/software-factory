import { execFile } from "node:child_process";
import { mkdir, open, readFile, rm, stat, rename, writeFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";
const exec = promisify(execFile);
async function sync(file: string) {
  const h = await open(file, "r");
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}
async function replace(file: string, data: string) {
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await sync(tmp);
    await rename(tmp, file);
    await sync(join(file, ".."));
  } finally {
    await rm(tmp, { force: true });
  }
}
const ContentSchema = z.object({ present: z.boolean(), data: z.string() }).strict();
const JournalSchema = z
  .object({
    phase: z.enum(["prepare", "committed"]),
    planFile: z.string(),
    missionFile: z.string(),
    originalPlans: ContentSchema,
    originalMissions: ContentSchema,
    planData: ContentSchema,
    missionData: ContentSchema,
  })
  .strict();
type PairValue = string | undefined;
async function replaceMaybe(file: string, data: PairValue) {
  if (data === undefined) {
    await rm(file, { force: true });
    await sync(join(file, ".."));
  } else await replace(file, data);
}
export async function recoverFactoryTransaction(repositoryRoot?: string) {
  const base = repositoryRoot ?? (await root()),
    dir = join(base, ".factory"),
    journal = join(dir, "plan-cascade.transaction.json");
  if (!(await Bun.file(journal).exists())) return;
  const parsed = JournalSchema.safeParse(JSON.parse(await Bun.file(journal).text()));
  if (!parsed.success) throw Error("Invalid Factory transaction journal");
  const tx = parsed.data;
  const canonicalBase = await realpath(base),
    expectedPlans = join(canonicalBase, ".factory", "plans.jsonl"),
    expectedMissions = join(canonicalBase, ".factory", "missions.jsonl");
  if (resolve(tx.planFile) !== expectedPlans || resolve(tx.missionFile) !== expectedMissions)
    throw Error("Invalid Factory transaction paths");
  const committed = tx.phase === "committed";
  const planTarget = committed ? tx.planData : tx.originalPlans;
  const missionTarget = committed ? tx.missionData : tx.originalMissions;
  await replaceMaybe(tx.planFile, planTarget.present ? planTarget.data : undefined);
  await replaceMaybe(tx.missionFile, missionTarget.present ? missionTarget.data : undefined);
  await rm(journal, { force: true });
  await sync(dir);
}
export async function replaceFactoryPair(
  repositoryRoot: string,
  plans: PairValue,
  missions: PairValue,
  originalPlans: PairValue,
  originalMissions: PairValue,
) {
  const base = await realpath(resolve(repositoryRoot)),
    dir = join(base, ".factory"),
    planFile = join(dir, "plans.jsonl"),
    missionFile = join(dir, "missions.jsonl"),
    journal = join(dir, "plan-cascade.transaction.json");
  const content = (data: PairValue) => ({ present: data !== undefined, data: data ?? "" });
  const payload = JSON.stringify({
    phase: "prepare",
    planFile,
    missionFile,
    originalPlans: content(originalPlans),
    originalMissions: content(originalMissions),
    planData: content(plans),
    missionData: content(missions),
  });
  await replace(journal, payload);
  try {
    if (process.env.FACTORY_TEST_FAIL_PLAN_CASCADE === "after-plans")
      throw Error("simulated plan cascade failure");
    await replaceMaybe(planFile, plans);
    await replaceMaybe(missionFile, missions);
    await replace(journal, JSON.stringify({ ...JSON.parse(payload), phase: "committed" }));
    await rm(journal, { force: true });
    await sync(dir);
  } catch (error) {
    await replaceMaybe(planFile, originalPlans);
    await replaceMaybe(missionFile, originalMissions);
    await replace(
      journal,
      JSON.stringify({
        ...JSON.parse(payload),
        phase: "committed",
        planData: content(originalPlans),
        missionData: content(originalMissions),
      }),
    );
    await rm(journal, { force: true });
    await sync(dir);
    throw error;
  }
}
async function root() {
  try {
    return (
      await exec("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() })
    ).stdout.trim();
  } catch {
    throw Error("factory must be run inside a Git worktree");
  }
}
async function owner(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8")) as { pid: number; token: string };
  } catch {
    return undefined;
  }
}
async function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function withFactoryLock<T>(repositoryRoot: string, fn: () => Promise<T>): Promise<T> {
  const canonicalRoot = await realpath(resolve(repositoryRoot));
  const file = join(canonicalRoot, ".factory", "factory.lock");
  await mkdir(join(file, ".."), { recursive: true });
  const token = crypto.randomUUID();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let i = 0; i < 240; i++) {
    try {
      handle = await open(file, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      try {
        const s = await stat(file),
          o = await owner(file);
        if (Date.now() - s.mtimeMs > 1000 && o && !(await alive(o.pid))) {
          const claim = `${file}.stale.${crypto.randomUUID()}`;
          try {
            await rename(file, claim);
            await rm(claim, { force: true });
          } catch (x: any) {
            if (x?.code !== "ENOENT") throw x;
          }
        }
      } catch (x: any) {
        if (x?.code !== "ENOENT") throw x;
      }
      await Bun.sleep(25);
    }
  }
  if (!handle) throw Error("Could not acquire factory storage lock");
  try {
    await recoverFactoryTransaction(canonicalRoot);
    return await fn();
  } finally {
    await handle.close();
    if ((await owner(file))?.token === token) await rm(file, { force: true });
  }
}
