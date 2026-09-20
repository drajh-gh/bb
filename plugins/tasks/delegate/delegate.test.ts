import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createStore } from "../api";
import type { Comment, Project, Task } from "../db";
import { delegationRpcContract } from "./contract";
import { buildSeedPrompt, registerDelegation } from ".";

type ThreadListResult = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["list"]>
>;

function listedThread(
  overrides: Parameters<typeof makeThreadResponse>[0],
): ThreadListResult[number] {
  return {
    ...makeThreadResponse(overrides),
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
    },
    queuedWork: "none",
    pinSortKey: null,
    hasPendingInteraction: false,
    environmentHostId: null,
    environmentName: null,
    environmentBranchName: null,
    environmentPath: null,
    environmentProviderId: null,
    environmentIsWorktree: null,
    environmentWorkspaceDisplayKind: "other",
  };
}

function createTestPreset(
  store: ReturnType<typeof createStore>,
  overrides: Partial<{
    environmentKind: "project-default" | "new-worktree";
    baseBranch: string | null;
    machineId: string | null;
  }> = {},
) {
  return store.tasks.createPreset({
    name: "Test worker",
    providerId: "claude-code",
    modelId: "claude-sonnet-5",
    reasoningLevel: "high",
    serviceTier: "fast",
    permissionMode: "full",
    environmentKind: overrides.environmentKind ?? "project-default",
    baseBranch: overrides.baseBranch ?? null,
    machineId: overrides.machineId ?? null,
    instructions: "",
    builtin: false,
  });
}

