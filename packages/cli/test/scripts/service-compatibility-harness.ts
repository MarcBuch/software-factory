import { strict as assert } from "node:assert";

import { OpenCode } from "@opencode-ai/client";
import { Service } from "@opencode-ai/client/service";

// Resolve the repository explicitly; the package script is normally launched from
// packages/cli, but agent discovery must exercise the repository's config.
const directory = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "");
const compatibility = (version: string) =>
  version.startsWith("0.0.0-beta-") || version.startsWith("0.0.0-dev-") || version.startsWith("2.");

const endpoint = await Service.ensure({
  version: compatibility,
  command: ["opencode2", "serve", "--service"],
});
const client = OpenCode.make({
  baseUrl: endpoint.url,
  headers: Service.headers(endpoint),
});
const subscription = new AbortController();
const events = client.event.subscribe({ signal: subscription.signal });
const observed = new Map<string, string[]>();
let connected = false;

const reader = (async () => {
  for await (const event of events) {
    if (event.type === "server.connected") connected = true;
    const sessionID = "sessionID" in event.data ? event.data.sessionID : undefined;
    if (sessionID) {
      const kinds = observed.get(sessionID) ?? [];
      kinds.push(event.type);
      observed.set(sessionID, kinds);
    }
  }
})();

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for service event");
    await Bun.sleep(25);
  }
};

