import {
  Agent,
  AgentSideConnection,
  AvailableCommand,
  CancelNotification,
  ContentBlock,
  CurrentModeUpdate,
  EnvVariable,
  InitializeRequest,
  InitializeResponse,
  ModelInfo,
  NewSessionRequest,
  NewSessionResponse,
  Plan,
  PlanEntry,
  PromptRequest,
  PromptResponse,
  RequestError,
  SessionMode,
  SessionModeState,
  SessionModelState,
  SessionNotification,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  TerminalHandle,
  ToolCall,
  ToolCallUpdate,
  ToolKind,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
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
const DEFAULT_COMMANDS: AvailableCommand[] = [
  { name: "help", description: "Show help" },
  { name: "new", description: "Start a new session" },
  { name: "model", description: "Change the active model" },
  { name: "undo", description: "Undo the last change" },
  { name: "init", description: "Create AGENTS.md" },
  { name: "sessions", description: "List sessions" },
  { name: "resume", description: "Resume a session" },
  { name: "memory", description: "Manage memory" },
  { name: "feedback", description: "Send feedback" },
  { name: "agents", description: "Manage agents" },
  { name: "quit", description: "Exit Autohand" },
];
const DEFAULT_MODES: SessionMode[] = [
  { id: "default", name: "Default", description: "Autohand default behavior" },
  { id: "ask", name: "Ask", description: "Answer without code changes" },
  { id: "code", name: "Code", description: "Prefer code changes" },
];

const TOOL_KIND_MAP: Record<string, ToolKind> = {
  read_file: "read",
  search: "search",
  semantic_search: "search",
  write_file: "edit",
  append_file: "edit",
  apply_patch: "edit",
  format_file: "edit",
  replace_in_file: "edit",
  rename_path: "move",
  copy_path: "move",
  delete_path: "delete",
  run_command: "execute",
  git_status: "execute",
  git_diff: "execute",
  git_commit: "execute",
  git_add: "execute",
  git_init: "execute",
  todo_write: "think",
  plan: "think",
};

type ToolCallRecord = {
  id?: string;
  tool?: string;
  args?: unknown;
};

type SessionMessage = {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  toolCalls?: ToolCallRecord[];
  name?: string;
  tool_call_id?: string;
};

type SessionState = {
  id: string;
  cwd: string;
  history: SessionMessage[];
  activeProcess?: ChildProcessByStdio<null, Readable, Readable>;
  terminalHandle?: TerminalHandle;
  cancelled: boolean;
  updateQueue: Promise<void>;
  availableModes: SessionMode[];
  modeId: string;
  availableModels: ModelInfo[];
  modelId: string;
  availableCommands: AvailableCommand[];
  toolCalls: Map<string, ToolCall>;
  conversationPath?: string;
  conversationOffset: number;
  conversationRemainder: string;
  useClientTerminal: boolean;
  autohandHome: string;
};

export class AutohandAcpAgent implements Agent {
  private sessions = new Map<string, SessionState>();
  private clientCapabilities?: InitializeRequest["clientCapabilities"];

  constructor(private client: AgentSideConnection) {}

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = params.clientCapabilities;

    const promptCapabilities: InitializeResponse["agentCapabilities"] = {
      promptCapabilities: {
        embeddedContext: true,
        image: isTruthy(process.env.AUTOHAND_SUPPORTS_IMAGE) || undefined,
        audio: isTruthy(process.env.AUTOHAND_SUPPORTS_AUDIO) || undefined,
      },
    };

    return {
      protocolVersion: params.protocolVersion ?? 1,
      agentCapabilities: promptCapabilities,
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

    const availableModes = parseAvailableModes();
    const modeId = resolveDefaultMode(availableModes);
    const availableModels = parseAvailableModels();
    const modelId = resolveDefaultModel(availableModels);
    const availableCommands = parseAvailableCommands();
    const useClientTerminal = isTruthy(process.env.AUTOHAND_USE_CLIENT_TERMINAL);

    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd: params.cwd,
      history: [],
      cancelled: false,
      updateQueue: Promise.resolve(),
      availableModes,
      modeId,
      availableModels,
      modelId,
      availableCommands,
      toolCalls: new Map(),
      conversationOffset: 0,
      conversationRemainder: "",
      useClientTerminal,
      autohandHome: resolveAutohandHome(),
    });

    const response: NewSessionResponse = { sessionId };
    if (availableModes.length > 0) {
      response.modes = { availableModes, currentModeId: modeId } as SessionModeState;
    }
    if (availableModels.length > 0) {
      response.models = { availableModels, currentModelId: modelId } as SessionModelState;
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      await this.queueSessionUpdate(session, {
        sessionUpdate: "available_commands_update",
        availableCommands: availableCommands,
      });
    }

    return response;
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams({
        message: "Unknown session id.",
        sessionId: params.sessionId,
      });
    }

    const modeId = params.modeId;
    session.modeId = modeId;

    const update: CurrentModeUpdate = { currentModeId: modeId };
    await this.queueSessionUpdate(session, {
      sessionUpdate: "current_mode_update",
      ...update,
    });

    return {};
  }

  async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams({
        message: "Unknown session id.",
        sessionId: params.sessionId,
      });
    }

    session.modelId = params.modelId;
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams({
        message: "Unknown session id.",
        sessionId: params.sessionId,
      });
    }

    if (session.activeProcess || session.terminalHandle) {
      throw RequestError.invalidParams({
        message: "Session already has an active prompt.",
        sessionId: params.sessionId,
      });
    }

    if (!existsSync(session.cwd)) {
      await this.queueTextUpdate(session, `Workspace not found: ${session.cwd}\n`);
      return { stopReason: "end_turn" };
    }

    const resolvedPrompt = await this.resolvePromptBlocks(session, params.prompt);
    const userText = normalizePromptText(promptToText(resolvedPrompt));
    const instruction = buildInstruction(session, userText);

    session.history.push({ role: "user", content: userText });
    session.cancelled = false;

    const sessionsSnapshot = await snapshotSessionIds(session.autohandHome);
    const { command, args, env, configPath } = buildAutohandCommand({
      cwd: session.cwd,
      instruction,
      modelId: session.modelId,
      autohandHome: session.autohandHome,
    });

    if (configPath && !existsSync(configPath)) {
      await this.queueTextUpdate(
        session,
        `Autohand config not found at ${configPath}. Run autohand once to create it or set AUTOHAND_CONFIG.\n`,
      );
    }

    const tailAbort = new AbortController();
    const tailPromise = this.trackConversation(session, sessionsSnapshot, tailAbort.signal);

    if (session.useClientTerminal && this.clientCapabilities?.terminal) {
      const toolCallId = randomUUID();
      const terminal = await this.client.createTerminal({
        sessionId: session.id,
        command,
        args,
        cwd: session.cwd,
        env: envToVariables(env),
      });
      session.terminalHandle = terminal;

      const toolCall: ToolCall = {
        toolCallId,
        title: "Run Autohand",
        kind: "execute",
        status: "in_progress",
        content: [{ type: "terminal", terminalId: terminal.id }],
      };

      await this.queueSessionUpdate(session, {
        sessionUpdate: "tool_call",
        ...toolCall,
      });

      const exitStatus = await terminal.waitForExit();
      const terminalOutput = await terminal.currentOutput();
      await terminal.release();
      session.terminalHandle = undefined;

      const outputText = terminalOutput.output;
      if (outputText) {
        await this.queueTextUpdate(session, outputText);
      }

      const status = exitStatus?.exitStatus ? "completed" : "failed";
      const update: ToolCallUpdate = {
        toolCallId,
        status,
        rawOutput: terminalOutput,
      };

      await this.queueSessionUpdate(session, {
        sessionUpdate: "tool_call_update",
        ...update,
      });

      tailAbort.abort();
      await tailPromise;

      if (session.cancelled) {
        return { stopReason: "cancelled" };
      }

      return { stopReason: "end_turn" };
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
      void this.queueTextUpdate(session, text);
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
    tailAbort.abort();
    await tailPromise;

    const trimmedOutput = output.trim();
    if (trimmedOutput) {
      session.history.push({ role: "assistant", content: trimmedOutput });
    }

    if (session.cancelled) {
      return { stopReason: "cancelled" };
    }

    if (exitResult.error) {
      await this.queueTextUpdate(
        session,
        `Failed to launch Autohand: ${exitResult.error.message}\n`,
      );
    }

    if (exitResult.code !== 0) {
      const errorLine = `Autohand exited with code ${exitResult.code ?? "unknown"}.\n`;
      await this.queueTextUpdate(session, errorLine);
    }

    if (exitResult.signal) {
      const signalLine = `Autohand terminated with signal ${exitResult.signal}.\n`;
      await this.queueTextUpdate(session, signalLine);
    }

    return { stopReason: "end_turn" };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      return;
    }

    session.cancelled = true;

    if (session.terminalHandle) {
      await session.terminalHandle.kill();
      return;
    }

    if (!session.activeProcess) {
      return;
    }

    session.activeProcess.kill("SIGTERM");

    setTimeout(() => {
      if (session.activeProcess && !session.activeProcess.killed) {
        session.activeProcess.kill("SIGKILL");
      }
    }, 2000);
  }

  private async trackConversation(
    session: SessionState,
    snapshot: Set<string>,
    signal: AbortSignal,
  ): Promise<void> {
    const conversationPath = await waitForConversationPath(
      session.autohandHome,
      session.cwd,
      snapshot,
      signal,
    );

    if (!conversationPath) {
      return;
    }

    session.conversationPath = conversationPath;

    while (!signal.aborted) {
      await this.readConversation(session);
      await sleep(250);
    }

    await this.readConversation(session);
  }

  private async readConversation(session: SessionState): Promise<void> {
    if (!session.conversationPath) {
      return;
    }

    let data: string;
    try {
      data = await fs.readFile(session.conversationPath, "utf8");
    } catch {
      return;
    }

    if (data.length <= session.conversationOffset) {
      return;
    }

    const slice = data.slice(session.conversationOffset);
    session.conversationOffset = data.length;

    const combined = session.conversationRemainder + slice;
    const lines = combined.split("\n");
    session.conversationRemainder = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let message: SessionMessage;
      try {
        message = JSON.parse(trimmed) as SessionMessage;
      } catch {
        continue;
      }
      await this.handleSessionMessage(session, message);
    }
  }

  private async handleSessionMessage(session: SessionState, message: SessionMessage): Promise<void> {
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        await this.handleToolCallStart(session, call);
      }
    }

    if (message.role === "tool") {
      await this.handleToolCallResult(session, message);
    }
  }

  private async handleToolCallStart(session: SessionState, call: ToolCallRecord): Promise<void> {
    const tool = call.tool ?? "tool";
    const toolCallId = call.id ?? randomUUID();
    const kind = TOOL_KIND_MAP[tool] ?? "other";
    const title = buildToolTitle(tool, call.args);

    const toolCall: ToolCall = {
      toolCallId,
      title,
      kind,
      status: "pending",
      rawInput: call.args,
      locations: resolveLocations(call.args),
    };

    session.toolCalls.set(toolCallId, toolCall);
    await this.queueSessionUpdate(session, {
      sessionUpdate: "tool_call",
      ...toolCall,
    });

    if (tool === "todo_write") {
      const plan = planFromTodo(call.args);
      if (plan) {
        await this.queueSessionUpdate(session, {
          sessionUpdate: "plan",
          ...plan,
        });
      }
    }

    if (tool === "plan") {
      const plan = planFromNotes(call.args);
      if (plan) {
        await this.queueSessionUpdate(session, {
          sessionUpdate: "plan",
          ...plan,
        });
      }
    }
  }

  private async handleToolCallResult(session: SessionState, message: SessionMessage): Promise<void> {
    const toolCallId = message.tool_call_id ?? randomUUID();
    const outputText = message.content ?? "";
    const failed = /error|failed|exception/i.test(outputText);

    if (!session.toolCalls.has(toolCallId) && message.name) {
      const fallback: ToolCall = {
        toolCallId,
        title: message.name,
        kind: TOOL_KIND_MAP[message.name] ?? "other",
        status: "completed",
      };
      session.toolCalls.set(toolCallId, fallback);
      await this.queueSessionUpdate(session, {
        sessionUpdate: "tool_call",
        ...fallback,
      });
    }

    const update: ToolCallUpdate = {
      toolCallId,
      status: failed ? "failed" : "completed",
      rawOutput: outputText,
      content: outputText
        ? [
            {
              type: "content",
              content: {
                type: "text",
                text: outputText,
              },
            },
          ]
        : undefined,
    };

    await this.queueSessionUpdate(session, {
      sessionUpdate: "tool_call_update",
      ...update,
    });
  }

  private async resolvePromptBlocks(
    session: SessionState,
    prompt: ContentBlock[],
  ): Promise<ContentBlock[]> {
    if (!isTruthy(process.env.AUTOHAND_EMBED_RESOURCE_LINKS)) {
      return prompt;
    }

    if (!this.clientCapabilities?.fs?.readTextFile) {
      return prompt;
    }

    const resolved: ContentBlock[] = [];
    for (const block of prompt) {
      if (block.type !== "resource_link") {
        resolved.push(block);
        continue;
      }

      const pathFromUri = extractPathFromUri(block.uri);
      if (!pathFromUri) {
        resolved.push(block);
        continue;
      }

      try {
        const response = await this.client.readTextFile({
          sessionId: session.id,
          path: pathFromUri,
        });
        resolved.push({
          type: "resource",
          resource: {
            uri: block.uri,
            text: response.content,
            mimeType: block.mimeType ?? "text/plain",
          },
        });
      } catch {
        resolved.push(block);
      }
    }

    return resolved;
  }

  private queueSessionUpdate(
    session: SessionState,
    update: SessionNotification["update"],
  ): Promise<void> {
    session.updateQueue = session.updateQueue
      .catch(() => undefined)
      .then(async () => {
        const notification: SessionNotification = {
          sessionId: session.id,
          update,
        };
        await this.client.sessionUpdate(notification);
      });

    return session.updateQueue;
  }

  private queueTextUpdate(session: SessionState, text: string): Promise<void> {
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
  const modePrefix = session.modeId ? `Mode: ${session.modeId}\n\n` : "";
  const requestText = `${modePrefix}${userText}`.trim();

  if (!includeHistory || session.history.length === 0) {
    return requestText;
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

  const combined = `Conversation context:\n${historyText}\n\nCurrent request:\n${requestText}`;
  return truncateText(combined, maxChars);
}

function buildAutohandCommand(options: {
  cwd: string;
  instruction: string;
  modelId: string;
  autohandHome: string;
}): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  configPath: string | null;
} {
  const command = process.env.AUTOHAND_CMD ?? "autohand";
  const args: string[] = ["--prompt", options.instruction, "--path", options.cwd];

  const configPath = process.env.AUTOHAND_CONFIG ?? path.join(os.homedir(), ".autohand", "config.json");
  args.push("--config", configPath);

  if (options.modelId) {
    args.push("--model", options.modelId);
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
    AUTOHAND_HOME: options.autohandHome,
  };

  return {
    command,
    args,
    env,
    configPath,
  };
}

