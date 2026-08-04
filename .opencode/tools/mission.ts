import { tool } from "@opencode-ai/plugin"
import path from "path"
import fs from "fs"

// ─── Types ────────────────────────────────────────────────────────────────────

type Status = "pending" | "in_progress" | "completed" | "failed" | "skipped"

interface Task {
  id: string
  title: string
  status: Status
  notes?: string
  updatedAt?: string
}

interface Milestone {
  id: string
  title: string
  status: Status
  tasks: Task[]
}

interface Mission {
  title: string
  status: Status
  created: string
  updated: string
  milestones: Milestone[]
}

interface Command {
  cmd: string
  exit: number
  note?: string
}

interface ProceduresFollowed {
  readArchitectureMd: boolean
  ranBaselineTests: boolean
  noDirectDependencyEdits: boolean
  note?: string
}

interface Handoff {
  taskId: string
  taskTitle: string
  milestoneId: string
  agentId: string
  timestamp: string
  implemented: string[]
  leftUndone: string[]
  commands: Command[]
  issues: string[]
  proceduresFollowed: ProceduresFollowed
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_ICON: Record<Status, string> = {
  pending: "○",
  in_progress: "▶",
  completed: "✓",
  failed: "✗",
  skipped: "⊘",
}

function missionFilePath(worktree: string): string {
  return path.join(worktree, ".opencode", "mission.json")
}

function handoffsFilePath(worktree: string): string {
  return path.join(worktree, ".opencode", "handoffs.jsonl")
}

function resolveStorageWorktree(context: { directory: string; worktree: string }): string {
  let current = path.resolve(context.directory)

  while (true) {
    const gitPath = path.join(current, ".git")
    if (fs.existsSync(gitPath)) return current

    const parent = path.dirname(current)
    if (parent === current) return context.worktree
    current = parent
  }
}

function readMission(worktree: string): Mission {
  const filePath = missionFilePath(worktree)
  if (!fs.existsSync(filePath)) {
    throw new Error(
      "No mission file found at .opencode/mission.json. " +
        "The orchestrator must call mission_init before any other mission tool."
    )
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Mission
}

function writeMission(worktree: string, mission: Mission): void {
  const filePath = missionFilePath(worktree)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  mission.updated = new Date().toISOString()
  fs.writeFileSync(filePath, JSON.stringify(mission, null, 2), "utf-8")
}

function deriveMilestoneStatus(tasks: Task[]): Status {
  if (tasks.every((t) => t.status === "pending")) return "pending"
  if (tasks.some((t) => t.status === "failed")) return "failed"
  if (tasks.every((t) => t.status === "completed" || t.status === "skipped"))
    return "completed"
  return "in_progress"
}

function deriveMissionStatus(milestones: Milestone[]): Status {
  if (milestones.every((m) => m.status === "pending")) return "pending"
  if (milestones.some((m) => m.status === "failed")) return "failed"
  if (
    milestones.every(
      (m) => m.status === "completed" || m.status === "skipped"
    )
  )
    return "completed"
  return "in_progress"
}

function renderSummary(mission: Mission): string {
  const lines: string[] = []
  lines.push(
    `Mission: ${mission.title} [${mission.status}]`
  )

  mission.milestones.forEach((milestone, mi) => {
    const isLastMilestone = mi === mission.milestones.length - 1
    const milestonePrefix = isLastMilestone ? "└──" : "├──"
    lines.push(
      `${milestonePrefix} Milestone ${mi + 1}: ${milestone.title} [${milestone.status}]`
    )

    milestone.tasks.forEach((task, ti) => {
      const isLastTask = ti === milestone.tasks.length - 1
      const verticalBar = isLastMilestone ? "    " : "│   "
      const taskPrefix = isLastTask ? "└──" : "├──"
      const icon = STATUS_ICON[task.status]
      const notes = task.notes ? ` — ${task.notes}` : ""
      lines.push(
        `${verticalBar}${taskPrefix} ${icon} ${task.title} (${task.status})${notes}`
      )
    })
  })

  return lines.join("\n")
}

// ─── Tools ────────────────────────────────────────────────────────────────────

export const mission_init = tool({
  description:
    "Initialize a new mission with milestones and tasks. Always called first by the orchestrator before spawning any subagents. Overwrites any existing mission file.",
  args: {
    title: tool.schema.string().describe("The mission goal or title"),
    milestones: tool.schema
      .array(
        tool.schema.object({
          id: tool.schema
            .string()
            .describe("Short unique identifier, e.g. 'm1'"),
          title: tool.schema.string().describe("Milestone title"),
          tasks: tool.schema.array(
            tool.schema.object({
              id: tool.schema
                .string()
                .describe(
                  "Short unique identifier scoped to the milestone, e.g. 'm1t1'"
                ),
              title: tool.schema.string().describe("Task title"),
            })
          ),
        })
      )
      .describe("Ordered list of milestones, each containing ordered tasks"),
  },
  async execute(args, context) {
    const storageWorktree = resolveStorageWorktree(context)
    const now = new Date().toISOString()

    const mission: Mission = {
      title: args.title,
      status: "pending",
      created: now,
      updated: now,
      milestones: args.milestones.map((m) => ({
        id: m.id,
        title: m.title,
        status: "pending",
        tasks: m.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: "pending",
        })),
      })),
    }

    writeMission(storageWorktree, mission)

    return [
      `Mission initialized: "${mission.title}"`,
      "",
      renderSummary(mission),
      "",
      `State written to .opencode/mission.json`,
    ].join("\n")
  },
})

