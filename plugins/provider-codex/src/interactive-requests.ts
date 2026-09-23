import {
  ProviderRequestDecodeError as ProviderRequestDecodeErrorValue,
  ProviderResponseEncodeError,
  isApprovalInteractionOutcome,
  type ApprovalInteractionOutcome,
  type DecodedInteractiveRequest,
  type ProviderInteractionOutcome,
  type ProviderInboundRequest,
  type PendingInteractionApprovalDecision,
  type PendingInteractionGrantablePermissionProfile,
  type PendingInteractionGrantedPermissionProfile,
  type PendingInteractionRequestedPermissionProfile,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { CodexMacOsPermissionItem } from "./extension-kinds.js";
import { z } from "zod";
import { normalizePendingInteractionRequestedPermissionProfile } from "./pending-interaction-normalization.js";
import type { CommandExecutionRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/FileChangeRequestApprovalResponse.js";
import type { PermissionsRequestApprovalResponse } from "./generated/codex-app-server/schema/v2/PermissionsRequestApprovalResponse.js";
import {
  codexCommandExecutionRequestApprovalParamsSchema,
  codexFileChangeRequestApprovalParamsSchema,
  codexPermissionsRequestApprovalParamsSchema,
} from "./schemas.js";
import type {
  CodexAdditionalPermissions,
  CodexCommandApprovalDecision,
  CodexRequestedPermissionProfile,
  CodexSimpleCommandApprovalDecision,
} from "./schemas.js";

type CodexInteractiveResponse =
  | CommandExecutionRequestApprovalResponse
  | FileChangeRequestApprovalResponse
  | PermissionsRequestApprovalResponse
  | CodexMcpElicitationResponse;

export const CODEX_MCP_SERVER_ELICITATION_REQUEST_METHOD =
  "mcpServer/elicitation/request";

type CodexMcpElicitationResponse =
  | { action: "accept"; content: Record<string, never> }
  | {
      action: "accept";
      content: null;
      _meta: { persist: "session" };
    }
  | { action: "decline" | "cancel"; content: null };

const codexEmptyMcpElicitationSchema = z
  .object({
    type: z.literal("object"),
    properties: z.object({}).strict(),
    required: z.union([z.tuple([]), z.null()]).optional(),
    $schema: z.string().max(512).nullable().optional(),
  })
  .strict();

const codexEmptyFormElicitationParamsSchema = z
  .object({
    serverName: z.string().trim().min(1).max(128),
    threadId: z.string().trim().min(1).max(256),
    turnId: z.string().trim().min(1).max(256).nullable().optional(),
    mode: z.literal("form"),
    message: z.string().trim().min(1).max(1_024),
    requestedSchema: codexEmptyMcpElicitationSchema,
    _meta: z.unknown().optional(),
  })
  .strip();

function formatMcpElicitationDecodeError(error: z.ZodError): string {
  const details = error.issues
    .slice(0, 4)
    .map((issue) => {
      const path = issue.path.length === 0 ? "params" : issue.path.join(".");
      const problem =
        issue.code === "unrecognized_keys"
          ? "unsupported fields"
          : issue.code === "invalid_value"
            ? "unsupported value"
            : issue.code === "too_big"
              ? "exceeds supported limit"
              : "invalid shape";
      return `${path}: ${problem}`;
    })
    .join("; ");
  return `Unsupported MCP form elicitation: ${details}`.slice(0, 512);
}

const MCP_ELICITATION_QUESTION_ID = "mcp-form-confirmation";
const MCP_ELICITATION_ACCEPT_VALUE = "accept";
const MCP_ELICITATION_ACCEPT_FOR_SESSION_VALUE = "accept_for_session";
const MCP_ELICITATION_DECLINE_VALUE = "decline";

function supportsMcpSessionPersistence(metadata: unknown): boolean {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    !("persist" in metadata)
  ) {
    return false;
  }
  const persist = metadata.persist;
  if (persist === "session") {
    return true;
  }
  return (
    Array.isArray(persist) &&
    persist.length <= 16 &&
    persist.every((value) => typeof value === "string") &&
    persist.includes("session")
  );
}

function assertNever(value: never): never {
  throw new ProviderResponseEncodeError(`Unexpected value: ${String(value)}`);
}

function requireGrantedPermissions(
  args: Extract<
    ApprovalInteractionOutcome["resolution"],
    { decision: "allow_once" | "allow_for_session" }
  >,
) {
  if (args.grantedPermissions === null) {
    throw new ProviderResponseEncodeError(
      "Permission grant approval must include granted permissions",
    );
  }
  return args.grantedPermissions;
}

function hasGrantablePermissions(
  permissions: PendingInteractionGrantablePermissionProfile | null,
): boolean {
  const fileSystem = permissions?.fileSystem ?? null;
  return (
    permissions?.network?.enabled === true ||
    (fileSystem !== null &&
      (fileSystem.read.length > 0 || fileSystem.write.length > 0))
  );
}

function filterSessionDecisionWithoutGrant(
  decisions: PendingInteractionApprovalDecision[],
  sessionGrant: PendingInteractionGrantablePermissionProfile | null,
): PendingInteractionApprovalDecision[] {
  if (hasGrantablePermissions(sessionGrant)) {
    return decisions;
  }

  const filtered = decisions.filter(
    (decision) => decision !== "allow_for_session",
  );
  if (filtered.length === 0) {
    throw new ProviderRequestDecodeErrorValue(
      "Approval request did not include decisions compatible with the requested permissions",
    );
  }
  return filtered;
}

export function decodeCodexInteractiveRequest(
  request: ProviderInboundRequest,
): DecodedInteractiveRequest | null {
  if (typeof request.id !== "string" && typeof request.id !== "number") {
    return null;
  }

  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const parsed = codexCommandExecutionRequestApprovalParamsSchema.safeParse(
        request.params,
      );
      if (!parsed.success) {
        return null;
      }
      const availableDecisions = parseCodexAvailableDecisions(
        parsed.data.availableDecisions,
      );
      if (!parsed.data.command) {
        throw new ProviderRequestDecodeErrorValue(
          "Command approval request did not include a command subject",
        );
      }
      const sessionGrant = parsed.data.additionalPermissions
        ? toPendingInteractionGrantablePermissionProfile(
            parsed.data.additionalPermissions,
          )
        : null;
      return {
        requestId: request.id,
        method: request.method,
        providerThreadId: parsed.data.threadId,
        turnId: parsed.data.turnId,
        payload: {
          kind: "approval",
          subject: {
            kind: "command",
            itemId: parsed.data.itemId,
            command: parsed.data.command,
            cwd: parsed.data.cwd ?? null,
            actions: parsed.data.commandActions ?? [],
            sessionGrant: hasGrantablePermissions(sessionGrant)
              ? sessionGrant
              : null,
          },
          reason: parsed.data.reason ?? null,
          availableDecisions: filterSessionDecisionWithoutGrant(
            availableDecisions,
            sessionGrant,
          ),
        },
      };
    }
    case "item/fileChange/requestApproval": {
      const parsed = codexFileChangeRequestApprovalParamsSchema.safeParse(
        request.params,
      );
      if (!parsed.success) {
        return null;
      }
      const sessionGrant: PendingInteractionGrantablePermissionProfile | null =
        parsed.data.grantRoot
          ? {
              network: null,
              fileSystem: {
                read: [],
                write: [parsed.data.grantRoot],
              },
            }
          : null;
      return {
        requestId: request.id,
        method: request.method,
        providerThreadId: parsed.data.threadId,
        turnId: parsed.data.turnId,
        payload: {
          kind: "approval",
          subject: {
            kind: "file_change",
            itemId: parsed.data.itemId,
            writeScope: parsed.data.grantRoot ?? null,
            sessionGrant,
          },
          reason: parsed.data.reason ?? null,
          availableDecisions: filterSessionDecisionWithoutGrant(
            ["allow_once", "allow_for_session", "deny"],
            sessionGrant,
          ),
        },
      };
    }
    case "item/permissions/requestApproval": {
      const parsed = codexPermissionsRequestApprovalParamsSchema.safeParse(
        request.params,
      );
      if (!parsed.success) {
        return null;
      }
      const permissions = toPendingInteractionGrantablePermissionProfile(
        parsed.data.permissions,
      );
      return {
        requestId: request.id,
        method: request.method,
        providerThreadId: parsed.data.threadId,
        turnId: parsed.data.turnId,
        payload: {
          kind: "approval",
          subject: {
            kind: "permission_grant",
            itemId: parsed.data.itemId,
            toolName: null,
            permissions,
          },
          reason: parsed.data.reason,
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
      };
    }
    case CODEX_MCP_SERVER_ELICITATION_REQUEST_METHOD: {
      const parsed = codexEmptyFormElicitationParamsSchema.safeParse(
        request.params,
      );
      if (!parsed.success) {
        throw new ProviderRequestDecodeErrorValue(
          formatMcpElicitationDecodeError(parsed.error),
        );
      }
      const options = [
        { value: MCP_ELICITATION_ACCEPT_VALUE, label: "Accept" },
        ...(supportsMcpSessionPersistence(parsed.data._meta)
          ? [
              {
                value: MCP_ELICITATION_ACCEPT_FOR_SESSION_VALUE,
                label: "Allow for this session",
              },
            ]
          : []),
        { value: MCP_ELICITATION_DECLINE_VALUE, label: "Decline" },
        { value: "cancel", label: "Cancel" },
      ];
      return {
        requestId: request.id,
        method: request.method,
        providerThreadId: parsed.data.threadId,
        turnId: parsed.data.turnId ?? null,
        payload: {
          kind: "user_question",
          questions: [
            {
              id: MCP_ELICITATION_QUESTION_ID,
              prompt: parsed.data.message,
              shortLabel: parsed.data.serverName,
              multiSelect: false,
              options,
              allowFreeText: false,
            },
          ],
        },
      };
    }
    default:
      return null;
  }
}