function parseAvailableModes(): SessionMode[] {
  const rawJson = process.env.AUTOHAND_AVAILABLE_MODES_JSON;
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as SessionMode[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch {
      // ignore invalid JSON
    }
  }

  const raw = process.env.AUTOHAND_AVAILABLE_MODES;
  if (raw) {
    return raw
      .split(",")
      .map((mode) => mode.trim())
      .filter(Boolean)
      .map((mode) => ({ id: mode, name: titleCase(mode) }));
  }

  return DEFAULT_MODES;
}

function resolveDefaultMode(modes: SessionMode[]): string {
  const envMode = process.env.AUTOHAND_DEFAULT_MODE;
  if (envMode && modes.some((mode) => mode.id === envMode)) {
    return envMode;
  }
  return modes[0]?.id ?? "default";
}

function parseAvailableModels(): ModelInfo[] {
  const rawJson = process.env.AUTOHAND_AVAILABLE_MODELS_JSON;
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as ModelInfo[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch {
      // ignore invalid JSON
    }
  }

  const raw = process.env.AUTOHAND_AVAILABLE_MODELS;
  if (raw) {
    return raw
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean)
      .map((model) => ({ modelId: model, name: model }));
  }

  const fallback = process.env.AUTOHAND_MODEL;
  if (fallback) {
    return [{ modelId: fallback, name: fallback }];
  }

  return [];
}

