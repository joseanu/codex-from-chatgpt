import { randomUUID } from "node:crypto";

import type { CommandExecutionApprovalDecision } from "../protocol/codex-0.147.0-ts/v2/CommandExecutionApprovalDecision.js";
import type { FileChangeApprovalDecision } from "../protocol/codex-0.147.0-ts/v2/FileChangeApprovalDecision.js";
import type { PermissionsRequestApprovalResponse } from "../protocol/codex-0.147.0-ts/v2/PermissionsRequestApprovalResponse.js";
import type { ReviewDecision } from "../protocol/codex-0.147.0-ts/ReviewDecision.js";
import type { ThreadStartParams } from "../protocol/codex-0.147.0-ts/v2/ThreadStartParams.js";
import type { TurnStartParams } from "../protocol/codex-0.147.0-ts/v2/TurnStartParams.js";

import { AppServerError, type AppServerClient, type AppServerMessage, type JsonObject, type JsonRpcId } from "./codex-app-server.js";
import { StateStore, type PersistedJob, type PersistedValidation } from "./store.js";
import { resolveWorkspace } from "./workspaces.js";

export type JobStatus =
  | "starting"
  | "running"
  | "awaiting_approval"
  | "interrupting"
  | "completed"
  | "interrupted"
  | "failed"
  | "recovery_required";

export type ApprovalDecision =
  | CommandExecutionApprovalDecision
  | FileChangeApprovalDecision
  | PermissionsRequestApprovalResponse
  | ReviewDecision;

type ApprovalKind = "command_execution" | "file_change" | "permissions";

type PendingApproval = {
  requestId: JsonRpcId;
  kind: ApprovalKind;
  method: string;
  threadId: string;
  turnId: string;
  itemId: string;
  params: JsonObject;
};

type JobRecord = {
  jobId: string;
  threadId: string | null;
  workspace: string;
  turnId: string | null;
  status: JobStatus;
  finalMessage: string | null;
  latestDiff: string | null;
  filesChanged: string[];
  commandsExecuted: string[];
  error: string | null;
  pendingApprovals: Map<string, PendingApproval>;
  lastAgentMessage: string | null;
  agentMessages: Map<string, { text: string; phase: string | null }>;
  revision: number;
  activity: string | null;
  validation: ValidationEvidence[];
  warnings: string[];
  completionReportInjected: boolean;
  revisionFingerprint: string;
  updatedAt: string;
};

export type JobDetail = "compact" | "standard" | "debug";

export type ValidationKind = "test" | "typecheck" | "build" | "lint" | "diff_check" | "http_check";

export type ValidationStatus = "passed" | "failed" | "completed" | "in_progress" | "declined";

export type ValidationEvidence = {
  kind: ValidationKind;
  command: string;
  status: ValidationStatus;
  exit_code?: number;
  output_tail?: string;
};

export type DiffStat = {
  files: number;
  insertions: number;
  deletions: number;
};

export type PendingApprovalSummary = {
  request_id: JsonRpcId;
  kind: ApprovalKind;
  summary: string;
  decision_values: string[];
};

type TurnCapture = {
  jobId: string;
  threadId: string;
  turnId: string | null;
  buffered: AppServerMessage[];
};

export type PendingApprovalView = {
  request_id: JsonRpcId;
  kind: ApprovalKind;
  method: string;
  thread_id?: string;
  turn_id?: string;
  item_id?: string;
  command?: string;
  cwd?: string;
  reason?: string;
  grant_root?: string;
  permissions?: unknown;
  decision_values: string[];
};

export type JobSnapshot = {
  status: JobStatus;
  revision: number;
  unchanged?: true;
  job_id?: string;
  thread_id?: string;
  turn_id?: string;
  activity?: string;
  final_message?: string;
  final_message_truncated?: true;
  latest_diff?: string;
  latest_diff_truncated?: true;
  files_changed?: string[];
  files_changed_truncated?: true;
  commands_executed?: string[];
  commands_truncated?: true;
  error?: string;
  warnings?: string[];
  diffstat?: DiffStat;
  validation?: ValidationEvidence[];
  validation_truncated?: true;
  pending_approval?: PendingApprovalView | PendingApprovalSummary;
  pending_approvals?: Array<PendingApprovalView | PendingApprovalSummary>;
  pending_approvals_truncated?: true;
  error_truncated?: true;
};

export type JobStartResult = Pick<JobSnapshot, "job_id" | "thread_id" | "turn_id" | "status" | "revision">;

export type JobGetOptions = {
  detail?: JobDetail;
  since_revision?: number;
};

export type JobManagerOptions = {
  store?: StateStore;
  model?: string;
  reasoningEffort?: string;
};

export const COMPLETION_REPORT_MARKER = "[codex-from-chatgpt internal completion handoff]";

const COMPLETION_REPORT_INSTRUCTION = `${COMPLETION_REPORT_MARKER}
This is an internal handoff requirement, not a change to the caller's task. Preserve the caller's instruction and, when this turn is complete, make the final response concise while stating: actions taken, files changed, validation performed and results, and unresolved warnings or limitations. This requirement applies to this thread's future turns too.`;

const MAX_STANDARD_TEXT = 24_000;
const MAX_DEBUG_TEXT = 20_000;
const MAX_DEBUG_LIST = 100;
const MAX_STANDARD_FILES = 200;
const MAX_STANDARD_VALIDATION = 100;
const MAX_WARNING_TEXT = 600;
const MAX_ERROR_TEXT = 4_000;
const MAX_APPROVAL_SUMMARY = 320;
const MAX_ACTIVITY_TEXT = 240;

