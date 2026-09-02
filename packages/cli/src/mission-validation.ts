import { MissionSchema, type Mission } from "@software-factory/contracts";

/** Validate the cross-record invariants required by the mission store. */
export function validateMissions(missions: Mission[]) {
  const ids = new Set<string>();
  const sources = new Set<string>();
  for (const mission of missions) {
    MissionSchema.parse(mission);
    for (const record of [
      mission,
      ...mission.milestones,
      ...mission.milestones.flatMap((v) => v.tasks),
    ]) {
      if (ids.has(record.id)) throw Error(`Duplicate ID: ${record.id}`);
      ids.add(record.id);
    }
    if (mission.sourcePlan) {
      const key = `${mission.sourcePlan.planId}:${mission.sourcePlan.revision}`;
      if (sources.has(key)) throw Error(`Duplicate source plan: ${key}`);
      sources.add(key);
    }
    const tasks = new Map(
      mission.milestones.flatMap((milestone) => milestone.tasks).map((task) => [task.id, task]),
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw Error(`Cyclic task dependency: ${id}`);
      if (visited.has(id)) return;
      const task = tasks.get(id);
      if (!task) return;
      visiting.add(id);
      for (const dependency of task.dependsOn ?? []) {
        if (!tasks.has(dependency)) throw Error(`Unknown task dependency: ${dependency}`);
        visit(dependency);
      }
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of tasks.keys()) visit(id);
  }
  return missions;
}