describe("task delegation", () => {
  it("spawns from a preset, attaches the thread, advances status, comments, and invalidates", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          list: async (): Promise<ThreadListResult> => [
            listedThread({
              id: "thr_operations",
              title: "Haneda Operations",
              pinnedAt: Date.now(),
            }),
          ],
          spawn: async () => ({ id: "thr_delegated" }),
          get: async () =>
            makeThreadResponse({ id: "thr_delegated", status: "starting" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Tasks plugin",
      prefix: "TASK",
      color: "blue",
      linkedBbProjectId: "proj_bb",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Implement delegation",
      description: "Build the core agent loop.",
      status: "todo",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    const result = delegationRpcContract.delegate.output.parse(
      await harness.callRpc("delegate", {
        taskId: task.id,
        presetId: preset.id,
        extraInstructions: "Run the focused tests before reporting back.",
      }),
    );

    expect(result).toEqual({ threadId: "thr_delegated" });
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          projectId: "proj_bb",
          environment: { type: "project-default" },
          providerId: "claude-code",
          model: "claude-sonnet-5",
          reasoningLevel: "high",
          serviceTier: "fast",
          permissionMode: "full",
          title: "TASK-1 · Implement delegation",
          prompt: expect.stringContaining(
            "Run the focused tests before reporting back.",
          ),
          visibility: "hidden",
          parentThreadId: "thr_operations",
          origin: "plugin",
          originPluginId: "tasks",
        }),
      ],
    ]);
    expect(store.tasks.listTaskThreads(task.id)).toEqual([
      expect.objectContaining({
        taskId: task.id,
        threadId: "thr_delegated",
        presetName: "Test worker",
        title: "TASK-1 · Implement delegation",
        liveStatus: "starting",
      }),
    ]);
    expect(store.tasks.getTask(task.id)?.status).toBe("in_progress");
    expect(store.tasks.listComments(task.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "system",
          authorName: "Tasks",
          presetName: "Test worker",
          threadId: "thr_delegated",
          body: "Status changed to In Progress · dispatched to Test worker",
        }),
        expect.objectContaining({
          kind: "system",
          authorName: "Tasks",
          presetName: "Test worker",
          threadId: "thr_delegated",
          body: "Dispatched to Test worker",
        }),
      ]),
    );
    expect(harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: task.id } },
      {
        channel: "tasks:changed",
        payload: { taskId: task.id, projectId: project.id },
      },
      { channel: "comments:changed", payload: { taskId: task.id } },
    ]);

    await harness.dispose();
  });

  it("corrects the attached row when a delegated thread becomes active immediately", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => ({ id: "thr_fast" }),
          get: async () =>
            makeThreadResponse({ id: "thr_fast", status: "active" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Fast delegation",
      prefix: "FAST",
      color: "blue",
      linkedBbProjectId: "proj_bb",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Transition during spawn",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: preset.id,
    });

    expect(harness.sdk.callsTo("threads.get")).toEqual([
      [{ threadId: "thr_fast" }],
    ]);
    expect(store.tasks.listTaskThreads(task.id)).toEqual([
      expect.objectContaining({
        threadId: "thr_fast",
        liveStatus: "working",
      }),
    ]);

    await harness.dispose();
  });

  it("spawns a new worktree from the configured branch on the configured machine", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => ({ id: "thr_worktree" }),
          get: async () =>
            makeThreadResponse({ id: "thr_worktree", status: "starting" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Worktree delegation",
      prefix: "WT",
      color: "blue",
      linkedBbProjectId: "proj_demo",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Use a fresh checkout",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store, {
      environmentKind: "new-worktree",
      baseBranch: "release/next",
      machineId: "host_remote",
    });

    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: preset.id,
    });

    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          environment: {
            type: "host",
            hostId: "host_remote",
            workspace: {
              type: "managed-worktree",
              baseBranch: { kind: "named", name: "release/next" },
            },
          },
        }),
      ],
    ]);
    expect(harness.sdk.callsTo("system.config")).toEqual([]);

    await harness.dispose();
  });

  it("resolves the default machine and default branch for a worktree preset", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        system: {
          config: async () => ({ primaryHostId: "host_primary" }),
        },
        threads: {
          spawn: async () => ({ id: "thr_default_worktree" }),
          get: async () =>
            makeThreadResponse({
              id: "thr_default_worktree",
              status: "starting",
            }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Default worktree target",
      prefix: "DWT",
      color: "blue",
      linkedBbProjectId: "proj_demo",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Use default worktree target",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store, {
      environmentKind: "new-worktree",
    });

    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: preset.id,
    });

    expect(harness.sdk.callsTo("system.config")).toEqual([[]]);
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          environment: {
            type: "host",
            hostId: "host_primary",
            workspace: {
              type: "managed-worktree",
              baseBranch: { kind: "default" },
            },
          },
        }),
      ],
    ]);

    await harness.dispose();
  });

  it("maps a rejected worktree target to a friendly typed delegation error", async () => {
    const spawnError = Object.assign(new Error("HTTP 404: Host not found"), {
      code: "host_not_found",
      status: 404,
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => {
            throw spawnError;
          },
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Invalid target",
      prefix: "BAD",
      color: "blue",
      linkedBbProjectId: "proj_demo",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Reject bad machine",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store, {
      environmentKind: "new-worktree",
      baseBranch: "missing-branch",
      machineId: "host_missing",
    });

    await expect(
      harness.callRpc("delegate", {
        taskId: task.id,
        presetId: preset.id,
      }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message:
        "Could not create a worktree on host_missing from missing-branch: Host not found",
    });

    await harness.dispose();
  });

  it("fails before spawning when the task project is not linked to bb", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: { threads: { spawn: async () => ({ id: "thr_never" }) } },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Unlinked",
      prefix: "UNL",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Cannot delegate yet",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    await expect(
      harness.callRpc("delegate", { taskId: task.id, presetId: preset.id }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message: 'Task project "Unlinked" is not linked to a bb project',
    });
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);

    await harness.dispose();
  });

  it("self-attaches an existing thread through taskThreadsAttach", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async () => ({
            id: "thr_existing",
            title: "Existing worker",
            titleFallback: null,
            status: "active",
          }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Manual",
      prefix: "MAN",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Attach current worker",
    });
    registerDelegation(bb, store);

    await expect(
      harness.callRpc("taskThreadsAttach", {
        taskId: task.id,
        threadId: "thr_existing",
      }),
    ).resolves.toEqual({ threadId: "thr_existing" });
    expect(harness.sdk.callsTo("threads.get")).toEqual([
      [{ threadId: "thr_existing" }],
    ]);
    expect(store.tasks.listTaskThreads(task.id)).toEqual([
      expect.objectContaining({
        threadId: "thr_existing",
        presetName: "Attached",
        title: "Existing worker",
        liveStatus: "working",
      }),
    ]);
    expect(harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: task.id } },
      {
        channel: "tasks:changed",
        payload: { taskId: task.id, projectId: project.id },
      },
    ]);

    await harness.dispose();
  });
});

