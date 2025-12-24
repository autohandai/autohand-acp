/**
 * Permission Callback Server
 * Provides an HTTP endpoint for Autohand CLI to request permissions
 * Forwards requests to Zed via ACP requestPermission
 * @license Apache-2.0
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AgentSideConnection, PermissionOption } from "@agentclientprotocol/sdk";

export interface PermissionContext {
  tool: string;
  command?: string;
  args?: string[];
  path?: string;
  description?: string;
}

type PromptRequest = {
  type: "confirm" | "select" | "input";
  message: string;
  choices?: Array<{ name: string; message: string }>;
  initial?: string;
  context?: PermissionContext;
};

type PromptResponse = {
  allowed: boolean;
  choice?: string;
  value?: string;
  reason?: "external_approved" | "external_denied";
};

export interface PermissionServerOptions {
  /** Port to listen on (0 for random) */
  port?: number;
  /** Session ID for ACP requests */
  sessionId: string;
  /** ACP client connection */
  client: AgentSideConnection;
}

export interface PermissionServer {
  /** Server URL (e.g., http://localhost:3000) */
  url: string;
  /** Stop the server */
  stop: () => Promise<void>;
}

/**
 * Creates a permission callback server that forwards requests to Zed via ACP
 */
export async function createPermissionServer(
  options: PermissionServerOptions
): Promise<PermissionServer> {
  const { port = 0, sessionId, client } = options;

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      // Only accept POST to /permission
      if (req.method !== "POST" || req.url !== "/permission") {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      try {
        const body = await readBody(req);
        const request = JSON.parse(body);

        if (request.type === "permission_request") {
          const context = request.context as PermissionContext;
          const decision = await requestPermissionFromClient(client, sessionId, context);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(decision));
          return;
        }

        if (request.type === "confirm" || request.type === "select" || request.type === "input") {
          const decision = await requestPromptFromClient(
            client,
            sessionId,
            request as PromptRequest
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(decision));
          return;
        }

        res.writeHead(400);
        res.end("Invalid request type");
      } catch (error) {
        console.error("Permission request error:", error);
        res.writeHead(500);
        res.end(JSON.stringify({ allowed: false, reason: "external_error" }));
      }
    });

    server.on("error", reject);

    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }

      const url = `http://127.0.0.1:${address.port}/permission`;

      resolve({
        url,
        stop: () =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => {
              if (err) reject(err);
              else resolve();
            });
          }),
      });
    });
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function requestPermissionFromClient(
  client: AgentSideConnection,
  sessionId: string,
  context: PermissionContext
): Promise<{ allowed: boolean; reason: "external_approved" | "external_denied" }> {
  const toolName = context.tool;
  const description = buildDescription(context);

  const options: PermissionOption[] = [
    {
      optionId: "allow_once",
      name: "Allow",
      kind: "allow_once",
    },
    {
      optionId: "allow_always",
      name: "Always Allow",
      kind: "allow_always",
    },
    {
      optionId: "reject_once",
      name: "Reject",
      kind: "reject_once",
    },
  ];

  try {
    const response = await client.requestPermission({
      sessionId,
      options,
      _meta: {
        tool: toolName,
        description,
        context,
      },
    });

    if (response.outcome.outcome === "cancelled") {
      return { allowed: false, reason: "external_denied" };
    }

    if (response.outcome.outcome === "selected") {
      const selectedId = response.outcome.optionId;
      const allowed = selectedId === "allow_once" || selectedId === "allow_always";
      return {
        allowed,
        reason: allowed ? "external_approved" : "external_denied",
      };
    }

    return { allowed: false, reason: "external_denied" };
  } catch (error) {
    console.error("Failed to request permission:", error);
    return { allowed: false, reason: "external_denied" };
  }
}

async function requestPromptFromClient(
  client: AgentSideConnection,
  sessionId: string,
  request: PromptRequest
): Promise<PromptResponse> {
  if (request.type === "input") {
    return { allowed: false, reason: "external_denied" };
  }

  if (request.type === "select" && (!request.choices || request.choices.length === 0)) {
    return { allowed: false, reason: "external_denied" };
  }

  const options: PermissionOption[] =
    request.type === "confirm"
      ? [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ]
      : (request.choices ?? []).map((choice) => ({
          optionId: choice.name,
          name: choice.message,
          kind: "allow_once",
        }));

  try {
    const response = await client.requestPermission({
      sessionId,
      options,
      _meta: {
        prompt: request.message,
        context: request.context,
      },
    });

    if (response.outcome.outcome === "cancelled") {
      return { allowed: false, reason: "external_denied" };
    }

    if (response.outcome.outcome === "selected") {
      const selectedId = response.outcome.optionId;
      if (request.type === "confirm") {
        const allowed = selectedId === "allow";
        return {
          allowed,
          reason: allowed ? "external_approved" : "external_denied",
        };
      }
      return {
        allowed: true,
        choice: selectedId,
        reason: "external_approved",
      };
    }

    return { allowed: false, reason: "external_denied" };
  } catch (error) {
    console.error("Failed to request prompt:", error);
    return { allowed: false, reason: "external_denied" };
  }
}

function buildDescription(context: PermissionContext): string {
  const parts: string[] = [context.tool];

  if (context.command) {
    const args = context.args?.join(" ") || "";
    parts.push(args ? `${context.command} ${args}` : context.command);
  }

  if (context.path) {
    parts.push(context.path);
  }

  if (context.description) {
    parts.push(`- ${context.description}`);
  }

  return parts.join(": ");
}
