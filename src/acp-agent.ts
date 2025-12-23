import {
  Agent,
  AgentSideConnection,
  CancelNotification,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestError,
  SessionNotification,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import packageJson from "../package.json" with { type: "json" };
import {
  nodeToWebReadable,
  nodeToWebWritable,
  normalizePromptText,
  parseEnvArgs,
  truncateText,
} from "./utils.js";

const DEFAULT_HISTORY_LIMIT = 6;
const DEFAULT_MAX_HISTORY_CHARS = 8000;
const DEFAULT_PERMISSION_MODE = "auto";
const MAX_UPDATE_CHUNK = 4000;

type SessionMessage = {
  role: "user" | "assistant";
  content: string;
};

type SessionState = {
  id: string;
  cwd: string;
  history: SessionMessage[];
  activeProcess?: ChildProcessByStdio<null, Readable, Readable>;
  cancelled: boolean;
  updateQueue: Promise<void>;
};

export class AutohandAcpAgent implements Agent {
  private sessions = new Map<string, SessionState>();

  constructor(private client: AgentSideConnection) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: {
          embeddedContext: true,
        },
      },
      agentInfo: {
        name: packageJson.name,
        title: "Autohand",
        version: packageJson.version,
      },
    };
  }

  async authenticate(): Promise<void> {
    return;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (!path.isAbsolute(params.cwd)) {
      throw RequestError.invalidParams({
        message: "Session cwd must be an absolute path.",
        cwd: params.cwd,
      });
    }

    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd: params.cwd,
      history: [],
      cancelled: false,
      updateQueue: Promise.resolve(),
    });

    return {
      sessionId,
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams({
        message: "Unknown session id.",
        sessionId: params.sessionId,
      });
    }

    if (session.activeProcess) {
      throw RequestError.invalidParams({
        message: "Session already has an active prompt.",
        sessionId: params.sessionId,
      });
    }

    if (!existsSync(session.cwd)) {
      await this.queueUpdate(session, `Workspace not found: ${session.cwd}\n`);
      return { stopReason: "end_turn" };
    }

    const userText = normalizePromptText(promptToText(params.prompt));
    const instruction = buildInstruction(session, userText);

    session.history.push({ role: "user", content: userText });
    session.cancelled = false;

    const { command, args, env, configPath } = buildAutohandCommand(session.cwd, instruction);

    if (configPath && !existsSync(configPath)) {
      await this.queueUpdate(
        session,
        `Autohand config not found at ${configPath}. Run autohand once to create it or set AUTOHAND_CONFIG.\n`,
      );
    }

    const child = spawn(command, args, {
      cwd: session.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    session.activeProcess = child;

    let output = "";

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      void this.queueUpdate(session, text);
    };

    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    const exitResult = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
      child.on("error", (error) => resolve({ code: 1, signal: null, error }));
    });

    session.activeProcess = undefined;

    const trimmedOutput = output.trim();
    if (trimmedOutput) {
      session.history.push({ role: "assistant", content: trimmedOutput });
    }

    if (session.cancelled) {
      return { stopReason: "cancelled" };
    }

    if (exitResult.error) {
      await this.queueUpdate(
        session,
        `Failed to launch Autohand: ${exitResult.error.message}\n`,
      );
    }

    if (exitResult.code !== 0) {
      const errorLine = `Autohand exited with code ${exitResult.code ?? "unknown"}.\n`;
      await this.queueUpdate(session, errorLine);
    }

    if (exitResult.signal) {
      const signalLine = `Autohand terminated with signal ${exitResult.signal}.\n`;
      await this.queueUpdate(session, signalLine);
    }

    return { stopReason: "end_turn" };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session || !session.activeProcess) {
      return;
    }

    session.cancelled = true;
    session.activeProcess.kill("SIGTERM");

    setTimeout(() => {
      if (session.activeProcess && !session.activeProcess.killed) {
        session.activeProcess.kill("SIGKILL");
      }
    }, 2000);
  }

  private queueUpdate(session: SessionState, text: string): Promise<void> {
    const chunks = chunkText(text, MAX_UPDATE_CHUNK);

    session.updateQueue = session.updateQueue
      .catch(() => undefined)
      .then(async () => {
      for (const chunk of chunks) {
        const notification: SessionNotification = {
          sessionId: session.id,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: chunk,
            },
          },
        };
        await this.client.sessionUpdate(notification);
      }
    });

    return session.updateQueue;
  }
}

