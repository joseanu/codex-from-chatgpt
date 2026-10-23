import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ApprovalDecision } from "./jobs.js";
import { JobManager } from "./jobs.js";

const commonDecisionSchema = z.enum(["accept", "acceptForSession", "decline", "cancel"]);
const commandAmendmentSchema = z.object({
  acceptWithExecpolicyAmendment: z.object({
    execpolicy_amendment: z.array(z.string()),
  }),
});
const networkAmendmentSchema = z.object({
  applyNetworkPolicyAmendment: z.object({
    network_policy_amendment: z.object({
      host: z.string(),
      action: z.enum(["allow", "deny"]),
    }).strict(),
  }).strict(),
});
const fileSystemPathSchema = z.union([
  z.object({ type: z.literal("path"), path: z.string() }),
  z.object({ type: z.literal("glob_pattern"), pattern: z.string() }),
  z.object({
    type: z.literal("special"),
    value: z.union([
      z.object({ kind: z.literal("root") }),
      z.object({ kind: z.literal("minimal") }),
      z.object({ kind: z.literal("project_roots"), subpath: z.string().nullable().optional() }),
      z.object({ kind: z.literal("tmpdir") }),
      z.object({ kind: z.literal("slash_tmp") }),
      z.object({ kind: z.literal("unknown"), path: z.string(), subpath: z.string().nullable().optional() }),
    ]),
  }),
]);
const fileSystemEntrySchema = z.object({
  path: fileSystemPathSchema,
  access: z.enum(["read", "write", "deny"]),
});
const additionalFileSystemPermissionsSchema = z.object({
  read: z.array(z.string()).nullable().optional(),
  write: z.array(z.string()).nullable().optional(),
  globScanMaxDepth: z.number().int().positive().nullable().optional(),
  entries: z.array(fileSystemEntrySchema).nullable().optional(),
});
const permissionResponseSchema = z.object({
  permissions: z.object({
    network: z.object({ enabled: z.boolean().nullable().optional() }).nullable().optional(),
    fileSystem: additionalFileSystemPermissionsSchema.nullable().optional(),
  }),
  scope: z.enum(["turn", "session"]).default("turn"),
  strictAutoReview: z.boolean().nullable().optional(),
});
const legacyApprovalDecisionSchema = z.union([
  z.enum(["approved", "approved_for_session", "timed_out", "abort"]),
  z.object({ approved_execpolicy_amendment: z.object({ proposed_execpolicy_amendment: z.array(z.string()) }) }),
  z.object({ network_policy_amendment: z.object({ network_policy_amendment: z.object({ host: z.string(), action: z.enum(["allow", "deny"]) }) }) }),
  z.object({ denied: z.object({ rejection: z.string() }) }),
]);
const approvalDecisionSchema = z.union([
  commonDecisionSchema,
  commandAmendmentSchema,
  networkAmendmentSchema,
  permissionResponseSchema,
  legacyApprovalDecisionSchema,
]);

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function success(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: jsonText(value) }],
    structuredContent: value,
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const value = { status: "failed", error: message };
  return {
    isError: true,
    content: [{ type: "text" as const, text: jsonText(value) }],
    structuredContent: value,
  };
}

export function createMcpServer(manager: JobManager): McpServer {
  const server = new McpServer({ name: "Codex Agent", version: "0.3.1" }, { maxToolInputElements: 10_000 });

  server.registerTool(
    "codex_start",
    {
      title: "Start Codex task",
      description:
        "Crea un thread persistente de Codex en un workspace local permitido y comienza un turn. No expone shell ni filesystem al cliente MCP.",
      inputSchema: {
        workspace: z.string().min(1).describe("Ruta absoluta lógicamente bajo la raíz administrativa; se aceptan symlinks ubicados ahí."),
        prompt: z.string().min(1).describe("Instrucción para Codex."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ workspace, prompt }) => {
      try {
        return success(await manager.start(workspace, prompt));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "codex_continue",
    {
      title: "Continue Codex task",
      description: "Envía otro prompt al mismo thread de Codex identificado por job_id.",
      inputSchema: {
        job_id: z.string().min(1),
        prompt: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ job_id, prompt }) => {
      try {
        return success(await manager.continue(job_id, prompt));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "codex_get",
    {
      title: "Get Codex task",
      description:
        "Devuelve un snapshot compacto, estándar o de depuración del job. Usa since_revision para sondear sin reenviar historial.",
      inputSchema: {
        job_id: z.string().min(1),
        detail: z.enum(["compact", "standard", "debug"]).optional().default("standard"),
        since_revision: z.number().int().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ job_id, detail, since_revision }) => {
      try {
        return success(manager.get(job_id, { detail, since_revision }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "codex_interrupt",
    {
      title: "Interrupt Codex task",
      description: "Interrumpe el turn activo del job usando turn/interrupt del app-server real.",
      inputSchema: { job_id: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ job_id }) => {
      try {
        return success(await manager.interrupt(job_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "codex_respond_approval",
    {
      title: "Respond to Codex approval",
      description:
        "Responde exactamente una approval pendiente emitida por app-server. request_id es obligatorio cuando coexisten varias approvals.",
      inputSchema: {
        job_id: z.string().min(1),
        request_id: z.union([z.string().min(1), z.number().finite()]),
        decision: approvalDecisionSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ job_id, request_id, decision }) => {
      try {
        return success(await manager.respondApproval(job_id, request_id, decision as ApprovalDecision));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