function truncateText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 18))}… [truncated]`;
}

function boundedList<T>(values: T[], limit: number): { values: T[]; truncated: boolean } {
  return values.length <= limit
    ? { values: [...values], truncated: false }
    : { values: [...values.slice(0, limit)], truncated: true };
}

function validationKinds(command: string): ValidationKind[] {
  const value = command.trim().toLowerCase();
  const kinds: ValidationKind[] = [];
  const add = (kind: ValidationKind, condition: boolean): void => { if (condition && !kinds.includes(kind)) kinds.push(kind); };
  const packageRunner = "(?:npm|pnpm|yarn|bun)\\s+(?:(?:run|exec)\\s+)?";
  add("test", new RegExp(`(?:^|[;&|]\\s*)${packageRunner}test\\b|(?:^|[;&|]\\s*)(?:pytest|cargo\\s+test|go\\s+test|mvn\\s+test|gradle\\s+test)\\b`).test(value));
  add("typecheck", new RegExp(`(?:^|[;&|]\\s*)${packageRunner}(?:typecheck|type-check|check:types)\\b|(?:^|[;&|]\\s*)tsc\\b[\\s\\S]*--noEmit\\b`).test(value));
  add("build", new RegExp(`(?:^|[;&|]\\s*)${packageRunner}(?:build|compile)\\b|(?:^|[;&|]\\s*)tsc\\b[\\s\\S]*-p\\b`).test(value));
  add("lint", new RegExp(`(?:^|[;&|]\\s*)${packageRunner}lint\\b|(?:^|[;&|]\\s*)(?:eslint|biome\\s+check|ruff\\s+check)\\b`).test(value));
  add("diff_check", /(?:^|[;&|]\s*)git\s+diff\s+--check\b/.test(value));
  add("http_check", /(?:^|[;&|]\s*)(?:curl|wget)\b[\s\S]*https?:\/\//.test(value));
  return kinds;
}

function validationStatus(status: string | null, exitCode: number | null): ValidationStatus {
  if (status === "inProgress") return "in_progress";
  if (status === "declined") return "declined";
  if (status === "failed" || exitCode !== null && exitCode !== 0) return "failed";
  if (status === "completed" && exitCode === 0) return "passed";
  return "completed";
}

function validationActivity(command: string, status: string | null, exitCode: number | null): string {
  const kind = validationKinds(command)[0];
  if (!kind) return "Codex is working";
  const label = {
    test: "tests",
    typecheck: "typecheck",
    build: "build",
    lint: "lint",
    diff_check: "diff",
    http_check: "HTTP endpoint",
  }[kind];
  const outcome = validationStatus(status, exitCode);
  if (outcome === "in_progress") {
    if (kind === "diff_check") return "Checking diff";
    if (kind === "http_check") return "Checking HTTP endpoint";
    return `Running ${label}`;
  }
  if (outcome === "failed") return `${label[0]?.toUpperCase() ?? "V"}${label.slice(1)} failed`;
  if (outcome === "declined") return `${label[0]?.toUpperCase() ?? "V"}${label.slice(1)} declined`;
  return `${label[0]?.toUpperCase() ?? "V"}${label.slice(1)} completed`;
}

function isValidationKind(value: string): value is ValidationKind {
  return value === "test" || value === "typecheck" || value === "build" || value === "lint" || value === "diff_check" || value === "http_check";
}

function isValidationStatus(value: string): value is ValidationStatus {
  return value === "passed" || value === "failed" || value === "completed" || value === "in_progress" || value === "declined";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function outputTail(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return truncateText(value.slice(-MAX_WARNING_TEXT), MAX_WARNING_TEXT);
}

function itemActivity(item: JsonObject): string | null {
  switch (item.type) {
    case "commandExecution": {
      const command = stringValue(item.command);
      if (!command) return "Codex is working";
      return validationActivity(command, stringValue(item.status), numberValue(item.exitCode));
    }
    case "fileChange": return stringValue(item.status) === "inProgress" ? "Applying file changes" : "File changes applied";
    case "agentMessage": return "Codex is composing a response";
    case "reasoning": return "Codex is reasoning";
    case "plan": return "Codex is updating the plan";
    case "mcpToolCall": {
      const server = stringValue(item.server);
      const tool = stringValue(item.tool);
      return server && tool ? truncateText(`Calling MCP tool: ${server}/${tool}`, MAX_ACTIVITY_TEXT) : "Calling an MCP tool";
    }
    default: return null;
  }
}

function approvalSummary(approval: PendingApproval): string {
  const params = approval.params;
  const command = typeof params.command === "string"
    ? params.command
    : Array.isArray(params.command) && params.command.every((entry) => typeof entry === "string")
      ? params.command.join(" ")
      : null;
  if (command) return truncateText(`Approve command: ${command}`, MAX_APPROVAL_SUMMARY);
  const reason = stringValue(params.reason);
  if (reason) return truncateText(reason, MAX_APPROVAL_SUMMARY);
  const grantRoot = stringValue(params.grantRoot);
  if (grantRoot) return truncateText(`Approve access to ${grantRoot}`, MAX_APPROVAL_SUMMARY);
  if (approval.kind === "file_change") return "Approve file changes";
  if (approval.kind === "permissions") return "Approve additional permissions";
  return "Approve command execution";
}

function formatWarning(params: JsonObject | null): string | null {
  if (!params) return null;
  const direct = params.warning ?? params.message ?? params.detail;
  if (typeof direct === "string") return truncateText(direct, MAX_WARNING_TEXT);
  if (direct !== undefined) return truncateText(formatProtocolError(direct, "Codex emitted a warning."), MAX_WARNING_TEXT);
  return null;
}

function boundedUnknown(value: unknown, limit: number): unknown {
  if (typeof value === "string") return truncateText(value, limit);
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized.length > limit ? truncateText(serialized, limit) : value;
  } catch {
    return "[unserializable value]";
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function formatProtocolError(value: unknown, fallback = "Error de app-server."): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    if (isObject(value) && typeof value.message === "string") return `${value.message} | ${serialized}`;
    return serialized ?? fallback;
  } catch {
    return fallback;
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppServerError(`app-server devolvió una respuesta inválida: falta ${label}.`);
  }
  return value;
}

function paramsForMessage(message: AppServerMessage): JsonObject | null {
  return isObject(message.params) ? message.params : null;
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function commonDecision(value: unknown): value is FileChangeApprovalDecision {
  return value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel";
}

function isApprovalDecisionFor(kind: ApprovalKind, value: unknown): value is ApprovalDecision {
  if (kind === "file_change") return commonDecision(value);
  if (kind === "permissions") {
    if (!isObject(value) || !isObject(value.permissions)) return false;
    const permissions = value.permissions;
    if (value.strictAutoReview !== undefined && value.strictAutoReview !== null && typeof value.strictAutoReview !== "boolean") return false;
    const scope = value.scope === undefined ? "turn" : value.scope;
    if (scope !== "turn" && scope !== "session") return false;
    if (permissions.network !== undefined && permissions.network !== null && (!isObject(permissions.network) || permissions.network.enabled !== undefined && typeof permissions.network.enabled !== "boolean" && permissions.network.enabled !== null)) return false;
    if (permissions.fileSystem !== undefined && permissions.fileSystem !== null) {
      const fileSystem = permissions.fileSystem;
      const validPathList = (value: unknown): boolean => value === undefined || value === null || Array.isArray(value) && value.every((entry) => typeof entry === "string");
      if (!isObject(fileSystem) || !validPathList(fileSystem.read) || !validPathList(fileSystem.write)) return false;
      if (fileSystem.globScanMaxDepth !== undefined && fileSystem.globScanMaxDepth !== null && (typeof fileSystem.globScanMaxDepth !== "number" || !Number.isInteger(fileSystem.globScanMaxDepth) || fileSystem.globScanMaxDepth <= 0)) return false;
      if (fileSystem.entries !== undefined && fileSystem.entries !== null && (!Array.isArray(fileSystem.entries) || !fileSystem.entries.every(isFileSystemEntry))) return false;
    }
    return true;
  }
  if (commonDecision(value)) return true;
  if (!isObject(value)) return false;
  const execpolicy = value.acceptWithExecpolicyAmendment;
  if (isObject(execpolicy) && Array.isArray(execpolicy.execpolicy_amendment)) {
    return execpolicy.execpolicy_amendment.every((entry) => typeof entry === "string");
  }
  const network = value.applyNetworkPolicyAmendment;
  if (!isObject(network) || !isObject(network.network_policy_amendment)) return false;
  const amendment = network.network_policy_amendment;
  return typeof amendment.host === "string" && (amendment.action === "allow" || amendment.action === "deny");
}

function isFileSystemEntry(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.path) || (value.access !== "read" && value.access !== "write" && value.access !== "deny")) return false;
  const pathValue = value.path;
  if (pathValue.type === "path") return typeof pathValue.path === "string";
  if (pathValue.type === "glob_pattern") return typeof pathValue.pattern === "string";
  if (pathValue.type !== "special" || !isObject(pathValue.value)) return false;
  const special = pathValue.value;
  if (special.kind === "root" || special.kind === "minimal" || special.kind === "tmpdir" || special.kind === "slash_tmp") return true;
  if (special.kind === "project_roots") return special.subpath === undefined || special.subpath === null || typeof special.subpath === "string";
  return special.kind === "unknown" && typeof special.path === "string" && (special.subpath === undefined || special.subpath === null || typeof special.subpath === "string");
}

function isLegacyApprovalDecision(value: unknown): value is ReviewDecision {
  if (value === "approved" || value === "approved_for_session" || value === "timed_out" || value === "abort") return true;
  if (!isObject(value)) return false;
  if (isObject(value.denied)) return typeof value.denied.rejection === "string";
  if (isObject(value.approved_execpolicy_amendment)) {
    const amendment = value.approved_execpolicy_amendment.proposed_execpolicy_amendment;
    return Array.isArray(amendment) && amendment.every((entry) => typeof entry === "string");
  }
  if (isObject(value.network_policy_amendment)) {
    const amendment = value.network_policy_amendment.network_policy_amendment;
    return isObject(amendment) && typeof amendment.host === "string" && (amendment.action === "allow" || amendment.action === "deny");
  }
  return false;
}

function isTerminal(status: unknown): status is "completed" | "interrupted" | "failed" {
  return status === "completed" || status === "interrupted" || status === "failed";
}

function isActiveStatus(status: JobStatus): boolean {
  return status === "starting" || status === "running" || status === "awaiting_approval" || status === "interrupting";
}

function isAmbiguousThreadStartError(error: unknown): boolean {
  return isObject(error) && error.code === -32002;
}

function messageTurnId(message: AppServerMessage): string | null {
  const params = paramsForMessage(message);
  if (!params) return null;
  const direct = stringValue(params.turnId);
  if (direct) return direct;
  const turn = isObject(params.turn) ? params.turn : null;
  return stringValue(turn?.id);
}

function isTurnScopedMethod(method: string): boolean {
  return method === "turn/started" || method === "turn/completed" || method === "turn/diff/updated" ||
    method.startsWith("item/") || method === "error";
}

function approvalView(approval: PendingApproval): PendingApprovalView {
  const params = approval.params;
  const command = typeof params.command === "string"
    ? params.command
    : Array.isArray(params.command) && params.command.every((entry) => typeof entry === "string")
      ? params.command.join(" ")
      : null;
  const decisionValues = approval.kind === "permissions"
    ? ["permissions"]
    : approval.kind === "file_change"
      ? ["accept", "acceptForSession", "decline", "cancel"]
      : ["accept", "acceptForSession", "acceptWithExecpolicyAmendment", "applyNetworkPolicyAmendment", "decline", "cancel"];
  const view: PendingApprovalView = {
    request_id: approval.requestId,
    kind: approval.kind,
    method: approval.method,
    decision_values: decisionValues,
  };
  if (approval.threadId) view.thread_id = approval.threadId;
  if (approval.turnId) view.turn_id = approval.turnId;
  if (approval.itemId) view.item_id = approval.itemId;
  if (command) view.command = command;
  const cwd = stringValue(params.cwd);
  if (cwd) view.cwd = cwd;
  const reason = stringValue(params.reason);
  if (reason) view.reason = reason;
  const grantRoot = stringValue(params.grantRoot);
  if (grantRoot) view.grant_root = grantRoot;
  if (params.permissions !== undefined && params.permissions !== null) view.permissions = boundedUnknown(params.permissions, MAX_DEBUG_TEXT);
  return view;
}

function approvalSummaryView(approval: PendingApproval): PendingApprovalSummary {
  const decisionValues = approval.kind === "permissions"
    ? ["permissions"]
    : approval.kind === "file_change"
      ? ["accept", "acceptForSession", "decline", "cancel"]
      : ["accept", "acceptForSession", "acceptWithExecpolicyAmendment", "applyNetworkPolicyAmendment", "decline", "cancel"];
  return { request_id: approval.requestId, kind: approval.kind, summary: approvalSummary(approval), decision_values: decisionValues };
}

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly jobsByThread = new Map<string, string>();
  private readonly turnCaptures = new Map<string, TurnCapture>();
  private readonly store: StateStore;
  private readonly model: string | undefined;
  private readonly reasoningEffort: string | undefined;
  private activeJobId: string | null = null;
  private recoveryFence = false;
  private rehydrated = false;
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly appServer: AppServerClient, options: JobManagerOptions = {}) {
    this.store = options.store ?? new StateStore();
    this.model = options.model ?? (process.env.CODEX_AGENT_MODEL?.trim() || undefined);
    this.reasoningEffort = options.reasoningEffort ?? (process.env.CODEX_AGENT_REASONING_EFFORT?.trim() || undefined);
    this.loadPersistedIndex();
    appServer.addMessageListener((message) => this.handleAppServerMessage(message));
    appServer.addExitListener((error) => this.handleAppServerExit(error));
  }

  async initialize(): Promise<void> {
    await this.withExclusive(async () => {
      await this.ensureReady();
    });
  }

  async start(workspace: string, prompt: string): Promise<JobStartResult> {
    const workspaceResolution = await resolveWorkspace(workspace);
    this.validatePrompt(prompt);
    return this.withExclusive(async () => {
      await this.ensureReady();
      this.assertNoActiveTurn();
      const job: JobRecord = {
        jobId: randomUUID(), threadId: null, workspace: workspaceResolution.logical, turnId: null, status: "starting",
        finalMessage: null, latestDiff: null, filesChanged: [], commandsExecuted: [], error: null,
        pendingApprovals: new Map(), lastAgentMessage: null, agentMessages: new Map(), revision: 0,
        activity: "Starting Codex", validation: [], warnings: [], completionReportInjected: false,
        revisionFingerprint: "", updatedAt: new Date().toISOString(),
      };
      this.touch(job);
      this.jobs.set(job.jobId, job);
      this.activeJobId = job.jobId;
      try {
        if (!this.persist(job, true)) throw new Error("No se pudo persistir el job antes de crear el thread.");
        const response = await this.appServer.request<unknown>("thread/start", {
          ...(this.model ? { model: this.model } : {}),
          cwd: workspaceResolution.canonical,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "workspace-write",
        } satisfies ThreadStartParams);
        const thread = isObject(response) && isObject(response.thread) ? response.thread : null;
        const threadId = requiredString(thread?.id, "thread.id");
        this.attachThread(job, threadId);
        this.persist(job, true);
        await this.startTurn(job, prompt);
      } catch (error) {
        if (job.threadId === null && isAmbiguousThreadStartError(error)) {
          this.setRecoveryRequired(job, new Error(`thread/start incierto: el resultado puede haber creado un thread, pero no se adopta automáticamente (${error instanceof Error ? error.message : String(error)}).`));
        } else if (job.status !== "recovery_required") {
          // An explicit RPC rejection is definitive: no usable thread was returned.
          // Only the timeout/ambiguous result above enters recovery_required.
          this.setFailure(job, error, false);
        }
        throw new Error(`${error instanceof Error ? error.message : String(error)} (job_id=${job.jobId})`);
      }
      return this.startResult(job);
    });
  }

  async continue(jobId: string, prompt: string): Promise<JobStartResult> {
    this.validatePrompt(prompt);
    return this.withExclusive(async () => {
      await this.ensureReady();
      const job = this.getJob(jobId);
      this.assertRecoveryFence();
      if (this.activeJobId !== null || isActiveStatus(job.status)) {
        throw new Error("backend ocupado: el job ya tiene un turn activo; usa codex_get o codex_interrupt.");
      }
      if (job.status === "recovery_required") {
        throw new Error("el job requiere reconciliación después de un fallo del app-server.");
      }
      if (job.threadId === null) throw new Error("el job aún no tiene un thread confirmado; requiere reconciliación.");
      this.activeJobId = job.jobId;
      try {
        await this.startTurn(job, prompt);
      } catch (error) {
        this.setFailure(job, error, true);
        throw error;
      }
      return this.startResult(job);
    });
  }

  async interrupt(jobId: string): Promise<JobSnapshot> {
    return this.withExclusive(async () => {
      await this.ensureReady();
      const job = this.getJob(jobId);
      if (!isActiveStatus(job.status) || job.threadId === null || job.turnId === null || this.activeJobId !== job.jobId) {
        throw new Error("el job no tiene un turn activo que interrumpir.");
      }
      try {
        const response = await this.appServer.request<unknown>("turn/interrupt", { threadId: job.threadId, turnId: job.turnId });
        const turn = isObject(response) && isObject(response.turn) ? response.turn : null;
        if (!isTerminal(job.status)) {
          if (turn && isTerminal(turn.status) && stringValue(turn.id) === job.turnId) this.applyTerminalStatus(job, turn.status, turn);
          else if (isActiveStatus(job.status)) {
            job.status = "interrupting";
            job.activity = "Interrupting Codex";
          }
        }
        this.touch(job);
        this.persist(job, true);
        return this.snapshot(job);
      } catch (error) {
        this.setRecoveryRequired(job, error);
        throw error;
      }
    });
  }

  async respondApproval(jobId: string, requestId: JsonRpcId, decision: ApprovalDecision): Promise<JobSnapshot> {
    return this.withExclusive(async () => {
      await this.ensureReady();
      const job = this.getJob(jobId);
      const approval = job.pendingApprovals.get(idKey(requestId));
      if (!approval) throw new Error(`no existe una approval pendiente con request_id=${String(requestId)} para este job.`);
      if (!(approval.method === "applyPatchApproval" || approval.method === "execCommandApproval" ? isLegacyApprovalDecision(decision) : isApprovalDecisionFor(approval.kind, decision))) {
        throw new Error(`decision no admitida para una approval de tipo ${approval.kind}.`);
      }
      const result = approval.kind === "permissions" ? decision : { decision };
      this.appServer.respond(approval.requestId, result);
      job.pendingApprovals.delete(idKey(requestId));
      if (job.status === "awaiting_approval" && job.pendingApprovals.size === 0) {
        job.status = "running";
        job.activity = "Codex is working";
      }
      this.touch(job);
      this.persist(job, true);
      return this.snapshot(job);
    });
  }

  get(jobId: string, options: JobGetOptions = {}): JobSnapshot {
    const job = this.getJob(jobId);
    const detail = options.detail ?? "standard";
    if (detail !== "compact" && detail !== "standard" && detail !== "debug") throw new Error(`detail no admitido: ${String(detail)}.`);
    if (options.since_revision !== undefined && (!Number.isInteger(options.since_revision) || options.since_revision < 0)) {
      throw new Error("since_revision debe ser un entero no negativo.");
    }
    if (options.since_revision !== undefined && options.since_revision > job.revision) {
      throw new Error(`since_revision (${options.since_revision}) no puede ser mayor que la revision actual (${job.revision}).`);
    }
    if (detail !== "debug" && options.since_revision !== undefined && options.since_revision === job.revision) {
      return this.unchangedSnapshot(job);
    }
    if (detail === "compact") return this.compactSnapshot(job);
    if (detail === "debug") return this.debugSnapshot(job);
    return this.standardSnapshot(job);
  }

  private async withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async ensureReady(): Promise<void> {
    await this.appServer.start();
    if (!this.rehydrated || this.recoveryFence) {
      await this.rehydrate();
      this.rehydrated = true;
    }
  }

  private async rehydrate(): Promise<void> {
    const candidates = [...this.jobs.values()].filter((job) => isActiveStatus(job.status) || job.status === "recovery_required");
    this.recoveryFence = candidates.length > 0;
    for (const job of candidates) {
      if (job.threadId === null) {
        this.setRecoveryRequired(job, new Error("thread/start incierto: no existe un thread_id confirmado; reconciliación automática deshabilitada."));
      } else {
        await this.reconcileJob(job, candidates.length === 1 && candidates[0]?.jobId === job.jobId);
      }
    }
    this.recoveryFence = [...this.jobs.values()].some((job) => job.status === "recovery_required");
  }

  private async reconcileJob(job: JobRecord, mayResume: boolean): Promise<void> {
    try {
      const workspaceResolution = await resolveWorkspace(job.workspace);
      job.workspace = workspaceResolution.logical;
      const response = await this.appServer.request<unknown>("thread/read", { threadId: job.threadId, includeTurns: true });
      const thread = isObject(response) && isObject(response.thread) ? response.thread : null;
      if (!thread || stringValue(thread.id) !== job.threadId) throw new Error("thread/read devolvió un thread distinto.");
      const turns = Array.isArray(thread.turns) ? thread.turns.filter(isObject) : [];
      const latest = turns.at(-1);
      if (latest) this.applyStoredTurn(job, latest);
      const latestStatus = stringValue(latest?.status);
      if (latestStatus === "inProgress") {
        if (!mayResume || this.activeJobId !== null && this.activeJobId !== job.jobId) {
          this.setRecoveryRequired(job, new Error("hay más de un turn activo persistido; la política V0.2 permite uno por proceso."));
          return;
        }
        const expectedTurnId = requiredString(latest?.id, "turn.id");
        const resumed = await this.appServer.request<unknown>("thread/resume", { threadId: job.threadId });
        const resumedThread = isObject(resumed) && isObject(resumed.thread) ? resumed.thread : null;
        if (!resumedThread || stringValue(resumedThread.id) !== job.threadId) throw new Error("thread/resume no confirmó el thread.");
        const resumedTurns = Array.isArray(resumedThread.turns) ? resumedThread.turns.filter(isObject) : [];
        const resumedTurn = resumedTurns.find((turn) => stringValue(turn.id) === expectedTurnId);
        if (!resumedTurn || stringValue(resumedTurn.status) !== "inProgress") throw new Error("thread/resume no confirmó el mismo turn inProgress.");
        if (isTerminal(job.status) || job.turnId !== expectedTurnId) return;
        job.status = "running";
        job.turnId = expectedTurnId;
        if (!job.activity) job.activity = "Codex is working";
        this.activeJobId = job.jobId;
      } else if (latest && latestStatus && isTerminal(latestStatus)) {
        this.applyTerminalStatus(job, latestStatus, latest);
      } else if (isActiveStatus(job.status) || job.status === "recovery_required") {
        this.setRecoveryRequired(job, new Error("thread/read no permitió determinar el estado final del turn."));
      }
      this.touch(job);
      this.persist(job);
    } catch (error) {
      this.setRecoveryRequired(job, error);
    }
  }

  private fromPersisted(value: PersistedJob): JobRecord {
    const status: JobStatus = ["starting", "running", "awaiting_approval", "interrupting", "completed", "interrupted", "failed", "recovery_required"].includes(value.status)
      ? value.status as JobStatus
      : "recovery_required";
    const validation = (value.validation ?? []).flatMap((entry): ValidationEvidence[] => {
      if (!isValidationKind(entry.kind) || !isValidationStatus(entry.status)) return [];
      const result: ValidationEvidence = { kind: entry.kind, command: entry.command, status: entry.status };
      if (entry.exit_code !== undefined) result.exit_code = entry.exit_code;
      if (entry.output_tail) result.output_tail = entry.output_tail;
      return [result];
    });
    const job: JobRecord = {
      jobId: value.job_id, threadId: value.thread_id, workspace: value.workspace, turnId: value.turn_id, status,
      finalMessage: value.final_message, latestDiff: value.latest_diff, filesChanged: [...value.files_changed],
      commandsExecuted: [...value.commands_executed], error: value.error, pendingApprovals: new Map(),
      lastAgentMessage: value.final_message, agentMessages: new Map(), revision: value.revision ?? 0,
      activity: value.activity ?? null, validation, warnings: [...(value.warnings ?? [])],
      completionReportInjected: value.completion_report_injected ?? false,
      revisionFingerprint: "", updatedAt: value.updated_at,
    };
    job.revisionFingerprint = this.observableState(job);
    return job;
  }

  private loadPersistedIndex(): void {
    for (const persisted of this.store.load()) {
      const job = this.fromPersisted(persisted);
      this.jobs.set(job.jobId, job);
      if (job.threadId !== null) this.jobsByThread.set(job.threadId, job.jobId);
    }
    if (this.store.getDiagnostic()) console.error(`[Codex Agent] ${this.store.getDiagnostic()}`);
  }

  private attachThread(job: JobRecord, threadId: string): void {
    if (job.threadId !== null && job.threadId !== threadId) this.jobsByThread.delete(job.threadId);
    const existing = this.jobsByThread.get(threadId);
    if (existing && existing !== job.jobId) throw new Error(`state ambiguo: thread_id ya pertenece a otro job (${threadId}).`);
    job.threadId = threadId;
    this.jobsByThread.set(threadId, job.jobId);
    this.touch(job);
  }

  private async startTurn(job: JobRecord, prompt: string): Promise<void> {
    if (job.threadId === null) throw new Error("no hay thread confirmado para iniciar el turn.");
    this.resetTurn(job);
    const turnPrompt = this.promptForTurn(job, prompt);
    const capture: TurnCapture = { jobId: job.jobId, threadId: job.threadId, turnId: null, buffered: [] };
    this.turnCaptures.set(job.threadId, capture);
    const params: TurnStartParams = {
      threadId: job.threadId,
      input: [{ type: "text", text: turnPrompt, text_elements: [] }],
      ...(this.model ? { model: this.model } : {}),
      ...(this.reasoningEffort ? { effort: this.reasoningEffort as TurnStartParams["effort"] } : {}),
    };
    try {
      const response = await this.appServer.request<unknown>("turn/start", params);
      const turn = isObject(response) && isObject(response.turn) ? response.turn : null;
      const turnId = requiredString(turn?.id, "turn.id");
      capture.turnId = turnId;
      job.turnId = turnId;
      for (const message of capture.buffered) {
        const legacyApproval = message.method === "applyPatchApproval" || message.method === "execCommandApproval";
        if (legacyApproval || messageTurnId(message) === turnId) this.handleAppServerMessage(message);
      }
      capture.buffered = [];
      if (isTerminal(turn?.status)) {
        this.applyTerminalStatus(job, turn.status, turn);
      } else if (!isTerminal(job.status)) {
        job.status = job.pendingApprovals.size > 0 ? "awaiting_approval" : "running";
        job.activity = job.pendingApprovals.size > 0 ? "Waiting for approval" : "Codex is working";
      }
      this.touch(job);
      this.persist(job, true);
    } finally {
      this.turnCaptures.delete(job.threadId);
    }
  }

  private resetTurn(job: JobRecord): void {
    job.turnId = null; job.status = "starting"; job.finalMessage = null; job.latestDiff = null;
    job.filesChanged = []; job.commandsExecuted = []; job.error = null; job.pendingApprovals.clear();
    job.lastAgentMessage = null; job.agentMessages.clear(); job.activity = "Starting Codex";
    job.validation = []; job.warnings = []; this.touch(job);
  }

  private promptForTurn(job: JobRecord, prompt: string): string {
    if (job.completionReportInjected || prompt.includes(COMPLETION_REPORT_MARKER)) {
      job.completionReportInjected = true;
      return prompt;
    }
    job.completionReportInjected = true;
    return `${prompt}\n\n${COMPLETION_REPORT_INSTRUCTION}`;
  }

  private handleAppServerMessage(message: AppServerMessage): void {
    const method = message.method;
    if (!method) return;
    const params = paramsForMessage(message);
    const legacy = method === "applyPatchApproval" || method === "execCommandApproval";
    const threadId = stringValue(legacy ? params?.conversationId : params?.threadId);
    if (method === "warning" || method === "guardianWarning" || method === "configWarning") {
      const job = threadId ? this.jobForThread(threadId) : this.activeJobId ? this.jobs.get(this.activeJobId) : undefined;
      const warning = formatWarning(params);
      if (job && warning && !job.warnings.includes(warning) && job.warnings.length < 50) {
        job.warnings.push(warning);
        this.persist(job);
      }
      return;
    }
    const capture = threadId ? this.turnCaptures.get(threadId) : undefined;
    if (capture && capture.turnId === null && (isTurnScopedMethod(method) || method.includes("requestApproval") || method === "applyPatchApproval" || method === "execCommandApproval")) {
      capture.buffered.push(message);
      return;
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval" || method === "item/permissions/requestApproval" || method === "applyPatchApproval" || method === "execCommandApproval") {
      this.handleApprovalRequest(message, method);
      return;
    }
    if (!params || !threadId) return;
    const job = this.jobForThread(threadId);
    if (!job || !this.matchesActiveTurn(job, message)) return;
    switch (method) {
      case "turn/started": {
        const turn = isObject(params.turn) ? params.turn : null;
        if (stringValue(turn?.id) === job.turnId) {
          job.status = job.pendingApprovals.size > 0 ? "awaiting_approval" : "running";
          if (job.pendingApprovals.size === 0) job.activity = "Codex is working";
          this.persist(job);
        }
        break;
      }
      case "turn/completed": {
        const turn = isObject(params.turn) ? params.turn : null;
        if (turn && isTerminal(turn.status) && stringValue(turn.id) === job.turnId) this.applyTerminalStatus(job, turn.status, turn);
        break;
      }
      case "turn/diff/updated":
        if (typeof params.diff === "string" && params.diff !== job.latestDiff) job.latestDiff = params.diff;
        this.persist(job);
        break;
      case "item/agentMessage/delta": this.handleAgentMessageDelta(job, params); break;
      case "item/started":
      case "item/completed": this.handleItem(job, params); break;
      case "error":
        job.error = formatProtocolError(params.error ?? params.message);
        if (messageTurnId(message) === job.turnId) this.setRecoveryRequired(job, new Error(job.error));
        else this.persist(job);
        break;
      default: break;
    }
  }

  private matchesActiveTurn(job: JobRecord, message: AppServerMessage): boolean {
    const turnId = messageTurnId(message);
    return job.turnId !== null && turnId === job.turnId;
  }

  private handleApprovalRequest(
    message: AppServerMessage,
    method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" | "item/permissions/requestApproval" | "applyPatchApproval" | "execCommandApproval",
  ): void {
    if (typeof message.id !== "number" && typeof message.id !== "string") return;
    const params = paramsForMessage(message);
    if (!params) {
      this.appServer.respondError(message.id, -32602, "Approval sin params válidos.");
      return;
    }
    const legacy = method === "applyPatchApproval" || method === "execCommandApproval";
    const threadId = stringValue(legacy ? params.conversationId : params.threadId);
    const job = threadId ? this.jobForThread(threadId) : null;
    const turnId = stringValue(legacy ? job?.turnId : params.turnId);
    const itemId = stringValue(legacy ? params.callId : params.itemId);
    if (!threadId || !job || !isActiveStatus(job.status) || !turnId || !itemId || job.turnId !== turnId) {
      this.appServer.respondError(message.id, -32001, "No existe un job/turn local para esta approval.");
      return;
    }
    const kind: ApprovalKind = method === "item/commandExecution/requestApproval" || method === "execCommandApproval"
      ? "command_execution"
      : method === "item/fileChange/requestApproval" || method === "applyPatchApproval"
        ? "file_change"
        : "permissions";
    job.pendingApprovals.set(idKey(message.id), { requestId: message.id, kind, method, threadId, turnId, itemId, params });
    job.status = "awaiting_approval";
    job.activity = "Waiting for approval";
    this.touch(job);
    this.persist(job);
  }

  private handleAgentMessageDelta(job: JobRecord, params: JsonObject): void {
    const itemId = stringValue(params.itemId); const delta = stringValue(params.delta);
    if (!itemId || delta === null) return;
    const current = job.agentMessages.get(itemId) ?? { text: "", phase: null };
    current.text += delta; job.agentMessages.set(itemId, current); job.lastAgentMessage = current.text;
    if (job.activity !== "Codex is composing a response") {
      job.activity = "Codex is composing a response";
      this.persist(job);
    }
  }

  private handleItem(job: JobRecord, params: JsonObject): void {
    const item = isObject(params.item) ? params.item : null;
    if (item) {
      this.recordItem(job, item);
      const activity = itemActivity(item);
      if (activity) job.activity = activity;
      this.touch(job);
      this.persist(job);
    }
  }

  private applyStoredTurn(job: JobRecord, turn: JsonObject): void {
    const turnId = stringValue(turn.id);
    if (!turnId) return;
    job.turnId = turnId;
    this.recordTurnItems(job, turn);
  }

  private applyTerminalStatus(job: JobRecord, status: "completed" | "interrupted" | "failed", turn: JsonObject): void {
    this.recordTurnItems(job, turn);
    if (status === "completed") {
      job.status = "completed"; job.finalMessage = this.finalMessage(job); job.pendingApprovals.clear(); job.activity = null; this.activeJobId = this.activeJobId === job.jobId ? null : this.activeJobId;
    } else if (status === "interrupted") {
      job.status = "interrupted"; job.finalMessage = null; job.pendingApprovals.clear(); job.activity = null; this.activeJobId = this.activeJobId === job.jobId ? null : this.activeJobId;
    } else {
      job.status = "failed"; job.error = formatProtocolError(turn.error, "El turn falló."); job.pendingApprovals.clear(); job.activity = null; this.activeJobId = this.activeJobId === job.jobId ? null : this.activeJobId;
    }
    this.touch(job); this.persist(job);
  }

  private recordTurnItems(job: JobRecord, turn: JsonObject): void {
    if (Array.isArray(turn.items)) for (const item of turn.items) if (isObject(item)) this.recordItem(job, item);
  }

  private recordItem(job: JobRecord, item: JsonObject): void {
    if (item.type === "agentMessage") {
      const id = stringValue(item.id); const text = stringValue(item.text);
      if (!id || text === null) return;
      const phase = stringValue(item.phase); job.agentMessages.set(id, { text, phase }); job.lastAgentMessage = text;
      if (phase === "final_answer") job.finalMessage = text;
    } else if (item.type === "commandExecution") {
      const command = stringValue(item.command); const status = stringValue(item.status);
      if (!command) return;
      if (status === "completed" || status === "failed") {
        if (!job.commandsExecuted.includes(command)) job.commandsExecuted.push(command);
      }
      const exitCode = numberValue(item.exitCode);
      this.recordValidation(job, command, status, exitCode, item.aggregatedOutput);
    } else if (item.type === "fileChange" && Array.isArray(item.changes)) {
      for (const change of item.changes) if (isObject(change)) { const filePath = stringValue(change.path); if (filePath && !job.filesChanged.includes(filePath)) job.filesChanged.push(filePath); }
    }
  }

  private recordValidation(job: JobRecord, command: string, status: string | null, exitCode: number | null, aggregatedOutput: unknown): void {
    const kinds = validationKinds(command);
    if (kinds.length === 0) return;
    const nextStatus = validationStatus(status, exitCode);
    for (const kind of kinds) {
      const next: ValidationEvidence = { kind, command: truncateText(command, MAX_DEBUG_TEXT), status: nextStatus };
      if (exitCode !== null) next.exit_code = exitCode;
      if (nextStatus === "failed") {
        const tail = outputTail(aggregatedOutput);
        if (tail) next.output_tail = tail;
      }
      const existing = [...job.validation].reverse().findIndex((entry) => entry.kind === kind && entry.command === next.command && entry.status === "in_progress");
      if (existing >= 0) {
        const index = job.validation.length - existing - 1;
        job.validation[index] = next;
      } else {
        const last = job.validation.at(-1);
        if (!last || last.kind !== next.kind || last.command !== next.command || last.status !== next.status || last.exit_code !== next.exit_code) job.validation.push(next);
      }
    }
  }

  private finalMessage(job: JobRecord): string | null {
    for (const message of job.agentMessages.values()) if (message.phase === "final_answer") return message.text;
    return job.finalMessage ?? job.lastAgentMessage;
  }

  private handleAppServerExit(error: Error): void {
    this.rehydrated = false;
    this.recoveryFence = true;
    this.activeJobId = null;
    for (const job of this.jobs.values()) {
      if (isActiveStatus(job.status)) this.setRecoveryRequired(job, error);
    }
  }

  private setFailure(job: JobRecord, error: unknown, uncertain: boolean): void {
    if (uncertain || error instanceof AppServerError && error.code === -32002) this.setRecoveryRequired(job, error);
    else { job.status = "failed"; job.error = error instanceof Error ? error.message : String(error); job.activity = null; this.activeJobId = this.activeJobId === job.jobId ? null : this.activeJobId; this.touch(job); this.persist(job); }
  }

  private setRecoveryRequired(job: JobRecord, error: unknown): void {
    this.rehydrated = false;
    this.recoveryFence = true;
    job.status = "recovery_required"; job.error = error instanceof Error ? error.message : String(error); job.pendingApprovals.clear(); job.activity = null; this.activeJobId = this.activeJobId === job.jobId ? null : this.activeJobId; this.touch(job); this.persist(job);
  }

  private observableState(job: JobRecord): string {
    // Keep this fingerprint limited to supervisory/control-plane state. Raw
    // command history and raw diffs remain available to detail=debug, but
    // exploratory diagnostics must not invalidate compact polling revisions.
    return JSON.stringify({
      threadId: job.threadId,
      turnId: job.turnId,
      status: job.status,
      finalMessage: job.finalMessage,
      filesChanged: job.filesChanged,
      error: job.error,
      activity: job.activity,
      validation: job.validation,
      warnings: job.warnings,
      approvals: [...job.pendingApprovals.values()].map((approval) => ({
        requestId: approval.requestId,
        kind: approval.kind,
        threadId: approval.threadId,
        turnId: approval.turnId,
        itemId: approval.itemId,
        summary: approvalSummary(approval),
      })),
    });
  }

  private touch(job: JobRecord): void {
    const fingerprint = this.observableState(job);
    if (fingerprint !== job.revisionFingerprint) {
      job.revision += 1;
      job.revisionFingerprint = fingerprint;
    }
    job.updatedAt = new Date().toISOString();
  }

  private persist(_job: JobRecord, required = false): boolean {
    for (const job of this.jobs.values()) this.touch(job);
    const values: PersistedJob[] = [...this.jobs.values()].map((job) => ({
      job_id: job.jobId, thread_id: job.threadId, workspace: job.workspace, turn_id: job.turnId, status: job.status,
      final_message: job.finalMessage, latest_diff: job.latestDiff, files_changed: [...job.filesChanged], commands_executed: [...job.commandsExecuted], error: job.error, updated_at: job.updatedAt,
      revision: job.revision,
      validation: job.validation.map((entry): PersistedValidation => ({
        kind: entry.kind, command: entry.command, status: entry.status,
        ...(entry.exit_code === undefined ? {} : { exit_code: entry.exit_code }),
        ...(entry.output_tail === undefined ? {} : { output_tail: entry.output_tail }),
      })),
      warnings: [...job.warnings], activity: job.activity, completion_report_injected: job.completionReportInjected,
    }));
    try {
      this.store.save(values);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Codex Agent] persistencia local no disponible: ${message}`);
      for (const job of this.jobs.values()) {
        if (isActiveStatus(job.status)) {
          this.recoveryFence = true;
          job.status = "recovery_required";
          job.error = `No se pudo persistir el estado local: ${message}`;
          job.pendingApprovals.clear();
          job.activity = null;
          if (this.activeJobId === job.jobId) this.activeJobId = null;
          this.touch(job);
        }
      }
      if (required) throw new Error(`No se pudo persistir el estado local: ${message}`);
      return false;
    }
  }

  private startResult(job: JobRecord): JobStartResult { return { job_id: job.jobId, thread_id: job.threadId ?? undefined, turn_id: job.turnId ?? undefined, status: job.status, revision: job.revision }; }
  private validatePrompt(prompt: string): void { if (typeof prompt !== "string" || prompt.trim().length === 0) throw new Error("prompt no puede estar vacío."); }
  private assertNoActiveTurn(): void {
    this.assertRecoveryFence();
    if (this.activeJobId !== null) throw new Error("backend ocupado: ya existe un turn activo; usa codex_get o codex_interrupt.");
  }
  private assertRecoveryFence(): void {
    if (this.recoveryFence) throw new Error("backend bloqueado: existe un job en recovery_required sin reconciliación concluyente; usa codex_get mientras se recupera el app-server.");
  }
  private jobForThread(threadId: string): JobRecord | null { const jobId = this.jobsByThread.get(threadId); return jobId ? this.jobs.get(jobId) ?? null : null; }
  private getJob(jobId: string): JobRecord { const job = this.jobs.get(jobId); if (!job) throw new Error(`job_id desconocido: ${jobId}`); return job; }

  private snapshot(job: JobRecord): JobSnapshot {
    return this.standardSnapshot(job);
  }

  private unchangedSnapshot(job: JobRecord): JobSnapshot {
    const result: JobSnapshot = { status: job.status, revision: job.revision, unchanged: true };
    const approvals = [...job.pendingApprovals.values()].map(approvalSummaryView);
    if (approvals.length > 0) {
      result.pending_approval = approvals[0];
      result.pending_approvals = approvals;
    }
    if (job.error) {
      result.error = truncateText(job.error, MAX_ERROR_TEXT);
      if (job.error.length > MAX_ERROR_TEXT) result.error_truncated = true;
    }
    return result;
  }

  private identitySnapshot(job: JobRecord): JobSnapshot {
    const result: JobSnapshot = { status: job.status, revision: job.revision, job_id: job.jobId };
    if (job.threadId) result.thread_id = job.threadId;
    if (job.turnId) result.turn_id = job.turnId;
    return result;
  }

  private addOperationalFields(result: JobSnapshot, job: JobRecord, compactApprovals = false): void {
    if (isActiveStatus(job.status) && job.activity) result.activity = job.activity;
    if (job.error) {
      result.error = truncateText(job.error, MAX_ERROR_TEXT);
      if (job.error.length > MAX_ERROR_TEXT) result.error_truncated = true;
    }
    if (job.warnings.length > 0) {
      const warnings = boundedList(job.warnings, 10);
      result.warnings = warnings.values;
    }
    const approvals = compactApprovals
      ? [...job.pendingApprovals.values()].map(approvalSummaryView)
      : [...job.pendingApprovals.values()].map(approvalView);
    if (approvals.length > 0) {
      result.pending_approval = approvals[0];
      result.pending_approvals = approvals;
    }
  }

  private compactSnapshot(job: JobRecord): JobSnapshot {
    const result = this.identitySnapshot(job);
    this.addOperationalFields(result, job, true);
    return result;
  }

  private standardSnapshot(job: JobRecord): JobSnapshot {
    const result = this.identitySnapshot(job);
    this.addOperationalFields(result, job);
    if (job.filesChanged.length > 0 || isTerminal(job.status)) {
      const files = boundedList(job.filesChanged, MAX_STANDARD_FILES);
      result.files_changed = files.values;
      if (files.truncated) result.files_changed_truncated = true;
    }
    if (job.validation.length > 0) {
      const validation = boundedList(job.validation, MAX_STANDARD_VALIDATION);
      result.validation = validation.values;
      if (validation.truncated) result.validation_truncated = true;
    }
    if (isTerminal(job.status)) {
      if (job.finalMessage) {
        result.final_message = truncateText(job.finalMessage, MAX_STANDARD_TEXT);
        if (job.finalMessage.length > MAX_STANDARD_TEXT) result.final_message_truncated = true;
      }
      result.diffstat = diffStat(job);
    }
    return result;
  }

  private debugSnapshot(job: JobRecord): JobSnapshot {
    const result = this.identitySnapshot(job);
    this.addOperationalFields(result, job);
    if (job.pendingApprovals.size > MAX_DEBUG_LIST) {
      const approvals = [...job.pendingApprovals.values()].map(approvalView);
      result.pending_approvals = approvals.slice(0, MAX_DEBUG_LIST);
      result.pending_approval = result.pending_approvals[0];
      result.pending_approvals_truncated = true;
    }
    if (job.finalMessage) {
      result.final_message = truncateText(job.finalMessage, MAX_DEBUG_TEXT);
      if (job.finalMessage.length > MAX_DEBUG_TEXT) result.final_message_truncated = true;
    }
    if (job.latestDiff) {
      result.latest_diff = truncateText(job.latestDiff, MAX_DEBUG_TEXT);
      if (job.latestDiff.length > MAX_DEBUG_TEXT) result.latest_diff_truncated = true;
    }
    if (job.filesChanged.length > 0) {
      const files = boundedList(job.filesChanged, MAX_DEBUG_LIST);
      result.files_changed = files.values;
      if (files.truncated) result.files_changed_truncated = true;
    }
    if (job.commandsExecuted.length > 0) {
      const commands = boundedList(job.commandsExecuted, MAX_DEBUG_LIST);
      result.commands_executed = commands.values;
      if (commands.truncated) result.commands_truncated = true;
    }
    if (job.validation.length > 0) {
      const validation = boundedList(job.validation, MAX_DEBUG_LIST);
      result.validation = validation.values;
      if (validation.truncated) result.validation_truncated = true;
    }
    if (isTerminal(job.status) || job.latestDiff || job.filesChanged.length > 0) result.diffstat = diffStat(job);
    return result;
  }
}

function diffStat(job: JobRecord): DiffStat {
  const diff = job.latestDiff ?? "";
  const lines = diff.split("\n");
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) files += 1;
    else if (line.startsWith("+") && !line.startsWith("+++")) insertions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { files: Math.max(files, job.filesChanged.length), insertions, deletions };
}