describe("task thread detach", () => {
  it("detaches an attached thread through taskThreadsDetach and invalidates", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            title: `Worker ${threadId}`,
            titleFallback: null,
            status: threadId === "thr_dead" ? "error" : "idle",
          }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Manual",
      prefix: "MAN",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Respawned work",
    });
    const otherTask = store.tasks.createTask({
      projectId: project.id,
      title: "Other work",
    });
    registerDelegation(bb, store);

    await harness.callRpc("taskThreadsAttach", {
      taskId: task.id,
      threadId: "thr_dead",
    });
    await harness.callRpc("taskThreadsAttach", {
      taskId: task.id,
      threadId: "thr_live",
    });
    await harness.callRpc("taskThreadsAttach", {
      taskId: otherTask.id,
      threadId: "thr_dead",
    });
    harness.realtimeSignals.length = 0;

    await expect(
      harness.callRpc("taskThreadsDetach", {
        taskId: task.id,
        threadId: "thr_dead",
      }),
    ).resolves.toEqual({ threadId: "thr_dead" });

    expect(
      store.tasks.listTaskThreads(task.id).map((thread) => thread.threadId),
    ).toEqual(["thr_live"]);
    expect(
      store.tasks
        .listTaskThreads(otherTask.id)
        .map((thread) => thread.threadId),
    ).toEqual(["thr_dead"]);
    expect(harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: task.id } },
      {
        channel: "tasks:changed",
        payload: { taskId: task.id, projectId: project.id },
      },
    ]);

    await expect(
      harness.callRpc("taskThreadsDetach", {
        taskId: task.id,
        threadId: "thr_dead",
      }),
    ).rejects.toThrow(`Thread thr_dead is not attached to ${task.key}`);

    await harness.dispose();
  });
});