function promptToText(prompt: ContentBlock[]): string {
  const parts: string[] = [];

  for (const block of prompt) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "resource_link":
        parts.push(`[resource_link: ${block.uri}] ${block.name ?? ""}`.trim());
        break;
      case "resource": {
        const resource = block.resource;
        if ("text" in resource) {
          const header = resource.uri ? `[resource: ${resource.uri}]` : "[resource]";
          parts.push(`${header}\n${resource.text}`.trim());
        } else {
          const uri = "uri" in resource ? resource.uri : "unknown";
          parts.push(`[resource: ${uri}] (binary content omitted)`);
        }
        break;
      }
      case "image":
        parts.push(`[image: ${block.mimeType ?? "unknown"}]`);
        break;
      case "audio":
        parts.push(`[audio: ${block.mimeType ?? "unknown"}]`);
        break;
      default:
        parts.push("[unsupported content]");
        break;
    }
  }

  return parts.join("\n");
}

function buildInstruction(session: SessionState, userText: string): string {
  const includeHistory = process.env.AUTOHAND_INCLUDE_HISTORY === "1";
  if (!includeHistory || session.history.length === 0) {
    return userText;
  }

  const historyLimitRaw = Number.parseInt(
    process.env.AUTOHAND_HISTORY_LIMIT ?? String(DEFAULT_HISTORY_LIMIT),
    10,
  );
  const maxCharsRaw = Number.parseInt(
    process.env.AUTOHAND_MAX_HISTORY_CHARS ?? String(DEFAULT_MAX_HISTORY_CHARS),
    10,
  );
  const historyLimit = Number.isNaN(historyLimitRaw) ? DEFAULT_HISTORY_LIMIT : historyLimitRaw;
  const maxChars = Number.isNaN(maxCharsRaw) ? DEFAULT_MAX_HISTORY_CHARS : maxCharsRaw;

  const history = session.history.slice(-Math.max(0, historyLimit));
  const historyText = history
    .map((entry) => `${entry.role === "user" ? "User" : "Assistant"}: ${entry.content}`)
    .join("\n\n");

  const combined = `Conversation context:\n${historyText}\n\nCurrent request:\n${userText}`;
  return truncateText(combined, maxChars);
}

function buildAutohandCommand(cwd: string, instruction: string): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  configPath: string | null;
} {
  const command = process.env.AUTOHAND_CMD ?? "autohand";
  const args: string[] = ["--prompt", instruction, "--path", cwd];

  const configPath = process.env.AUTOHAND_CONFIG ?? null;
  if (configPath) {
    args.push("--config", configPath);
  }

  const model = process.env.AUTOHAND_MODEL;
  if (model) {
    args.push("--model", model);
  }

  const temperature = process.env.AUTOHAND_TEMPERATURE;
  if (temperature) {
    args.push("--temperature", temperature);
  }

  const permissionMode = (process.env.AUTOHAND_PERMISSION_MODE ?? DEFAULT_PERMISSION_MODE).toLowerCase();
  if (permissionMode === "auto" || permissionMode === "yes") {
    args.push("--yes");
  } else if (permissionMode === "unrestricted") {
    args.push("--unrestricted");
  } else if (permissionMode === "restricted") {
    args.push("--restricted");
  }

  if (isTruthy(process.env.AUTOHAND_DRY_RUN)) {
    args.push("--dry-run");
  }

  if (isTruthy(process.env.AUTOHAND_AUTO_COMMIT)) {
    args.push("--auto-commit");
  }

  args.push(...parseEnvArgs(process.env.AUTOHAND_EXTRA_ARGS));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AUTOHAND_NO_BANNER: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    TERM: "dumb",
  };
  const defaultConfigPath = path.join(os.homedir(), ".autohand", "config.json");

  return {
    command,
    args,
    env,
    configPath: configPath ?? defaultConfigPath,
  };
}

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function chunkText(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) {
    return [text];
  }

  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += maxSize) {
    chunks.push(text.slice(start, start + maxSize));
  }
  return chunks;
}

export function runAcp(): void {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(input, output);
  new AgentSideConnection((client) => new AutohandAcpAgent(client), stream);
}