export function buildCodexInteractiveResponse(
  args: ProviderInteractionOutcome,
): CodexInteractiveResponse {
  if (!isApprovalInteractionOutcome(args)) {
    if (args.payload.kind !== "user_question") {
      throw new ProviderResponseEncodeError(
        "Codex plugin interactions cannot be encoded as app-server responses",
      );
    }
    const question = args.payload.questions[0];
    if (
      args.payload.questions.length !== 1 ||
      question?.id !== MCP_ELICITATION_QUESTION_ID
    ) {
      throw new ProviderResponseEncodeError(
        "MCP form elicitation response did not match its confirmation question",
      );
    }
    const answer = args.resolution.answers[MCP_ELICITATION_QUESTION_ID];
    if (
      Object.keys(args.resolution.answers).length !== 1 ||
      answer === undefined ||
      answer.freeText !== undefined ||
      answer.selected.length !== 1
    ) {
      throw new ProviderResponseEncodeError(
        "MCP form elicitation requires exactly one supported response",
      );
    }
    switch (answer.selected[0]) {
      case MCP_ELICITATION_ACCEPT_VALUE:
        return { action: "accept", content: {} };
      case MCP_ELICITATION_ACCEPT_FOR_SESSION_VALUE:
        if (
          !question.options.some(
            (option) =>
              option.value === MCP_ELICITATION_ACCEPT_FOR_SESSION_VALUE,
          )
        ) {
          throw new ProviderResponseEncodeError(
            "MCP form elicitation response used an unavailable session option",
          );
        }
        return {
          action: "accept",
          content: null,
          _meta: { persist: "session" },
        };
      case MCP_ELICITATION_DECLINE_VALUE:
        return { action: "decline", content: null };
      case "cancel":
        return { action: "cancel", content: null };
      default:
        throw new ProviderResponseEncodeError(
          "MCP form elicitation response used an unsupported option",
        );
    }
  }

  switch (args.payload.subject.kind) {
    case "command": {
      const response: CommandExecutionRequestApprovalResponse = {
        decision: toCodexCommandApprovalDecision(args.resolution.decision),
      };
      return response;
    }
    case "file_change": {
      const response: FileChangeRequestApprovalResponse = {
        decision:
          pendingInteractionToCodexFileChangeApprovalDecision[
            args.resolution.decision
          ],
      };
      return response;
    }
    case "permission_grant": {
      if (args.resolution.decision === "deny") {
        const response: PermissionsRequestApprovalResponse = {
          permissions: {},
          scope: "turn",
        };
        return response;
      }
      const response: PermissionsRequestApprovalResponse = {
        permissions: toCodexGrantedPermissionProfile(
          requireGrantedPermissions(args.resolution),
        ),
        scope:
          args.resolution.decision === "allow_for_session" ? "session" : "turn",
      };
      return response;
    }
    case "plan":
      throw new ProviderResponseEncodeError(
        "Codex plan-review interactive requests are unsupported",
      );
    case "tool_use":
      throw new ProviderResponseEncodeError(
        "tool_use approval subjects are not produced by the Codex bridge",
      );
    default:
      return assertNever(args.payload.subject);
  }
}