export const mission_update_task = tool({
  description:
    "Update the status of a task. Called by the orchestrator after delegating work to a subagent and receiving its result. Milestone and mission status are derived automatically.",
  args: {
    taskId: tool.schema
      .string()
      .describe("The task ID as defined in mission_init, e.g. 'm1t1'"),
    status: tool.schema
      .enum(["pending", "in_progress", "completed", "failed", "skipped"])
      .describe("New status for the task"),
    notes: tool.schema
      .string()
      .optional()
      .describe(
        "Optional notes — use this to record the subagent's result, error details, or reason for skipping"
      ),
  },
  async execute(args, context) {
    const storageWorktree = resolveStorageWorktree(context)
    const mission = readMission(storageWorktree)

    let found = false
    let milestoneSummary = ""

    for (const milestone of mission.milestones) {
      for (const task of milestone.tasks) {
        if (task.id === args.taskId) {
          task.status = args.status
          task.updatedAt = new Date().toISOString()
          if (args.notes !== undefined) task.notes = args.notes
          found = true
        }
      }
      if (found) {
        milestone.status = deriveMilestoneStatus(milestone.tasks)
        milestoneSummary = `Milestone "${milestone.title}" is now [${milestone.status}]`
        break
      }
    }

    if (!found) {
      throw new Error(
        `Task ID "${args.taskId}" not found in mission. ` +
          `Available IDs: ${mission.milestones.flatMap((m) => m.tasks.map((t) => t.id)).join(", ")}`
      )
    }

    mission.status = deriveMissionStatus(mission.milestones)
    writeMission(storageWorktree, mission)

    return [
      `Task "${args.taskId}" → [${args.status}]`,
      milestoneSummary,
      `Mission is now [${mission.status}]`,
    ].join("\n")
  },
})

export const mission_read = tool({
  description:
    "Read the full mission state as JSON. Use this to orient yourself before starting work or to pass full context to a subagent prompt.",
  args: {},
  async execute(_args, context) {
    const storageWorktree = resolveStorageWorktree(context)
    const mission = readMission(storageWorktree)
    return JSON.stringify(mission, null, 2)
  },
})