describe("Operations routing", () => {
  const operations = listedThread({
    id: "thr_operations",
    title: "Haneda Operations",
    pinnedAt: 1,
  });

  it.each([
    { name: "missing coordinator", threads: [], parent: null },
    {
      name: "unrelated pinned root",
      threads: [{ ...operations, title: "Release review" }],
      parent: null,
    },
    {
      name: "multiple Operations roots",
      threads: [operations, { ...operations, id: "thr_other" }],
      parent: null,
    },
    {
      name: "pinned child",
      threads: [{ ...operations, parentThreadId: "thr_parent" }],
      parent: null,
    },
    {
      name: "unpinned Operations thread",
      threads: [{ ...operations, pinnedAt: null }],
      parent: null,
    },
    {
      name: "named Operations among unrelated pins",
      threads: [
        { ...operations, id: "thr_review", title: "Review" },
        operations,
      ],
      parent: "thr_operations",
    },
  ])(
    "handles $name without misrouting the worker",
    async ({ threads, parent }) => {
      const { bb, harness } = createFakePluginHost({
        pluginId: "tasks",
        sdk: {
          threads: {
            list: async (): Promise<ThreadListResult> => threads,
            spawn: async () => ({ id: "thr_worker" }),
            get: async () => makeThreadResponse({ id: "thr_worker" }),
          },
        },
      });
      const store = createStore(bb);
      const project = store.tasks.createProject({
        name: "Routing",
        prefix: "ROUTE",
        color: "blue",
        linkedBbProjectId: "proj_bb",
      });
      const task = store.tasks.createTask({
        projectId: project.id,
        title: "Route work",
      });
      registerDelegation(bb, store);

      await harness.callRpc("delegate", {
        taskId: task.id,
        presetId: createTestPreset(store).id,
      });

      expect(harness.sdk.callsTo("threads.list")[0]).toEqual([
        {
          projectId: "proj_bb",
          archived: false,
          includeHidden: false,
          hasParent: false,
          limit: 100,
          offset: 0,
        },
      ]);
      const [spawn] = harness.sdk.callsTo("threads.spawn")[0]!;
      expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
      expect(harness.sdk.callsTo("threads.update")).toEqual([]);
      expect(spawn).toMatchObject({ visibility: "hidden" });
      expect(spawn).toHaveProperty(
        "prompt",
        expect.stringContaining("never ask the operator to say “continue.”"),
      );
      if (parent === null) {
        expect(spawn).not.toHaveProperty("parentThreadId");
        expect(spawn).toHaveProperty(
          "prompt",
          expect.not.stringContaining("parent Operations thread"),
        );
      } else {
        expect(spawn).toHaveProperty("parentThreadId", parent);
        expect(spawn).toHaveProperty(
          "prompt",
          expect.stringContaining(`parent Operations thread ${parent}`),
        );
        expect(spawn).toHaveProperty(
          "prompt",
          expect.stringContaining(
            "resume this same work when its receipt arrives",
          ),
        );
        expect(spawn).toHaveProperty(
          "prompt",
          expect.stringContaining("Route routine questions"),
        );
        expect(spawn).toHaveProperty(
          "prompt",
          expect.stringContaining("Send one concise completion receipt"),
        );
      }
      expect(store.tasks.listTaskThreads(task.id)[0]?.threadId).toBe(
        "thr_worker",
      );
      await harness.dispose();
    },
  );

  it.each([
    "later coordinator",
    "later ambiguity",
    "lookup failure",
    "page bound",
  ])("handles %s", async (scenario) => {
    const page = Array.from({ length: 100 }, (_, index) =>
      listedThread({ id: `thr_${index}` }),
    );
    if (scenario === "later ambiguity" || scenario === "page bound") {
      page[0] = operations;
    }
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          list: async ({ offset } = {}): Promise<ThreadListResult> => {
            if (scenario === "lookup failure") throw new Error("Unavailable");
            if (scenario === "page bound") {
              return offset === 0
                ? page
                : page.map((thread) => ({ ...thread, pinnedAt: null }));
            }
            return offset === 0 ? page : [{ ...operations, id: "thr_later" }];
          },
          spawn: async () => ({ id: "thr_worker" }),
          get: async () => makeThreadResponse({ id: "thr_worker" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Routing",
      prefix: "ROUTE",
      color: "blue",
      linkedBbProjectId: "proj_bb",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Route work",
    });
    registerDelegation(bb, store);

    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: createTestPreset(store).id,
    });

    const [spawn] = harness.sdk.callsTo("threads.spawn")[0]!;
    expect(spawn).toHaveProperty("visibility", "hidden");
    if (scenario === "later coordinator") {
      expect(spawn).toHaveProperty("parentThreadId", "thr_later");
    } else {
      expect(spawn).not.toHaveProperty("parentThreadId");
    }
    expect(harness.sdk.callsTo("threads.list")).toHaveLength(
      scenario === "page bound" ? 10 : scenario === "lookup failure" ? 1 : 2,
    );
    await harness.dispose();
  });

  it("reveals a spawned worker when Task attachment fails", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          list: async (): Promise<ThreadListResult> => [operations],
          spawn: async () => ({ id: "thr_orphan" }),
          update: async () =>
            makeThreadResponse({
              id: "thr_orphan",
              visibility: "visible",
              parentThreadId: null,
            }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Routing",
      prefix: "ROUTE",
      color: "blue",
      linkedBbProjectId: "proj_bb",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Recover orphan",
    });
    registerDelegation(bb, {
      ...store,
      transaction: () => {
        throw new Error("Task attachment failed");
      },
    });

    await expect(
      harness.callRpc("delegate", {
        taskId: task.id,
        presetId: createTestPreset(store).id,
      }),
    ).rejects.toThrow("Task attachment failed");

    expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      visibility: "hidden",
      parentThreadId: "thr_operations",
    });
    expect(harness.sdk.callsTo("threads.update")).toEqual([
      [
        {
          threadId: "thr_orphan",
          visibility: "visible",
          parentThreadId: null,
        },
      ],
    ]);
    expect(store.tasks.listTaskThreads(task.id)).toEqual([]);

    await harness.dispose();
  });

  it("attaches a direct user thread without changing visibility or parentage", async () => {
    const direct = makeThreadResponse({
      id: "thr_direct",
      visibility: "visible",
      parentThreadId: null,
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: { threads: { get: async () => direct } },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Direct",
      prefix: "DIR",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Direct work",
    });
    registerDelegation(bb, store);

    await harness.callRpc("taskThreadsAttach", {
      taskId: task.id,
      threadId: direct.id,
    });

    expect(harness.sdk.calls).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.get")).toEqual([
      [{ threadId: direct.id }],
    ]);
    expect(store.tasks.listTaskThreads(task.id)[0]?.threadId).toBe(direct.id);
    expect(direct).toMatchObject({
      visibility: "visible",
      parentThreadId: null,
    });
    await harness.dispose();
  });
});

