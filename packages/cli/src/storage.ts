import { mkdir, open, readFile, rm, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
async function root() { try { return (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() })).stdout.trim(); } catch { throw Error("factory must be run inside a Git worktree"); } }
async function owner(file: string) { try { return JSON.parse(await readFile(file, "utf8")) as { pid: number; token: string }; } catch { return undefined; } }
async function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

export async function withFactoryLock<T>(fn: () => Promise<T>): Promise<T> {
  const file = join(await root(), ".factory", "factory.lock"); await mkdir(join(file, ".."), { recursive: true });
  const token = crypto.randomUUID(); let handle: Awaited<ReturnType<typeof open>> | undefined;
 for (let i = 0; i < 240; i++) { try { handle = await open(file, "wx"); await handle.writeFile(JSON.stringify({ pid: process.pid, token })); break; } catch (e: any) { if (e?.code !== "EEXIST") throw e; try { const s = await stat(file), o = await owner(file); if (Date.now() - s.mtimeMs > 1000 && o && !(await alive(o.pid))) { const claim = `${file}.stale.${crypto.randomUUID()}`; try { await rename(file, claim); await rm(claim, { force: true }); } catch (x: any) { if (x?.code !== "ENOENT") throw x; } } } catch (x: any) { if (x?.code !== "ENOENT") throw x; } await Bun.sleep(25); } }
  if (!handle) throw Error("Could not acquire factory storage lock");
  try { return await fn(); } finally { await handle.close(); if ((await owner(file))?.token === token) await rm(file, { force: true }); }
}