function resolveDefaultModel(models: ModelInfo[]): string {
  const envModel = process.env.AUTOHAND_MODEL;
  if (envModel && models.some((model) => model.modelId === envModel)) {
    return envModel;
  }
  return models[0]?.modelId ?? "";
}

function parseAvailableCommands(): AvailableCommand[] {
  const rawJson = process.env.AUTOHAND_AVAILABLE_COMMANDS_JSON;
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as AvailableCommand[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch {
      // ignore invalid JSON
    }
  }

  return DEFAULT_COMMANDS;
}

function resolveAutohandHome(): string {
  if (process.env.AUTOHAND_HOME) {
    return process.env.AUTOHAND_HOME;
  }
  return path.join(os.homedir(), ".autohand");
}

async function snapshotSessionIds(autohandHome: string): Promise<Set<string>> {
  const sessions = await readSessionIndex(autohandHome);
  return new Set(sessions.map((session) => session.id));
}

async function waitForConversationPath(
  autohandHome: string,
  cwd: string,
  snapshot: Set<string>,
  signal: AbortSignal,
): Promise<string | null> {
  const sessionsDir = path.join(autohandHome, "sessions");
  const resolvedCwd = path.resolve(cwd);

  for (let attempts = 0; attempts < 40; attempts += 1) {
    if (signal.aborted) {
      return null;
    }

    const sessions = await readSessionIndex(autohandHome);
    const candidates = sessions.filter(
      (session) => !snapshot.has(session.id) && session.projectPath === resolvedCwd,
    );
    if (candidates.length > 0) {
      const latest = candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return path.join(sessionsDir, latest.id, "conversation.jsonl");
    }

    if (existsSync(sessionsDir)) {
      const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
      const dir = entries.find((entry) => entry.isDirectory() && !snapshot.has(entry.name));
      if (dir) {
        return path.join(sessionsDir, dir.name, "conversation.jsonl");
      }
    }

    await sleep(200);
  }

  return null;
}