describe("delegation seed prompt", () => {
  it("captures task context and the complete report-back contract", () => {
    const project: Project = {
      id: "01J00000000000000000000001",
      name: "Tasks plugin",
      prefix: "TASK",
      nextTaskNumber: 4,
      color: "blue",
      folderId: null,
      linkedBbProjectId: "proj_tasks",
      createdAt: "2026-07-15T17:00:00.000Z",
    };
    const task: Task = {
      id: "01J00000000000000000000002",
      projectId: project.id,
      number: 1,
      key: "TASK-1",
      title: "Delegate work",
      description:
        "Implement **preset-driven** delegation.\n\nKeep the prompt useful.",
      status: "todo",
      priority: "high",
      dueDate: null,
      parentTaskId: null,
      position: 1_024,
      createdAt: "2026-07-15T17:01:00.000Z",
      updatedAt: "2026-07-15T17:01:00.000Z",
    };
    const subtask: Task = {
      ...task,
      id: "01J00000000000000000000003",
      number: 2,
      key: "TASK-2",
      title: "Add focused tests",
      status: "in_progress",
      parentTaskId: task.id,
    };
    const comments: Comment[] = [
      {
        id: "01J00000000000000000000004",
        taskId: task.id,
        kind: "user",
        authorName: "Sawyer",
        presetName: null,
        threadId: null,
        body: "Preserve the existing domain path.",
        notifiedCount: 0,
        createdAt: "2026-07-15T17:02:00.000Z",
      },
      {
        id: "01J00000000000000000000005",
        taskId: task.id,
        kind: "agent",
        authorName: "Worker",
        presetName: "Sonnet · high",
        threadId: "thr_prior",
        body: "The schema study is complete.",
        notifiedCount: 0,
        createdAt: "2026-07-15T17:03:00.000Z",
      },
    ];

    expect(
      buildSeedPrompt({
        task,
        project,
        subtasks: [subtask],
        attachments: [
          {
            id: "01J00000000000000000000006",
            fileName: "delegation-notes.md",
          },
        ],
        recentComments: comments,
        presetInstructions: "Prefer focused changes.",
        extraInstructions: "Run the backend gates.",
        coordinatorThreadId: null,
      }),
    ).toMatchInlineSnapshot(`
      "# TASK-1 · Delegate work

      ## Description

      Implement **preset-driven** delegation.

      Keep the prompt useful.

      ## Project context

      - Name: Tasks plugin
      - Linked bb project: proj_tasks

      ## Sub-tasks

      - TASK-2 · Add focused tests (in_progress)

      ## Attachments

      - delegation-notes.md · 01J00000000000000000000006
        Fetch with: bb tasks attachment get 01J00000000000000000000006 --out <path>

      ## Recent comments

      ### Sawyer · user · 2026-07-15T17:02:00.000Z

      Preserve the existing domain path.

      ### Worker · agent · 2026-07-15T17:03:00.000Z

      The schema study is complete.

      ## Report-back contract

      You are working on task TASK-1. Continue through implementation, verification, compaction, and reporting until the authorized outcome reaches a terminal boundary; never ask the operator to say “continue.” Use the bb tasks CLI: comment substantive updates (bb tasks comment TASK-1 --body ...), attach result artifacts, set status when done (bb tasks update TASK-1 --status in_review) or explain blockage in a comment. Your thread is already attached to the task.

      ## Preset instructions

      Prefer focused changes.

      ## Additional instructions

      Run the backend gates.
      "
    `);
  });
});
