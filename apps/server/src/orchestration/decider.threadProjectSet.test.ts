import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-10T12:00:00.000Z";
const LATER = "2026-08-10T12:05:00.000Z";
const SOURCE_PROJECT_ID = ProjectId.make("project-source");
const TARGET_PROJECT_ID = ProjectId.make("project-target");
const THREAD_ID = ThreadId.make("thread-to-move");

function makeProject(
  id: ProjectId,
  input: { readonly workspaceRoot?: string; readonly deletedAt?: string | null } = {},
): OrchestrationProject {
  return {
    id,
    title: id === SOURCE_PROJECT_ID ? "Source" : "Target",
    workspaceRoot:
      input.workspaceRoot ?? (id === SOURCE_PROJECT_ID ? "/repo/apps/server" : "/repo"),
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: input.deletedAt ?? null,
  };
}

function makeThread(
  input: {
    readonly id?: ThreadId;
    readonly projectId?: ProjectId;
    readonly deletedAt?: string | null;
  } = {},
): OrchestrationThread {
  return {
    id: input.id ?? THREAD_ID,
    projectId: input.projectId ?? SOURCE_PROJECT_ID,
    title: `Thread ${input.id ?? THREAD_ID}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: input.deletedAt ?? null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function makeReadModel(
  input: {
    readonly projects?: ReadonlyArray<OrchestrationProject>;
    readonly threads?: ReadonlyArray<OrchestrationThread>;
  } = {},
): OrchestrationReadModel {
  return {
    snapshotSequence: 4,
    projects: [
      ...(input.projects ?? [makeProject(SOURCE_PROJECT_ID), makeProject(TARGET_PROJECT_ID)]),
    ],
    threads: [...(input.threads ?? [makeThread()])],
    updatedAt: NOW,
  };
}

const makeThreadProjectSetCommand = (
  input: {
    readonly projectId?: ProjectId;
    readonly allowUnrelatedRoots?: boolean;
  } = {},
) => ({
  type: "thread.project.set" as const,
  commandId: CommandId.make("command-thread-project-set"),
  threadId: THREAD_ID,
  projectId: input.projectId ?? TARGET_PROJECT_ID,
  ...(input.allowUnrelatedRoots !== undefined
    ? { allowUnrelatedRoots: input.allowUnrelatedRoots }
    : {}),
  createdAt: LATER,
});

const makeProjectMergeCommand = (
  input: {
    readonly sourceProjectId?: ProjectId;
    readonly targetProjectId?: ProjectId;
    readonly allowUnrelatedRoots?: boolean;
  } = {},
) => ({
  type: "project.merge" as const,
  commandId: CommandId.make("command-project-merge"),
  sourceProjectId: input.sourceProjectId ?? SOURCE_PROJECT_ID,
  targetProjectId: input.targetProjectId ?? TARGET_PROJECT_ID,
  ...(input.allowUnrelatedRoots !== undefined
    ? { allowUnrelatedRoots: input.allowUnrelatedRoots }
    : {}),
  createdAt: LATER,
});

it.layer(NodeServices.layer)("thread project set decider", (it) => {
  it.effect("moves a thread between nested workspace roots", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: makeThreadProjectSetCommand(),
        readModel: makeReadModel(),
      });

      expect(Array.isArray(result)).toBe(false);
      expect(result).toMatchObject({
        type: "thread.project-set",
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: LATER,
        payload: {
          threadId: THREAD_ID,
          projectId: TARGET_PROJECT_ID,
          updatedAt: LATER,
        },
      });
    }),
  );

  it.effect("re-emits a projected no-op when the thread already belongs to the target", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: makeThreadProjectSetCommand(),
        readModel: makeReadModel({ threads: [makeThread({ projectId: TARGET_PROJECT_ID })] }),
      });

      expect(Array.isArray(result)).toBe(false);
      expect(result).toMatchObject({
        type: "thread.project-set",
        occurredAt: LATER,
        payload: {
          threadId: THREAD_ID,
          projectId: TARGET_PROJECT_ID,
          updatedAt: NOW,
        },
      });
    }),
  );

  it.effect("rejects missing and deleted threads", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.flip(
        decideOrchestrationCommand({
          command: makeThreadProjectSetCommand(),
          readModel: makeReadModel({ threads: [] }),
        }),
      );
      expect(missing.message).toContain(`Thread '${THREAD_ID}' does not exist`);

      const deleted = yield* Effect.flip(
        decideOrchestrationCommand({
          command: makeThreadProjectSetCommand(),
          readModel: makeReadModel({ threads: [makeThread({ deletedAt: NOW })] }),
        }),
      );
      expect(deleted.message).toContain(`Thread '${THREAD_ID}' is deleted`);
    }),
  );

  it.effect("rejects missing and deleted target projects", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.flip(
        decideOrchestrationCommand({
          command: makeThreadProjectSetCommand(),
          readModel: makeReadModel({ projects: [makeProject(SOURCE_PROJECT_ID)] }),
        }),
      );
      expect(missing.message).toContain(`Project '${TARGET_PROJECT_ID}' does not exist`);

      const deleted = yield* Effect.flip(
        decideOrchestrationCommand({
          command: makeThreadProjectSetCommand(),
          readModel: makeReadModel({
            projects: [
              makeProject(SOURCE_PROJECT_ID),
              makeProject(TARGET_PROJECT_ID, { deletedAt: NOW }),
            ],
          }),
        }),
      );
      expect(deleted.message).toContain(`Project '${TARGET_PROJECT_ID}' is deleted`);
    }),
  );

  it.effect("rejects unrelated and boundary-collision roots", () =>
    Effect.gen(function* () {
      for (const targetRoot of ["/other-repo", "/repo-other"]) {
        const error = yield* Effect.flip(
          decideOrchestrationCommand({
            command: makeThreadProjectSetCommand(),
            readModel: makeReadModel({
              projects: [
                makeProject(SOURCE_PROJECT_ID, { workspaceRoot: "/repo" }),
                makeProject(TARGET_PROJECT_ID, { workspaceRoot: targetRoot }),
              ],
            }),
          }),
        );
        expect(error.message).toContain("unrelated workspace roots");
      }
    }),
  );

  it.effect("allows unrelated roots only with an explicit override", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: makeThreadProjectSetCommand({ allowUnrelatedRoots: true }),
        readModel: makeReadModel({
          projects: [
            makeProject(SOURCE_PROJECT_ID, { workspaceRoot: "/repo-a" }),
            makeProject(TARGET_PROJECT_ID, { workspaceRoot: "/repo-b" }),
          ],
        }),
      });

      expect(result).toMatchObject({ type: "thread.project-set" });
    }),
  );

  it.effect("allows equal workspace roots", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: makeThreadProjectSetCommand(),
        readModel: makeReadModel({
          projects: [
            makeProject(SOURCE_PROJECT_ID, { workspaceRoot: "/repo" }),
            makeProject(TARGET_PROJECT_ID, { workspaceRoot: "/repo" }),
          ],
        }),
      });

      expect(result).toMatchObject({ type: "thread.project-set" });
    }),
  );
});

it.layer(NodeServices.layer)("project merge decider", (it) => {
  it.effect("moves every active source thread before deleting the source project", () =>
    Effect.gen(function* () {
      const secondThreadId = ThreadId.make("thread-to-move-2");
      const deletedThreadId = ThreadId.make("thread-already-deleted");
      const result = yield* decideOrchestrationCommand({
        command: makeProjectMergeCommand(),
        readModel: makeReadModel({
          threads: [
            makeThread(),
            makeThread({ id: secondThreadId }),
            makeThread({ id: deletedThreadId, deletedAt: NOW }),
          ],
        }),
      });

      expect(Array.isArray(result)).toBe(true);
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.project-set",
        "thread.project-set",
        "project.deleted",
      ]);
      expect(events.slice(0, 2).map((event) => event.aggregateId)).toEqual([
        THREAD_ID,
        secondThreadId,
      ]);
      expect(events.at(-1)).toMatchObject({
        type: "project.deleted",
        payload: { projectId: SOURCE_PROJECT_ID },
      });
    }),
  );

  it.effect("deletes an empty source project with one event", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: makeProjectMergeCommand(),
        readModel: makeReadModel({ threads: [] }),
      });

      const events = Array.isArray(result) ? result : [result];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "project.deleted",
        payload: { projectId: SOURCE_PROJECT_ID },
      });
    }),
  );

  it.effect("rejects merging a project into itself", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: makeProjectMergeCommand({ targetProjectId: SOURCE_PROJECT_ID }),
          readModel: makeReadModel(),
        }),
      );
      expect(error.message).toContain("cannot be merged into itself");
    }),
  );

  it.effect("passes the unrelated-root override through every expanded move", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({
        projects: [
          makeProject(SOURCE_PROJECT_ID, { workspaceRoot: "/repo-a" }),
          makeProject(TARGET_PROJECT_ID, { workspaceRoot: "/repo-b" }),
        ],
      });
      const rejected = yield* Effect.flip(
        decideOrchestrationCommand({
          command: makeProjectMergeCommand(),
          readModel,
        }),
      );
      expect(rejected.message).toContain("unrelated workspace roots");

      const allowed = yield* decideOrchestrationCommand({
        command: makeProjectMergeCommand({ allowUnrelatedRoots: true }),
        readModel,
      });
      const events = Array.isArray(allowed) ? allowed : [allowed];
      expect(events.map((event) => event.type)).toEqual(["thread.project-set", "project.deleted"]);
    }),
  );
});
