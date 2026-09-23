import { describe, expect, it } from "vitest";

import {
  buildCodexMcpElicitationCancellationResponse,
  buildCodexInteractiveResponse,
  decodeCodexInteractiveRequest,
  extractCodexMacOsPermissionRequest,
} from "./interactive-requests.js";
import { ProviderRequestDecodeError } from "@bb/provider-bridge-protocol/bridge-kit";

describe("decodeCodexInteractiveRequest", () => {
  it("maps command approval requests into pending interaction payloads", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 8,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [
            {
              type: "unknown",
              command: "git push",
            },
          ],
          additionalPermissions: {
            network: { enabled: true },
            fileSystem: null,
            macos: null,
          },
          availableDecisions: ["accept", "acceptForSession", "decline"],
        },
      }),
    ).toEqual({
      requestId: 8,
      method: "item/commandExecution/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-1",
      payload: {
        kind: "approval",
        subject: {
          kind: "command",
          itemId: "item-1",
          command: "git push",
          cwd: "/tmp/project",
          actions: [
            {
              type: "unknown",
              command: "git push",
            },
          ],
          sessionGrant: {
            network: { enabled: true },
            fileSystem: null,
          },
        },
        reason: "Needs approval",
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    });
  });

  it("omits command session approval without session grants", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 80,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          availableDecisions: ["accept", "acceptForSession", "decline"],
        },
      }),
    ).toEqual({
      requestId: 80,
      method: "item/commandExecution/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-1",
      payload: {
        kind: "approval",
        subject: {
          kind: "command",
          itemId: "item-1",
          command: "git push",
          cwd: "/tmp/project",
          actions: [],
          sessionGrant: null,
        },
        reason: "Needs approval",
        availableDecisions: ["allow_once", "deny"],
      },
    });
  });

  it("rejects empty command approval decisions as invalid params", () => {
    expect(() =>
      decodeCodexInteractiveRequest({
        id: 8,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          availableDecisions: [],
        },
      }),
    ).toThrowError(ProviderRequestDecodeError);
  });

  it("maps cancel-only command approval decisions to deny", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 8,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          availableDecisions: ["cancel"],
        },
      }),
    ).toMatchObject({
      payload: {
        availableDecisions: ["deny"],
      },
    });
  });

  it("keeps a command approval that asks for macOS permissions and surfaces the profile beside it", () => {
    const request = {
      id: 8,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "item-1",
        reason: "Needs approval",
        command: "osascript -e 'tell app \"Finder\" to activate'",
        cwd: "/tmp/project",
        commandActions: [],
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: null,
          macos: {
            preferences: "read_only",
            automations: {
              bundle_ids: ["com.apple.finder"],
            },
            launchServices: true,
            accessibility: true,
            calendar: false,
            reminders: false,
            contacts: "none",
          },
        },
        availableDecisions: ["accept", "acceptForSession", "decline"],
      },
    };

    const decoded = decodeCodexInteractiveRequest(request);
    expect(decoded?.payload).toMatchObject({
      kind: "approval",
      subject: {
        kind: "command",
        itemId: "item-1",
        sessionGrant: { network: { enabled: true }, fileSystem: null },
      },
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    });

    expect(extractCodexMacOsPermissionRequest(request)).toEqual({
      providerThreadId: "t1",
      turnId: "turn-1",
      item: {
        approvalItemId: "item-1",
        reason: "Needs approval",
        permissions: {
          preferences: "read_only",
          automations: { kind: "bundle_ids", bundleIds: ["com.apple.finder"] },
          launchServices: true,
          accessibility: true,
          calendar: false,
          reminders: false,
          contacts: "none",
        },
      },
    });
  });

  it("extracts no macOS profile from approvals that carry none", () => {
    expect(
      extractCodexMacOsPermissionRequest({
        id: 81,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: null,
          command: "open -a Finder",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: { network: null, fileSystem: null },
          availableDecisions: ["accept", "decline"],
        },
      }),
    ).toBeNull();
    expect(
      extractCodexMacOsPermissionRequest({
        id: 82,
        method: "item/permissions/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: null,
          permissions: { network: { enabled: true }, fileSystem: null },
        },
      }),
    ).toBeNull();
  });

  it("ignores unsupported policy-amendment decisions when simple decisions remain", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 9,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-2",
          itemId: "item-2",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: null,
          availableDecisions: [
            {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: ["allow", "git", "push"],
              },
            },
            {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: {
                  host: "api.openai.com",
                  action: "allow",
                },
              },
            },
            "decline",
          ],
        },
      }),
    ).toMatchObject({
      payload: {
        kind: "approval",
        subject: {
          kind: "command",
          command: "git push",
        },
        availableDecisions: ["deny"],
      },
    });
  });

  it("rejects policy-amendment-only command approval decisions", () => {
    expect(() =>
      decodeCodexInteractiveRequest({
        id: 90,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-network-amendment",
          itemId: "item-network-amendment",
          reason: "Needs network policy approval",
          command: "curl https://api.openai.com",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: null,
          availableDecisions: [
            {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: ["allow", "git", "push"],
              },
            },
            {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: {
                  host: "api.openai.com",
                  action: "allow",
                },
              },
            },
          ],
        },
      }),
    ).toThrowError(ProviderRequestDecodeError);
  });

  it("preserves deny when policy amendments are paired with cancel", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 91,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-network-amendment-deny",
          itemId: "item-network-amendment-deny",
          reason: "Needs network policy approval",
          command: "curl https://api.openai.com",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: null,
          availableDecisions: [
            {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: {
                  host: "api.openai.com",
                  action: "allow",
                },
              },
            },
            "cancel",
          ],
        },
      }),
    ).toMatchObject({
      payload: {
        availableDecisions: ["deny"],
      },
    });
  });

  it("maps file-change approvals into pending interactions", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 10,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-file-change",
          itemId: "item-file-change",
          reason: "Review generated file changes",
          grantRoot: "/tmp/project",
        },
      }),
    ).toEqual({
      requestId: 10,
      method: "item/fileChange/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-file-change",
      payload: {
        kind: "approval",
        subject: {
          kind: "file_change",
          itemId: "item-file-change",
          writeScope: "/tmp/project",
          sessionGrant: {
            network: null,
            fileSystem: {
              read: [],
              write: ["/tmp/project"],
            },
          },
        },
        reason: "Review generated file changes",
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    });
  });

  it("omits file-change session approval without grant root", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 11,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-file-change",
          itemId: "item-file-change",
          reason: "Review generated file changes",
          grantRoot: null,
        },
      }),
    ).toEqual({
      requestId: 11,
      method: "item/fileChange/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-file-change",
      payload: {
        kind: "approval",
        subject: {
          kind: "file_change",
          itemId: "item-file-change",
          writeScope: null,
          sessionGrant: null,
        },
        reason: "Review generated file changes",
        availableDecisions: ["allow_once", "deny"],
      },
    });
  });

  it("maps permission approvals into pending interactions", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 11,
        method: "item/permissions/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-permissions",
          itemId: "item-permissions",
          reason: "Need network access",
          permissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp/project/README.md"],
              write: [],
            },
          },
        },
      }),
    ).toEqual({
      requestId: 11,
      method: "item/permissions/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-permissions",
      payload: {
        kind: "approval",
        subject: {
          kind: "permission_grant",
          itemId: "item-permissions",
          toolName: null,
          permissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp/project/README.md"],
              write: [],
            },
          },
        },
        reason: "Need network access",
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    });
  });

  it("accepts and strips unknown top-level fields from the generated-schema empty-object form", () => {
    const decoded = decodeCodexInteractiveRequest({
      id: "elicitation-1",
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "example-server",
        threadId: "provider-thread-1",
        turnId: "provider-turn-1",
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
      },
    });

    expect(decoded).toEqual({
      requestId: "elicitation-1",
      method: "mcpServer/elicitation/request",
      providerThreadId: "provider-thread-1",
      turnId: "provider-turn-1",
      payload: {
        kind: "user_question",
        questions: [
          {
            id: "mcp-form-confirmation",
            prompt: "Allow this MCP request?",
            shortLabel: "example-server",
            multiSelect: false,
            options: [
              { value: "accept", label: "Accept" },
              { value: "decline", label: "Decline" },
              { value: "cancel", label: "Cancel" },
            ],
            allowFreeText: false,
          },
        ],
      },
    });
    expect(JSON.stringify(decoded)).not.toContain("top-level-sensitive");
  });

  it.each([
    ["a string session capability", { persist: "session" }, true],
    [
      "an array containing session and always",
      { persist: ["always", "session"] },
      true,
    ],
    ["absent persistence metadata", { untrusted: "ignored" }, false],
    ["an always-only capability", { persist: ["always"] }, false],
    ["a malformed persistence capability", { persist: ["session", 1] }, false],
  ])("maps %s without widening persistence", (_name, metadata, expected) => {
    const decoded = decodeCodexInteractiveRequest({
      id: "elicitation-persistence",
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "example-server",
        threadId: "provider-thread-1",
        turnId: "provider-turn-1",
        mode: "form",
        message: "Allow this MCP request?",
        requestedSchema: { type: "object", properties: {} },
        _meta: metadata,
      },
    });

    expect(decoded?.payload).toMatchObject({ kind: "user_question" });
    if (decoded?.payload.kind !== "user_question") {
      throw new Error("Expected an MCP user-question interaction");
    }
    expect(decoded.payload.questions[0]?.options).toContainEqual(
      expected
        ? { value: "accept_for_session", label: "Allow for this session" }
        : { value: "accept", label: "Accept" },
    );
    expect(
      decoded.payload.questions[0]?.options.some(
        (option) => option.value === "accept_for_session",
      ),
    ).toBe(expected);
    expect(JSON.stringify(decoded)).not.toContain("always");
  });

  it("keeps an absent generated-schema turn id nullable for bridge correlation", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: "elicitation-missing-turn",
        method: "mcpServer/elicitation/request",
        params: {
          serverName: "example-server",
          threadId: "provider-thread-1",
          mode: "form",
          message: "Allow this MCP request?",
          requestedSchema: { type: "object", properties: {} },
        },
      }),
    ).toMatchObject({ turnId: null });
  });

  it.each([
    ["URL mode", { mode: "url", url: "https://sensitive.example" }],
    ["OpenAI form mode", { mode: "openai/form" }],
    ["a missing requested schema", { requestedSchema: undefined }],
    [
      "a nonempty primitive form",
      {
        requestedSchema: {
          type: "object",
          properties: { secretField: { type: "boolean" } },
        },
      },
    ],
    [
      "an unknown requested-schema field",
      {
        requestedSchema: {
          type: "object",
          properties: {},
          futureSchemaKeyword: "sensitive-schema-value",
        },
      },
    ],
  ])("rejects %s with bounded diagnostics", (_name, patch) => {
    let error: unknown;
    try {
      decodeCodexInteractiveRequest({
        id: "elicitation-invalid",
        method: "mcpServer/elicitation/request",
        params: {
          serverName: "example-server",
          threadId: "provider-thread-1",
          turnId: "provider-turn-1",
          mode: "form",
          message: "Allow this MCP request?",
          requestedSchema: { type: "object", properties: {} },
          ...patch,
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProviderRequestDecodeError);
    expect(String(error)).toMatch(/Unsupported MCP form elicitation:/);
    expect(String(error)).not.toContain("sensitive");
  });
});

describe("buildCodexInteractiveResponse", () => {
  it("maps bb command approvals back to Codex responses", () => {
    expect(
      buildCodexInteractiveResponse({
        payload: {
          kind: "approval",
          subject: {
            kind: "command",
            itemId: "item-1",
            command: "git push",
            cwd: "/tmp/project",
            actions: [],
            sessionGrant: null,
          },
          reason: null,
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: null,
        },
      }),
    ).toEqual({
      decision: "acceptForSession",
    });
  });

  it("maps command denial back to Codex responses", () => {
    expect(
      buildCodexInteractiveResponse({
        payload: {
          kind: "approval",
          subject: {
            kind: "command",
            itemId: "item-3",
            command: "git push",
            cwd: "/tmp/project",
            actions: [],
            sessionGrant: null,
          },
          reason: null,
          availableDecisions: ["allow_once", "deny"],
        },
        resolution: {
          decision: "deny",
        },
      }),
    ).toEqual({
      decision: "decline",
    });
  });

  it("maps file-change approvals back to Codex responses", () => {
    expect(
      buildCodexInteractiveResponse({
        payload: {
          kind: "approval",
          subject: {
            kind: "file_change",
            itemId: "item-file-change",
            writeScope: null,
            sessionGrant: null,
          },
          reason: "Review generated file changes",
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: null,
        },
      }),
    ).toEqual({
      decision: "acceptForSession",
    });
  });

  it("maps permission grants back to Codex responses", () => {
    expect(
      buildCodexInteractiveResponse({
        payload: {
          kind: "approval",
          subject: {
            kind: "permission_grant",
            itemId: "item-permissions",
            toolName: null,
            permissions: {
              network: { enabled: true },
              fileSystem: {
                read: ["/tmp/project/README.md"],
                write: [],
              },
            },
          },
          reason: "Need network access",
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp/project/README.md"],
              write: [],
            },
          },
        },
      }),
    ).toEqual({
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: ["/tmp/project/README.md"],
          write: null,
        },
      },
      scope: "session",
    });
  });

  it.each([
    ["accept", { action: "accept", content: {} }],
    ["decline", { action: "decline", content: null }],
    ["cancel", { action: "cancel", content: null }],
  ] as const)("maps the explicit MCP form %s choice", (selected, response) => {
    expect(
      buildCodexInteractiveResponse({
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "mcp-form-confirmation",
              prompt: "Allow this MCP request?",
              shortLabel: "example-server",
              multiSelect: false,
              options: [
                { value: "accept", label: "Accept" },
                { value: "decline", label: "Decline" },
                { value: "cancel", label: "Cancel" },
              ],
              allowFreeText: false,
            },
          ],
        },
        resolution: {
          kind: "user_answer",
          answers: {
            "mcp-form-confirmation": { selected: [selected] },
          },
        },
      }),
    ).toEqual(response);
  });

  it("maps an advertised session choice to the exact session persistence response", () => {
    expect(
      buildCodexInteractiveResponse({
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "mcp-form-confirmation",
              prompt: "Allow this MCP request?",
              shortLabel: "example-server",
              multiSelect: false,
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
        resolution: {
          kind: "user_answer",
          answers: {
            "mcp-form-confirmation": {
              selected: ["accept_for_session"],
            },
          },
        },
      }),
    ).toEqual({
      action: "accept",
      content: null,
      _meta: { persist: "session" },
    });
  });

  it("rejects a session choice that the request did not advertise", () => {
    expect(() =>
      buildCodexInteractiveResponse({
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "mcp-form-confirmation",
              prompt: "Allow this MCP request?",
              shortLabel: "example-server",
              multiSelect: false,
              options: [
                { value: "accept", label: "Accept" },
                { value: "decline", label: "Decline" },
                { value: "cancel", label: "Cancel" },
              ],
              allowFreeText: false,
            },
          ],
        },
        resolution: {
          kind: "user_answer",
          answers: {
            "mcp-form-confirmation": {
              selected: ["accept_for_session"],
            },
          },
        },
      }),
    ).toThrowError(/unavailable session option/);
  });

  it("keeps lifecycle cancellation distinct from operator decline", () => {
    expect(buildCodexMcpElicitationCancellationResponse()).toEqual({
      action: "cancel",
      content: null,
    });
  });

  it.each([
    ["a missing choice", {}],
    [
      "free text",
      {
        "mcp-form-confirmation": {
          selected: ["accept"],
          freeText: "approve it",
        },
      },
    ],
    [
      "multiple choices",
      { "mcp-form-confirmation": { selected: ["accept", "decline"] } },
    ],
    [
      "an unknown choice",
      { "mcp-form-confirmation": { selected: ["approve"] } },
    ],
    [
      "an unrelated answer",
      {
        "mcp-form-confirmation": { selected: ["accept"] },
        unrelated: { selected: ["accept"] },
      },
    ],
  ])("rejects %s instead of defaulting to acceptance", (_name, answers) => {
    expect(() =>
      buildCodexInteractiveResponse({
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "mcp-form-confirmation",
              prompt: "Allow this MCP request?",
              shortLabel: "example-server",
              multiSelect: false,
              options: [
                { value: "accept", label: "Accept" },
                { value: "decline", label: "Decline" },
                { value: "cancel", label: "Cancel" },
              ],
              allowFreeText: false,
            },
          ],
        },
        resolution: {
          kind: "user_answer",
          answers,
        },
      }),
    ).toThrowError();
  });
});