export function buildCodexMcpElicitationCancellationResponse(): CodexMcpElicitationResponse {
  return { action: "cancel", content: null };
}

const codexToPendingInteractionApprovalDecision = {
  accept: "allow_once",
  acceptForSession: "allow_for_session",
  decline: "deny",
  cancel: "deny",
} satisfies Record<
  CodexSimpleCommandApprovalDecision,
  PendingInteractionApprovalDecision
>;

const pendingInteractionToCodexSimpleApprovalDecision = {
  allow_once: "accept",
  allow_for_session: "acceptForSession",
  deny: "decline",
} satisfies Record<
  PendingInteractionApprovalDecision,
  Exclude<CodexSimpleCommandApprovalDecision, "cancel">
>;

const pendingInteractionToCodexFileChangeApprovalDecision = {
  allow_once: "accept",
  allow_for_session: "acceptForSession",
  deny: "decline",
} satisfies Record<
  PendingInteractionApprovalDecision,
  FileChangeRequestApprovalResponse["decision"]
>;

function toPendingInteractionPermissionProfile(
  permissions: CodexAdditionalPermissions | CodexRequestedPermissionProfile,
): PendingInteractionRequestedPermissionProfile {
  return normalizePendingInteractionRequestedPermissionProfile({
    network: permissions.network
      ? { enabled: permissions.network.enabled }
      : null,
    fileSystem: permissions.fileSystem
      ? {
          read: permissions.fileSystem.read ?? [],
          write: permissions.fileSystem.write ?? [],
        }
      : null,
    macos:
      "macos" in permissions && permissions.macos
        ? {
            preferences: permissions.macos.preferences,
            automations: permissions.macos.automations,
            launchServices: permissions.macos.launchServices,
            accessibility: permissions.macos.accessibility,
            calendar: permissions.macos.calendar,
            reminders: permissions.macos.reminders,
            contacts: permissions.macos.contacts,
          }
        : null,
  });
}