async function readSessionIndex(autohandHome: string): Promise<Array<{ id: string; projectPath: string; createdAt: string }>> {
  const indexPath = path.join(autohandHome, "sessions", "index.json");
  try {
    const content = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(content) as { sessions?: Array<{ id: string; projectPath: string; createdAt: string }> };
    return parsed.sessions ?? [];
  } catch {
    return [];
  }
}

function buildToolTitle(tool: string, args?: unknown): string {
  if (!args || typeof args !== "object") {
    return tool;
  }
  const pathArg = (args as { path?: string }).path;
  if (pathArg) {
    return `${tool} ${pathArg}`;
  }
  const queryArg = (args as { query?: string }).query;
  if (queryArg) {
    return `${tool} "${queryArg}"`;
  }
  return tool;
}

function resolveLocations(args?: unknown): Array<{ path: string }> | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const pathArg = (args as { path?: string }).path;
  if (!pathArg) {
    return undefined;
  }
  return [{ path: pathArg }];
}

function planFromTodo(args?: unknown): Plan | null {
  if (!args || typeof args !== "object") {
    return null;
  }
  const tasks = (args as { tasks?: Array<{ id: string; title: string; status: string; description?: string }> }).tasks;
  if (!Array.isArray(tasks)) {
    return null;
  }
  const entries: PlanEntry[] = tasks.map((task) => ({
    content: task.description ? `${task.title} — ${task.description}` : task.title,
    status: normalizePlanStatus(task.status),
    priority: "medium",
  }));
  return { entries };
}

function planFromNotes(args?: unknown): Plan | null {
  if (!args || typeof args !== "object") {
    return null;
  }
  const notes = (args as { notes?: string }).notes;
  if (!notes) {
    return null;
  }
  const entries: PlanEntry[] = [{
    content: notes,
    status: "in_progress",
    priority: "low",
  }];
  return { entries };
}

function normalizePlanStatus(status?: string): "pending" | "in_progress" | "completed" {
  if (status === "completed") return "completed";
  if (status === "in_progress") return "in_progress";
  return "pending";
}

function extractPathFromUri(uri: string): string | null {
  if (uri.startsWith("file://")) {
    const decoded = decodeURIComponent(uri.replace("file://", ""));
    return decoded;
  }
  if (path.isAbsolute(uri)) {
    return uri;
  }
  return null;
}

function envToVariables(env: NodeJS.ProcessEnv): EnvVariable[] {
  return Object.entries(env)
    .filter(([, value]) => typeof value === "string")
    .map(([name, value]) => ({ name, value: value as string }));
}

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function runAcp(): void {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(input, output);
  new AgentSideConnection((client) => new AutohandAcpAgent(client), stream);
}
