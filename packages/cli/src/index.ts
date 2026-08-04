#!/usr/bin/env bun
import { Command } from "commander";
import { z } from "zod";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const iso = z.string().datetime({ offset: true });
const text = z.string().trim().min(1);
const Task = z.object({ id:z.string().regex(/^tsk_[A-Za-z0-9]+$/), title:text, type:z.enum(["implementation","verification"]), risk:z.enum(["low","medium","high"]), verification:text, createdAt:iso, updatedAt:iso }).strict().superRefine((v,c)=>{if(v.updatedAt<v.createdAt)c.addIssue({code:"custom",message:"updatedAt must be >= createdAt"});});
const Milestone = z.object({ id:z.string().regex(/^mil_[A-Za-z0-9]+$/), title:text, createdAt:iso, updatedAt:iso, tasks:z.array(Task) }).strict().superRefine((v,c)=>{if(v.updatedAt<v.createdAt)c.addIssue({code:"custom",message:"updatedAt must be >= createdAt"});});
const Mission = z.object({ id:z.string().regex(/^mis_[A-Za-z0-9]+$/), title:text, verificationMode:z.enum(["fast","standard","exhaustive"]), createdAt:iso, updatedAt:iso, milestones:z.array(Milestone) }).strict().superRefine((v,c)=>{if(v.updatedAt<v.createdAt)c.addIssue({code:"custom",message:"updatedAt must be >= createdAt"});});
const Metadata = z.object({ type:z.literal("metadata"), schemaVersion:z.literal(1) }).strict();
type MissionType=z.infer<typeof Mission>;
const now=()=>new Date().toISOString();
const makeId=(p:string)=>`${p}_${crypto.randomUUID().replaceAll("-","")}`;
function clean(value:string){const v=value.trim();if(!v)throw Error("Value must not be empty");return v;}

async function projectRoot(){
  try { return (await exec("git",["rev-parse","--show-toplevel"],{cwd:process.cwd()})).stdout.trim(); }
  catch { throw Error("factory must be run inside a Git worktree"); }
}
async function paths(){const root=await projectRoot(),dir=join(root,".factory");return {root,dir,file:join(dir,"missions.jsonl"),lock:join(dir,"missions.lock")};}
function validateAll(missions:MissionType[]){const ids=new Set<string>();for(const m of missions){for(const x of [m,...m.milestones,...m.milestones.flatMap(v=>v.tasks)]){if(ids.has(x.id))throw Error(`Duplicate ID: ${x.id}`);ids.add(x.id);}}return missions;}
async function load(file:string){if(!existsSync(file))return [];const lines=(await readFile(file,"utf8")).split("\n").filter(Boolean);if(!lines.length)throw Error("Invalid storage: missing metadata");Metadata.parse(JSON.parse(lines[0]));return validateAll(lines.slice(1).map(x=>Mission.parse(JSON.parse(x))));}

const sleep=(ms:number)=>Bun.sleep(ms);
async function pidAlive(pid:number){try{process.kill(pid,0);return true;}catch{return false;}}
async function lockOwner(file:string){try{return JSON.parse(await readFile(file,"utf8")) as {pid:number,token:string};}catch{return undefined;}}
async function withLock<T>(fn:()=>Promise<T>):Promise<T>{const p=await paths();await mkdir(p.dir,{recursive:true});const token=crypto.randomUUID(), owner=JSON.stringify({pid:process.pid,token});let handle:any;
  for(let i=0;i<120;i++){try{handle=await open(p.lock,"wx");await handle.writeFile(owner);break;}catch(e:any){if(e?.code!=="EEXIST")throw e;try{const s=await stat(p.lock),o=await lockOwner(p.lock);const stale=Date.now()-s.mtimeMs>1000 && !!o && !(await pidAlive(o.pid));if(stale){const claim=`${p.lock}.stale.${process.pid}.${crypto.randomUUID()}`;try{await rename(p.lock,claim);await rm(claim,{force:true});}catch(claimError:any){if(claimError?.code!=="ENOENT")throw claimError;}}}catch(lockError:any){if(lockError?.code!=="ENOENT")throw lockError;}await sleep(25);}}
  if(!handle)throw Error("Could not acquire storage lock");try{return await fn();}finally{await handle.close();if((await lockOwner(p.lock))?.token===token)await rm(p.lock,{force:true});}}
