import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

// A workflow that deploys must only run when someone asks for it: a push
// trigger would deploy (and start machines) on every merge.

const WORKFLOWS = path.resolve(__dirname, "..", ".github", "workflows");
const DEPLOY_RUN = /\bfly(?:ctl)?\s+deploy\b/;

type Workflow = { on?: unknown; jobs?: Record<string, { steps?: Array<{ run?: unknown }> }> };

function triggers(on: unknown): string[] {
  if (typeof on === "string") {
    return [on];
  }
  if (Array.isArray(on)) {
    return on.map(String);
  }
  if (on && typeof on === "object") {
    return Object.keys(on);
  }
  return [];
}

function deploys(wf: Workflow): boolean {
  return Object.values(wf.jobs ?? {}).some((job) =>
    (job.steps ?? []).some((step) => typeof step.run === "string" && DEPLOY_RUN.test(step.run)),
  );
}

/** Names of the forbidden triggers on a deploying workflow (empty when fine). */
function forbiddenDeployTriggers(wf: Workflow): string[] {
  return deploys(wf) ? triggers(wf.on).filter((t) => t === "push") : [];
}

function workflowFiles(): string[] {
  return fs
    .readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => path.join(WORKFLOWS, f));
}

describe("deploy workflow trigger rule", () => {
  const deployStep = { jobs: { d: { steps: [{ run: "flyctl deploy --remote-only" }] } } };

  it("flags a deploying workflow with a push trigger, in every trigger form (positive control)", () => {
    expect(forbiddenDeployTriggers({ on: "push", ...deployStep })).toEqual(["push"]);
    expect(forbiddenDeployTriggers({ on: ["push", "workflow_dispatch"], ...deployStep })).toEqual([
      "push",
    ]);
    expect(
      forbiddenDeployTriggers({ on: { push: { branches: ["main"] } }, ...deployStep }),
    ).toEqual(["push"]);
    expect(
      forbiddenDeployTriggers({
        on: "push",
        jobs: { d: { steps: [{ run: "fly deploy" }] } },
      }),
    ).toEqual(["push"]);
  });

  it("allows a deploying workflow that only runs on request", () => {
    expect(forbiddenDeployTriggers({ on: { workflow_dispatch: {} }, ...deployStep })).toEqual([]);
  });

  it("ignores workflows that do not deploy", () => {
    expect(
      forbiddenDeployTriggers({ on: "push", jobs: { t: { steps: [{ run: "pnpm test" }] } } }),
    ).toEqual([]);
  });
});

describe(".github/workflows", () => {
  const parsed = workflowFiles().map((file) => ({
    file: path.basename(file),
    wf: parseYaml(fs.readFileSync(file, "utf8")) as Workflow,
  }));

  it("the scan finds the deploy workflow (positive control)", () => {
    expect(parsed.filter((p) => deploys(p.wf)).map((p) => p.file)).toContain("deploy-fly.yml");
  });

  it("no deploying workflow runs on push", () => {
    const bad = parsed
      .map((p) => ({ file: p.file, triggers: forbiddenDeployTriggers(p.wf) }))
      .filter((p) => p.triggers.length > 0);
    expect(bad).toEqual([]);
  });
});