export const mission_summary = tool({
  description:
    "Print a compact human-readable summary of the mission: all milestones and tasks with their current status. Use this to review progress after each milestone completes.",
  args: {},
  async execute(_args, context) {
    const storageWorktree = resolveStorageWorktree(context)
    const mission = readMission(storageWorktree)
    return renderSummary(mission)
  },
})

export const mission_handoff = tool({
  description:
    "Called by a subagent as its last action before returning results to the orchestrator. Appends a structured handoff record to .opencode/handoffs.jsonl documenting what was implemented, what was left undone, every command run with its exit code, issues discovered, and whether project procedures were followed.",
  args: {
    taskId: tool.schema
      .string()
      .describe("The task ID as defined in mission_init, e.g. 'm1t1'"),
    taskTitle: tool.schema
      .string()
      .describe("The task title — copy it from the mission context"),
    milestoneId: tool.schema
      .string()
      .describe("The milestone ID this task belongs to, e.g. 'm1'"),
    implemented: tool.schema
      .array(tool.schema.string())
      .describe(
        "What was built or changed. One entry per file or logical unit. Be specific: include file paths and a short description of what changed."
      ),
    leftUndone: tool.schema
      .array(tool.schema.string())
      .describe(
        "What was not completed and why. Empty array only if genuinely nothing was left undone — not as a shortcut."
      ),
    commands: tool.schema
      .array(
        tool.schema.object({
          cmd: tool.schema
            .string()
            .describe("Full command as run, e.g. 'bun run test --filter auth'"),
          exit: tool.schema.number().describe("Exit code"),
          note: tool.schema
            .string()
            .optional()
            .describe("Optional annotation about this command's result"),
        })
      )
      .describe("Every command run during this task, in order of execution"),
    issues: tool.schema
      .array(tool.schema.string())
      .describe(
        "Discoveries, gotchas, or blockers relevant to future workers. Empty array only if there are genuinely no issues to report."
      ),
    proceduresFollowed: tool.schema
      .object({
        readArchitectureMd: tool.schema
          .boolean()
          .describe(
            "Did you read apps/api/ARCHITECTURE.md before editing API code? Set true if no API code was touched."
          ),
        ranBaselineTests: tool.schema
          .boolean()
          .describe(
            "Did you run 'bun run test' from apps/api after making changes? Set true if no code changes were made."
          ),
        noDirectDependencyEdits: tool.schema
          .boolean()
          .describe(
            "Did you avoid directly editing package.json or bun.lock (using bun install/remove instead)?"
          ),
        note: tool.schema
          .string()
          .optional()
          .describe(
            "Free-text explanation for any false value or partial compliance"
          ),
      })
      .describe("Whether the procedures defined in AGENTS.md were followed"),
  },
  async execute(args, context) {
    const storageWorktree = resolveStorageWorktree(context)
    // Validate taskId exists in the mission
    const mission = readMission(storageWorktree)
    const allTaskIds = mission.milestones.flatMap((m) =>
      m.tasks.map((t) => t.id)
    )
    if (!allTaskIds.includes(args.taskId)) {
      throw new Error(
        `Task ID "${args.taskId}" not found in mission. ` +
          `Available IDs: ${allTaskIds.join(", ")}`
      )
    }

    const record: Handoff = {
      taskId: args.taskId,
      taskTitle: args.taskTitle,
      milestoneId: args.milestoneId,
      agentId: context.agent,
      timestamp: new Date().toISOString(),
      implemented: args.implemented,
      leftUndone: args.leftUndone,
      commands: args.commands,
      issues: args.issues,
      proceduresFollowed: args.proceduresFollowed,
    }

    const filePath = handoffsFilePath(storageWorktree)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })

    // Guard: if the file exists and does not end with a newline, prepend one
    // to prevent two JSON objects being concatenated on the same line.
    let prefix = ""
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath)
      if (stat.size > 0) {
        const buf = Buffer.alloc(1)
        const fd = fs.openSync(filePath, "r")
        fs.readSync(fd, buf, 0, 1, stat.size - 1)
        fs.closeSync(fd)
        if (buf[0] !== 0x0a) prefix = "\n" // 0x0a = '\n'
      }
    }

    fs.appendFileSync(filePath, prefix + JSON.stringify(record) + "\n", "utf-8")

    const procedureWarnings: string[] = []
    if (!record.proceduresFollowed.readArchitectureMd)
      procedureWarnings.push("readArchitectureMd: false")
    if (!record.proceduresFollowed.ranBaselineTests)
      procedureWarnings.push("ranBaselineTests: false")
    if (!record.proceduresFollowed.noDirectDependencyEdits)
      procedureWarnings.push("noDirectDependencyEdits: false")

    const lines = [
      `Handoff recorded for task "${args.taskId}" (${args.taskTitle})`,
      `  implemented: ${args.implemented.length} item(s)`,
      `  leftUndone:  ${args.leftUndone.length} item(s)`,
      `  commands:    ${args.commands.length} run`,
      `  issues:      ${args.issues.length} reported`,
    ]

    if (procedureWarnings.length > 0) {
      lines.push(`  PROCEDURE WARNINGS: ${procedureWarnings.join(", ")}`)
    } else {
      lines.push(`  procedures: all followed`)
    }

    lines.push(`Appended to .opencode/handoffs.jsonl`)

    return lines.join("\n")
  },
})