async function save(missions:MissionType[]){const p=await paths();const data=[JSON.stringify({type:"metadata",schemaVersion:1}),...missions.map(m=>JSON.stringify(m))].join("\n")+"\n";const tmp=`${p.file}.tmp.${process.pid}.${crypto.randomUUID()}`;try{await writeFile(tmp,data,{mode:0o600});await rename(tmp,p.file);}finally{await rm(tmp,{force:true});}}
function isJson(cmd:Command){return cmd.optsWithGlobals().json===true;}
function output(value:unknown,json:boolean){console.log(json?JSON.stringify(value):typeof value==="string"?value:JSON.stringify(value,null,2));}
function jsonOption(c:Command){return c.option("--json","Output JSON");}
const program=new Command().name("factory").description("Software Factory mission planner").option("--json","Output JSON errors and data");
const init=program.command("init").option("--track","Keep .factory records trackable");jsonOption(init);
init.action(async(opts,cmd)=>withLock(async()=>{const p=await paths();await mkdir(p.dir,{recursive:true});if(!existsSync(p.file))await save([]);const g=join(p.root,".gitignore");let lines=existsSync(g)?(await readFile(g,"utf8")).split(/\r?\n/):[];const exact=(v:string)=>v.trim()===".factory/";lines=lines.filter(v=>!exact(v));if(!opts.track)lines.push(".factory/");while(lines.length&&lines.at(-1)==="")lines.pop();await writeFile(g,lines.join("\n")+"\n");output({initialized:true,path:p.file,tracked:!!opts.track},isJson(cmd));}));
const mission=program.command("mission"),mc=jsonOption(mission.command("create")).requiredOption("--title <title>").option("--verification-mode <mode>","verification mode","standard");mc.action(async(opts,cmd)=>withLock(async()=>{const p=await paths(),all=await load(p.file),t=now(),m=Mission.parse({id:makeId("mis"),title:clean(opts.title),verificationMode:opts.verificationMode,createdAt:t,updatedAt:t,milestones:[]});all.push(m);await save(all);output(m,isJson(cmd));}));
const milestone=program.command("milestone"),msc=jsonOption(milestone.command("create")).requiredOption("--mission <id>").requiredOption("--title <title>");msc.action(async(opts,cmd)=>withLock(async()=>{const p=await paths(),all=await load(p.file),m=all.find(x=>x.id===opts.mission);if(!m)throw Error(`Mission not found: ${opts.mission}`);const t=now(),ms={id:makeId("mil"),title:clean(opts.title),createdAt:t,updatedAt:t,tasks:[]};m.milestones.push(ms);m.updatedAt=t;await save(all);output(ms,isJson(cmd));}));
const task=program.command("task"),tc=jsonOption(task.command("create")).requiredOption("--milestone <id>").requiredOption("--title <title>").option("--type <type>","task type","implementation").option("--risk <risk>","risk","medium").requiredOption("--verification <note>");tc.action(async(opts,cmd)=>withLock(async()=>{const p=await paths(),all=await load(p.file),m=all.find(x=>x.milestones.some(ms=>ms.id===opts.milestone)),ms=m?.milestones.find(x=>x.id===opts.milestone);if(!m||!ms)throw Error(`Milestone not found: ${opts.milestone}`);const t=now(),v=Task.parse({id:makeId("tsk"),title:clean(opts.title),type:opts.type,risk:opts.risk,verification:clean(opts.verification),createdAt:t,updatedAt:t});ms.tasks.push(v);ms.updatedAt=t;m.updatedAt=t;await save(all);output(v,isJson(cmd));}));
const list=jsonOption(program.command("list"));list.action(async(_,cmd)=>{const p=await paths();output(await load(p.file),isJson(cmd));});
const show=jsonOption(program.command("show").argument("<mission-id>"));show.action(async(idArg,_,cmd)=>{const p=await paths(),m=(await load(p.file)).find(x=>x.id===idArg);if(!m)throw Error(`Mission not found: ${idArg}`);output(m,isJson(cmd));});
program.exitOverride();
try{await program.parseAsync();}catch(e){const json=process.argv.includes("--json");if(json)console.error(JSON.stringify({error:e instanceof Error?e.message:String(e)}));else console.error(e instanceof Error?e.message:e);process.exitCode=1;}
