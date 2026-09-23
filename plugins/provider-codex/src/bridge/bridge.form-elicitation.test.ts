import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import {
  BRIDGE_INBOUND_REQUEST_METHODS,
  type BridgeExecutionOptions,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type {
  BridgeJsonRpcOutputMessage,
  BridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";

import { experimental_killAllChildrenForTests, handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

const BB_THREAD_ID = "thr_form_elicitation";
const ELICITATION_METHOD = "mcpServer/elicitation/request";
const GENERATED_SCHEMA_EMPTY_FORM = {
  serverName: "example-server",
  threadId: "script-thread",
  turnId: "turn-placeholder",
  mode: "form",
  message: "Allow this MCP request?",
  requestedSchema: {
    $schema: null,
    type: "object",
    properties: {},
    required: null,
  },
  _meta: { untrusted: "ignored" },
  futureTopLevel: { secret: "top-level-sensitive" },
};

const SESSION_OPTIONS_BY_MODE = {
  "accept-edits": {
    permissionMode: "accept-edits",
    permissionScope: "workspace",
    approvalReviewer: "user",
    permissionEscalation: "ask",
  },
  auto: {
    permissionMode: "auto",
    permissionScope: "workspace",
    approvalReviewer: "automatic",
    permissionEscalation: "ask",
  },
  full: FULL_ACCESS_SESSION_OPTIONS,
} as const satisfies Record<string, BridgeExecutionOptions>;

let harness: BridgeJsonRpcTestHarness;
let workspaceDir: string;
let responseLogPath: string;
let requestLogPath: string;

interface TurnMarker {
  messageCount: number;
  responseCount: number;
}

function formParams(turnId: string | null) {
  return {
    ...GENERATED_SCHEMA_EMPTY_FORM,
    ...(turnId === null ? { turnId: null } : { turnId }),
  };
}

function scriptedTurn(
  turnId: string,
  request: Record<string, unknown>,
  options: {
    preserveThreadId?: boolean;
    requestKind?: "request" | "requestAndContinue";
  } = {},
) {
  return [
    {
      method: "turn/started",
      params: {
        threadId: "script-thread",
        turn: { id: turnId, status: "inProgress" },
      },
    },
    {
      kind: options.requestKind ?? "request",
      method: ELICITATION_METHOD,
      params: request,
      ...(options.preserveThreadId === true ? { preserveThreadId: true } : {}),
    },
    {
      method: "turn/completed",
      params: {
        threadId: "script-thread",
        turn: { id: turnId, status: "completed" },
      },
    },
  ];
}

function readJsonLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForResponseCount(count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (readJsonLines(responseLogPath).length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} app-server responses`);
}

async function waitForInteractionRequest(
  marker: TurnMarker,
): Promise<BridgeJsonRpcOutputMessage> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const request = harness.messages
      .slice(marker.messageCount)
      .find(
        (message) =>
          message.method ===
            BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest &&
          message.id !== undefined,
      );
    if (request !== undefined) {
      return request;
    }
    const responses = readJsonLines(responseLogPath).slice(
      marker.responseCount,
    );
    if (responses.length > 0) {
      throw new Error(
        `App-server request resolved without an interaction: ${JSON.stringify(responses)}`,
      );
    }
    await harness.flushWork();
  }
  throw new Error(
    `Timed out waiting for an MCP form interaction request: ${JSON.stringify({ bridge: harness.messages.slice(marker.messageCount), appServer: readJsonLines(requestLogPath) })}`,
  );
}

async function startSession(
  options: BridgeExecutionOptions = FULL_ACCESS_SESSION_OPTIONS,
): Promise<string> {
  harness.sendRequest(1, "thread/start", {
    threadId: BB_THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options,
  });
  const response = await harness.waitForResponse(1);
  const providerThreadId = (
    response.result as { providerThreadId?: unknown } | undefined
  )?.providerThreadId;
  if (typeof providerThreadId !== "string") {
    throw new Error(`thread/start failed: ${JSON.stringify(response)}`);
  }
  return providerThreadId;
}

function startTurn(
  id: number,
  providerThreadId: string,
  options: BridgeExecutionOptions = FULL_ACCESS_SESSION_OPTIONS,
): TurnMarker {
  const marker = {
    messageCount: harness.messages.length,
    responseCount: readJsonLines(responseLogPath).length,
  };
  harness.sendRequest(id, "turn/start", {
    threadId: BB_THREAD_ID,
    providerThreadId,
    input: [{ type: "text", text: `turn-${id}`, mentions: [] }],
    clientRequestId: encodeClientTurnRequestIdNumber({ value: id }),
    options,
  });
  return marker;
}

function answerInteraction(
  request: BridgeJsonRpcOutputMessage,
  response: { result: unknown } | { error: { code: number; message: string } },
): void {
  if (request.id === undefined) {
    throw new Error("Expected interaction request id");
  }
  handleLine(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...response }));
}

function userAnswer(selected: string) {
  return {
    kind: "user_answer",
    answers: {
      "mcp-form-confirmation": { selected: [selected] },
    },
  };
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-form-elicitation-"));
  responseLogPath = join(workspaceDir, "responses.ndjson");
  requestLogPath = join(workspaceDir, "requests.ndjson");
  const scriptPath = join(workspaceDir, "script.json");
  writeFileSync(
    scriptPath,
    JSON.stringify({
      responseLogPath,
      requestLogPath,
      turns: [
        scriptedTurn("turn-accept", {
          ...formParams("turn-accept"),
          _meta: { persist: ["session", "always"] },
        }),
        scriptedTurn("turn-decline", formParams("turn-decline")),
        scriptedTurn("turn-cancel", formParams("turn-cancel")),
        scriptedTurn("turn-lifecycle", formParams("turn-lifecycle")),
        scriptedTurn("turn-malformed", formParams("turn-malformed")),
        scriptedTurn("turn-missing", formParams(null)),
        scriptedTurn("turn-stale", formParams("turn-old")),
        scriptedTurn(
          "turn-wrong-thread",
          { ...formParams("turn-wrong-thread"), threadId: "wrong-thread" },
          { preserveThreadId: true },
        ),
        scriptedTurn("turn-url", {
          ...formParams("turn-url"),
          mode: "url",
          url: "https://sensitive.example",
          elicitationId: "sensitive-id",
        }),
        scriptedTurn("turn-fields", {
          ...formParams("turn-fields"),
          requestedSchema: {
            type: "object",
            properties: {},
            futureSchemaKeyword: "sensitive-schema-value",
          },
        }),
        scriptedTurn("turn-openai-form", {
          ...formParams("turn-openai-form"),
          mode: "openai/form",
        }),
        scriptedTurn("turn-late", formParams("turn-late"), {
          requestKind: "requestAndContinue",
        }),
      ],
    }),
  );
  stubFakeCodexAppServer(scriptPath);
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  experimental_killAllChildrenForTests();
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe.each(Object.entries(SESSION_OPTIONS_BY_MODE))(
  "%s permission mode",
  (_mode, options) => {
    it("always asks the operator and strips unknown top-level fixture fields", async () => {
      const providerThreadId = await startSession(options);
      const marker = startTurn(2, providerThreadId, options);
      const request = await waitForInteractionRequest(marker);
      expect(readJsonLines(responseLogPath)).toEqual([]);
      expect(request.params).toMatchObject({
        threadId: BB_THREAD_ID,
        providerThreadId,
        providerNativeIds: true,
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "mcp-form-confirmation",
              prompt: "Allow this MCP request?",
              shortLabel: "example-server",
              options: [
                { value: "accept", label: "Accept" },
                {
                  value: "accept_for_session",
                  label: "Allow for this session",
                },
                { value: "decline", label: "Decline" },
                { value: "cancel", label: "Cancel" },
              ],
              allowFreeText: false,
            },
          ],
        },
      });
      expect(JSON.stringify(request.params)).not.toContain(
        "top-level-sensitive",
      );
      answerInteraction(request, { result: userAnswer("cancel") });
      await harness.waitForResponse(2);
      await waitForResponseCount(1);
      expect(readJsonLines(responseLogPath)[0]).toMatchObject({
        result: { action: "cancel", content: null },
      });
      expect(JSON.stringify(readJsonLines(responseLogPath)[0])).not.toContain(
        "top-level-sensitive",
      );
    }, 20_000);
  },
);

it("returns exact session persistence only for the advertised session choice", async () => {
  const providerThreadId = await startSession();
  const marker = startTurn(2, providerThreadId);
  const request = await waitForInteractionRequest(marker);
  answerInteraction(request, { result: userAnswer("accept_for_session") });
  await harness.waitForResponse(2);
  await waitForResponseCount(1);
  expect(readJsonLines(responseLogPath)[0]).toMatchObject({
    result: {
      action: "accept",
      content: null,
      _meta: { persist: "session" },
    },
  });
});

it("bridges explicit outcomes and fails malformed, unsupported, and stale states closed", async () => {
  const providerThreadId = await startSession();

  for (const [id, selected, expected] of [
    [2, "accept", { action: "accept", content: {} }],
    [3, "decline", { action: "decline", content: null }],
    [4, "cancel", { action: "cancel", content: null }],
  ] as const) {
    const marker = startTurn(id, providerThreadId);
    const request = await waitForInteractionRequest(marker);
    if (selected === "accept") {
      expect(request.params).toMatchObject({
        payload: {
          questions: [
            {
              options: expect.arrayContaining([
                {
                  value: "accept_for_session",
                  label: "Allow for this session",
                },
              ]),
            },
          ],
        },
      });
    }
    answerInteraction(request, { result: userAnswer(selected) });
    await harness.waitForResponse(id);
    await waitForResponseCount(id - 1);
    expect(readJsonLines(responseLogPath)[id - 2]).toMatchObject({
      result: expected,
    });
    if (selected === "accept") {
      expect(readJsonLines(responseLogPath)[id - 2]).not.toHaveProperty(
        "result._meta",
      );
    }
  }

  let marker = startTurn(5, providerThreadId);
  let request = await waitForInteractionRequest(marker);
  answerInteraction(request, {
    error: { code: -32_000, message: "thread stopped" },
  });
  await harness.waitForResponse(5);
  await waitForResponseCount(4);
  expect(readJsonLines(responseLogPath)[3]).toMatchObject({
    result: { action: "cancel", content: null },
  });

  marker = startTurn(6, providerThreadId);
  request = await waitForInteractionRequest(marker);
  answerInteraction(request, { result: {} });
  await harness.waitForResponse(6);
  await waitForResponseCount(5);
  expect(readJsonLines(responseLogPath)[4]).toMatchObject({
    result: { action: "cancel", content: null },
  });

  const interactionCount = harness.messages.filter(
    (message) =>
      message.method === BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest,
  ).length;
  for (const id of [7, 8, 9, 10, 11, 12]) {
    startTurn(id, providerThreadId);
    await harness.waitForResponse(id);
  }
  await waitForResponseCount(11);
  expect(
    harness.messages.filter(
      (message) =>
        message.method === BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest,
    ),
  ).toHaveLength(interactionCount);
  expect(readJsonLines(responseLogPath).slice(5, 8)).toEqual(
    Array.from({ length: 3 }, () =>
      expect.objectContaining({
        result: { action: "cancel", content: null },
      }),
    ),
  );
  for (const response of readJsonLines(responseLogPath).slice(8, 11)) {
    expect(response).toMatchObject({
      error: {
        code: -32_602,
        message: expect.stringMatching(/^Unsupported MCP form elicitation:/),
      },
    });
    expect(JSON.stringify(response)).not.toContain("sensitive");
  }

  marker = startTurn(13, providerThreadId);
  request = await waitForInteractionRequest(marker);
  await harness.waitForResponse(13);
  answerInteraction(request, { result: userAnswer("accept") });
  await waitForResponseCount(12);
  expect(readJsonLines(responseLogPath)[11]).toMatchObject({
    result: { action: "cancel", content: null },
  });

  const initialize = readJsonLines(requestLogPath).find(
    (entry) => entry.method === "initialize",
  );
  expect(initialize).toBeDefined();
  expect(initialize).not.toHaveProperty(
    "params.capabilities.mcpServerOpenaiFormElicitation",
  );
}, 60_000);