export const mission_read_handoffs = tool({
  description:
    "Read handoff records written by subagents. If taskId is provided, returns all handoffs for that specific task. If omitted, returns all handoffs for every task in the currently in_progress milestone. Used by the orchestrator before calling mission_update_task, and by subagents to understand what prior workers discovered.",
  args: {
    taskId: tool.schema
      .string()
      .optional()
      .describe(
        "Filter to a specific task ID. If omitted, returns handoffs for all tasks in the current in_progress milestone."
      ),
  },
  async execute(args, context) {
    const storageWorktree = resolveStorageWorktree(context)
    const mission = readMission(storageWorktree)
    const filePath = handoffsFilePath(storageWorktree)

    if (!fs.existsSync(filePath)) {
      return "No handoffs recorded yet for this mission."
    }

    const lines = fs
      .readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")

    const allHandoffs: Handoff[] = lines.map((line) => JSON.parse(line))

    let filtered: Handoff[]

    if (args.taskId) {
      // Filter to specific task
      filtered = allHandoffs.filter((h) => h.taskId === args.taskId)
      if (filtered.length === 0) {
        return `No handoffs found for task "${args.taskId}".`
      }
    } else {
      // Default: all tasks in the current in_progress milestone
      const inProgressMilestone = mission.milestones.find(
        (m) => m.status === "in_progress"
      )
      if (!inProgressMilestone) {
        // Fall back to the last milestone with any handoffs
        const handoffTaskIds = new Set(allHandoffs.map((h) => h.taskId))
        const lastMilestoneWithHandoffs = [...mission.milestones]
          .reverse()
          .find((m) => m.tasks.some((t) => handoffTaskIds.has(t.id)))

        if (!lastMilestoneWithHandoffs) {
          return "No handoffs found and no in_progress milestone. No handoffs to show."
        }

        const taskIds = new Set(
          lastMilestoneWithHandoffs.tasks.map((t) => t.id)
        )
        filtered = allHandoffs.filter((h) => taskIds.has(h.taskId))
      } else {
        const taskIds = new Set(inProgressMilestone.tasks.map((t) => t.id))
        filtered = allHandoffs.filter((h) => taskIds.has(h.taskId))

        if (filtered.length === 0) {
          return `No handoffs yet for milestone "${inProgressMilestone.title}" (${inProgressMilestone.id}).`
        }
      }
    }

    return JSON.stringify(filtered, null, 2)
  },
})