const sessions: string[] = [];
try {
  const health = await client.health.get();
  assert.equal(health.healthy, true);
  await waitFor(() => connected);

  const [agentsA, agentsB] = await Promise.all([
    client.agent.list({ location: { directory } }),
    client.agent.list({ location: { directory } }),
  ]);
  assert.equal(agentsA.location.directory, directory);
  assert.equal(agentsB.location.directory, directory);
  assert.deepEqual(agentsA.data, agentsB.data);
  const scout = await client.agent.get({ agentID: "scout", location: { directory } });
  let planner;
  try {
    planner = await client.agent.get({ agentID: "plan-mission", location: { directory } });
  } catch (error) {
    throw new Error(
      `service ${health.version} cannot resolve plan-mission via agent.get; native config interpretation is incompatible with the client/config harness`,
      { cause: error },
    );
  }
  assert.deepEqual(
    scout.data,
    agentsA.data.find((agent) => agent.name === "scout"),
  );
  assert.deepEqual(
    planner.data,
    agentsA.data.find((agent) => agent.name === "plan-mission"),
  );
  const agentEvidence = agentsA.data.map((agent) => ({
    name: agent.name,
    mode: agent.mode,
    model: agent.model ? { id: agent.model.id, providerID: agent.model.providerID } : null,
    permissions: agent.permissions.reduce<Record<string, number>>((counts, permission) => {
      const key = `${permission.action}:${permission.effect}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
  }));
  assert.equal(
    agentsA.data.some((agent) => agent.name === "Build"),
    true,
  );
  assert.equal(
    agentsA.data.some((agent) => agent.name === "plan-mission"),
    true,
  );
  const scoutAgent = scout.data;
  assert.ok(scoutAgent, "scout agent is discovered");
  assert.equal(scoutAgent.mode, "primary");
  assert.deepEqual(
    scoutAgent.model && { id: scoutAgent.model.id, providerID: scoutAgent.model.providerID },
    { id: "gpt-5.6-luna", providerID: "github-copilot" },
  );
  const permissionKey = (permission: { action: string; resource?: string; effect: string }) =>
    `${permission.action}:${permission.resource ?? "*"}:${permission.effect}`;
  const assertEffective = (
    permissions: Array<{ action: string; resource?: string; effect: string }>,
    action: string,
    resource: string,
    effect: string,
  ) => {
    const effective = [...permissions]
      .reverse()
      .find(
        (permission) =>
          (permission.action === action || permission.action === "*") &&
          (!permission.resource || permission.resource === "*" || permission.resource === resource),
      );
    assert.equal(
      effective?.effect,
      effect,
      `${action}:${resource} effective permission (last matching rule)`,
    );
  };
  const scoutPermissions = new Set(scoutAgent.permissions.map(permissionKey));
  for (const permission of [
    "*:*:deny",
    "read:*:allow",
    "glob:*:allow",
    "grep:*:allow",
    "edit:*:deny",
    "shell:*:deny",
    "subagent:*:deny",
    "skill:*:deny",
    "question:*:deny",
  ])
    assert.equal(scoutPermissions.has(permission), true, `scout permission ${permission}`);
  for (const [action, resource, effect] of [
    ["read", "README.md", "allow"],
    ["glob", "*", "allow"],
    ["grep", "term", "allow"],
    ["edit", "README.md", "deny"],
    ["shell", "echo", "deny"],
    ["subagent", "codebase-explorer", "deny"],
    ["skill", "visualize-change", "deny"],
    ["question", "*", "deny"],
  ] as const)
    assertEffective(scoutAgent.permissions, action, resource, effect);

  assert.equal(planner.data.mode, "primary");
  assert.deepEqual(
    planner.data.model && { id: planner.data.model.id, providerID: planner.data.model.providerID },
    {
      id: "gpt-5.6-terra",
      providerID: "github-copilot",
    },
  );
  const plannerPermissions = new Set(planner.data.permissions.map(permissionKey));
  for (const permission of [
    "*:*:deny",
    "edit:*:allow",
    "shell:*:deny",
    "skill:*:deny",
    "skill:visualize-change:allow",
    "subagent:*:deny",
    "subagent:codebase-explorer:allow",
  ])
    assert.equal(plannerPermissions.has(permission), true, `plan-mission permission ${permission}`);
  for (const [action, resource, effect] of [
    ["edit", "README.md", "allow"],
    ["shell", "echo", "deny"],
    ["skill", "visualize-change", "allow"],
    ["skill", "other-skill", "deny"],
    ["subagent", "codebase-explorer", "allow"],
    ["subagent", "scout", "deny"],
    ["question", "*", "deny"],
  ] as const)
    assertEffective(planner.data.permissions, action, resource, effect);

  const [providers, models] = await Promise.all([
    client.provider.list({ location: { directory } }),
    client.model.list({ location: { directory } }),
  ]);
  const copilot = providers.data.find((provider) => provider.id === "github-copilot");
  assert.ok(copilot, "github-copilot provider is available");
  const requestedModels = ["gpt-5.6-luna", "gpt-5.6-terra"];
  const availableModels = new Set(
    models.data.filter((model) => model.providerID === "github-copilot").map((model) => model.id),
  );
  for (const modelID of requestedModels) {
    assert.equal(
      availableModels.has(modelID),
      true,
      `github-copilot/${modelID} model is available`,
    );
  }

  const [first, second] = await Promise.all([
    client.session.create({ title: "service-harness-first", location: { directory } }),
    client.session.create({ title: "service-harness-second", location: { directory } }),
  ]);
  sessions.push(first.id, second.id);
  assert.notEqual(first.id, second.id);
  await waitFor(() => sessions.every((id) => observed.get(id)?.includes("session.created")));

  await Promise.all([
    client.session.synthetic({
      sessionID: first.id,
      text: "harness-first",
      description: "no-model",
    }),
    client.session.synthetic({
      sessionID: second.id,
      text: "harness-second",
      description: "no-model",
    }),
  ]);
  await waitFor(() => sessions.every((id) => observed.get(id)?.includes("session.inbox.enqueued")));
  assert.equal(observed.get(first.id)?.includes("session.inbox.enqueued"), true);
  assert.equal(observed.get(second.id)?.includes("session.inbox.enqueued"), true);

  const [firstInterrupt, secondInterrupt] = await Promise.all([
    client.session.interrupt({ sessionID: first.id }),
    client.session.interrupt({ sessionID: second.id }),
  ]);
  assert.equal(typeof firstInterrupt.interrupted, "boolean");
  assert.equal(typeof secondInterrupt.interrupted, "boolean");
  console.log(
    JSON.stringify({
      agents: agentEvidence,
      scout: agentsA.data.some((agent) => agent.name === "scout"),
      provider: copilot.id,
      models: requestedModels,
    }),
  );
} finally {
  subscription.abort();
  await reader.catch(() => undefined);
  await Promise.all(
    sessions.map((sessionID) => client.session.remove({ sessionID }).catch(() => undefined)),
  );
}