function toPendingInteractionGrantablePermissionProfile(
  permissions: CodexAdditionalPermissions | CodexRequestedPermissionProfile,
): PendingInteractionGrantablePermissionProfile {
  const normalized = toPendingInteractionPermissionProfile(permissions);
  return {
    network: normalized.network,
    fileSystem: normalized.fileSystem,
  };
}

export interface CodexMacOsPermissionRequest {
  providerThreadId: string;
  turnId: string;
  item: CodexMacOsPermissionItem;
}

export function extractCodexMacOsPermissionRequest(
  request: ProviderInboundRequest,
): CodexMacOsPermissionRequest | null {
  if (request.method !== "item/commandExecution/requestApproval") {
    return null;
  }
  const parsed = codexCommandExecutionRequestApprovalParamsSchema.safeParse(
    request.params,
  );
  if (!parsed.success) {
    return null;
  }
  const macos = parsed.data.additionalPermissions?.macos;
  if (macos === null || macos === undefined) {
    return null;
  }
  return {
    providerThreadId: parsed.data.threadId,
    turnId: parsed.data.turnId,
    item: {
      approvalItemId: parsed.data.itemId,
      reason: parsed.data.reason ?? null,
      permissions: macos,
    },
  };
}

function toCodexGrantedPermissionProfile(
  args: PendingInteractionGrantedPermissionProfile,
): PermissionsRequestApprovalResponse["permissions"] {
  return {
    ...(args.network ? { network: { enabled: args.network.enabled } } : {}),
    ...(args.fileSystem
      ? {
          fileSystem: {
            read: args.fileSystem.read.length > 0 ? args.fileSystem.read : null,
            write:
              args.fileSystem.write.length > 0 ? args.fileSystem.write : null,
          },
        }
      : {}),
  };
}

function fromCodexCommandApprovalDecision(
  decision: CodexSimpleCommandApprovalDecision,
): PendingInteractionApprovalDecision {
  return codexToPendingInteractionApprovalDecision[decision];
}

type CodexPolicyAmendmentDecision = Extract<
  CodexCommandApprovalDecision,
  object
>;

function isCodexPolicyAmendmentDecision(
  decision: CodexCommandApprovalDecision,
): decision is CodexPolicyAmendmentDecision {
  return (
    typeof decision === "object" &&
    decision !== null &&
    ("acceptWithExecpolicyAmendment" in decision ||
      "applyNetworkPolicyAmendment" in decision)
  );
}

function toCodexCommandApprovalDecision(
  decision: PendingInteractionApprovalDecision,
): CommandExecutionRequestApprovalResponse["decision"] {
  return pendingInteractionToCodexSimpleApprovalDecision[decision];
}

function parseCodexAvailableDecisions(
  decisions: CodexCommandApprovalDecision[] | null | undefined,
): PendingInteractionApprovalDecision[] {
  if (!decisions) {
    return ["allow_once", "allow_for_session", "deny"];
  }
  if (decisions.length === 0) {
    throw new ProviderRequestDecodeErrorValue(
      "Command approval requests must include at least one available decision",
    );
  }

  const mappedDecisions: PendingInteractionApprovalDecision[] = [];
  for (const decision of decisions) {
    if (isCodexPolicyAmendmentDecision(decision)) {
      continue;
    }
    mappedDecisions.push(fromCodexCommandApprovalDecision(decision));
  }
  const uniqueDecisions = [...new Set(mappedDecisions)];
  if (uniqueDecisions.length === 0) {
    throw new ProviderRequestDecodeErrorValue(
      "Command approval request did not include provider-neutral decisions",
    );
  }
  return uniqueDecisions;
}
