import {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  AuthMethod,
  AvailableCommand,
  CancelNotification,
  ContentBlock,
  CurrentModeUpdate,
  EnvVariable,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  ModelInfo,
  NewSessionRequest,
  NewSessionResponse,
  Plan,
  PlanEntry,
  PromptRequest,
  PromptResponse,
  RequestError,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionInfo,
  SessionMode,
  SessionModeState,
  SessionModelState,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
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
  stripAnsi,
  truncateText,
} from "./utils.js";
import {
  createPermissionServer,
  type PermissionServer,
} from "./permission-server.js";
import { getTelemetryClient } from "./telemetry.js";

// ============ Feedback Types & Client ============

interface FeedbackResponse {
  npsScore: number;
  reason?: string;
  timestamp: string;
  sessionId?: string;
  triggerType: "manual" | "auto_prompt";
}

interface FeedbackSubmission extends FeedbackResponse {
  deviceId: string;
  cliVersion: string;
  platform: string;
  osVersion: string;
  nodeVersion: string;
  source: "acp_extension";
}

const FEEDBACK_API_URL = "https://api.autohand.ai/v1/feedback";
const FEEDBACK_COOLDOWN_HOURS = 48;

/**
 * Generate random feedback trigger point: either 10, or randomly 5-8
 */
function generateFeedbackTrigger(): number {
  // 50% chance of triggering at exactly 10
  if (Math.random() < 0.5) {
    return 10;
  }
  // Otherwise random between 5-8
  return Math.floor(Math.random() * 4) + 5; // 5, 6, 7, or 8
}

// Simple device ID generator (anonymous, not tied to user identity)
function getDeviceId(): string {
  const id = `acp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return id;
}

async function submitFeedback(feedback: FeedbackResponse): Promise<boolean> {
  const submission: FeedbackSubmission = {
    ...feedback,
    deviceId: getDeviceId(),
    cliVersion: packageJson.version,
    platform: process.platform,
    osVersion: os.release(),
    nodeVersion: process.version,
    source: "acp_extension",
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(FEEDBACK_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CLI-Version": packageJson.version,
        "X-Device-ID": submission.deviceId,
      },
      body: JSON.stringify(submission),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

// ============ Constants ============

const DEFAULT_HISTORY_LIMIT = 6;
const DEFAULT_MAX_HISTORY_CHARS = 8000;
const DEFAULT_PERMISSION_MODE = "auto";
const MAX_UPDATE_CHUNK = 4000;
const DEFAULT_COMMANDS: AvailableCommand[] = [
  { name: "help", description: "Show available commands" },
  { name: "new", description: "Start a new conversation" },
  { name: "model", description: "Select or change the model" },
  { name: "mode", description: "Select or change the mode" },
  { name: "resume", description: "Resume a previous session" },
  { name: "threads", description: "Show and switch between sessions" },
  { name: "sessions", description: "List recent sessions" },
  { name: "session", description: "Show current session info" },
  { name: "status", description: "Show Autohand status" },
  { name: "undo", description: "Undo the last file change" },
  { name: "init", description: "Create AGENTS.md file" },
  { name: "memory", description: "Manage conversation memory" },
  { name: "skills", description: "List available skills" },
  { name: "export", description: "Export conversation" },
  { name: "permissions", description: "Manage tool permissions" },
  { name: "feedback", description: "Send feedback to Autohand" },
  { name: "agents", description: "List available agents" },
  { name: "hooks", description: "Manage lifecycle hooks" },
  { name: "automode", description: "Toggle autonomous agent loop" },
  { name: "add-dir", description: "Add additional working directory" },
  { name: "remove-dir", description: "Remove additional working directory" },
  { name: "share", description: "Share session transcript" },
  { name: "formatters", description: "Manage code formatters" },
  { name: "lint", description: "Run code linting" },
];
const DEFAULT_MODES: SessionMode[] = [
  {
    id: "interactive",
    name: "Interactive",
    description: "Ask before each action",
  },
  { id: "full-access", name: "Full access", description: "Allow all actions" },
  {
    id: "unrestricted",
    name: "Unrestricted",
    description: "Skip all approval prompts",
  },
  { id: "auto-mode", name: "Auto-mode", description: "Autonomous agent loop" },
  {
    id: "restricted",
    name: "Restricted",
    description: "Block dangerous actions",
  },
  { id: "dry-run", name: "Dry run", description: "Preview without executing" },
];

type ParsedCommand = {
  command: string;
  args: string[];
} | null;

function parseSlashCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0]?.toLowerCase() ?? "";
  const args = parts.slice(1);

  return { command, args };
}

const TOOL_KIND_MAP: Record<string, ToolKind> = {
  // Read operations
  read_file: "read",
  list_tree: "read",
  file_stats: "read",

  // Search operations
  search: "search",
  search_with_context: "search",
  semantic_search: "search",

  // Edit operations
  write_file: "edit",
  append_file: "edit",
  apply_patch: "edit",
  format_file: "edit",
  replace_in_file: "edit",
  search_replace: "edit",
  create_directory: "edit",

  // Move/delete operations
  rename_path: "move",
  copy_path: "move",
  delete_path: "delete",

  // Execute operations
  run_command: "execute",
  git_status: "execute",
  git_diff: "execute",
  git_commit: "execute",
  git_add: "execute",
  git_init: "execute",
  git_log: "execute",
  git_list_untracked: "execute",

  // Think/plan operations
  todo_write: "think",
  plan: "think",
  smart_context_cropper: "think",

  // Memory operations
  save_memory: "other",
  recall_memory: "other",
  tools_registry: "other",
};

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // Read operations
  read_file: "Read",
  list_tree: "List",
  file_stats: "Stats",

  // Search operations
  search: "Search",
  search_with_context: "Search",
  semantic_search: "Search",

  // Edit operations
  write_file: "Write",
  append_file: "Append",
  apply_patch: "Patch",
  format_file: "Format",
  replace_in_file: "Replace",
  search_replace: "Replace",
  create_directory: "Create",

  // Move/delete operations
  rename_path: "Rename",
  copy_path: "Copy",
  delete_path: "Delete",

  // Execute operations
  run_command: "Run",
  git_status: "Git Status",
  git_diff: "Git Diff",
  git_commit: "Git Commit",
  git_add: "Git Add",
  git_init: "Git Init",
  git_log: "Git Log",
  git_list_untracked: "Git Untracked",

  // Think/plan operations
  todo_write: "Todo",
  plan: "Plan",
  smart_context_cropper: "Thinking",

  // Memory operations
  save_memory: "Save Memory",
  recall_memory: "Recall Memory",
  tools_registry: "Tools",
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
  _meta?: Record<string, unknown>;
};

type ParsedAssistantContent = {
  raw: string;
  thought?: string;
  response?: string;
  toolCalls?: ToolCallRecord[];
  structured: boolean;
};

type SessionState = {
  id: string;
  cwd: string;
  history: SessionMessage[];
  activeProcess?: ChildProcessByStdio<null, Readable, Readable>;
  terminalHandle?: TerminalHandle;
  cancelled: boolean;
  updateQueue: Promise<void>;
  promptQueue: Promise<PromptResponse>;
  availableModes: SessionMode[];
  modeId: string;
  availableModels: ModelInfo[];
  modelId: string;
  availableCommands: AvailableCommand[];
  configOptions: SessionConfigOption[];
  toolCalls: Map<string, ToolCall>;
  toolCallOutputs: Map<string, string>;
  streamingToolCalls: Set<string>;
  terminalToolCalls: Set<string>;
  conversationPath?: string;
  conversationOffset: number;
  conversationRemainder: string;
  hasStructuredOutput: boolean;
  hasAgentResponse: boolean;
  stdoutFallbackActive: boolean;
  stdoutBuffer: string;
  stdoutFallbackTimer?: ReturnType<typeof setTimeout>;
  completionStats?: string;
  rawStdoutForStats: string; // Buffer all stdout to extract stats after process exits
  useClientTerminal: boolean;
  autohandHome: string;
  permissionServer?: PermissionServer;
  title?: string;
  titleGenerated: boolean;
  parentSessionId?: string; // For forked sessions
  mcpServers: Array<{
    name: string;
    type: string;
    url?: string;
    command?: string;
  }>;
  // Feedback tracking
  interactionCount: number;
  lastFeedbackPrompt?: string; // ISO timestamp
  feedbackPending: boolean; // Waiting for feedback response
  feedbackShownThisSession: boolean; // Only show feedback once per session
  feedbackTriggerAt?: number; // Random trigger point (5-8 or 10)
  // Client identification
  clientName?: string; // e.g., "zed", "vscode"
  clientVersion?: string;
  // Auto-mode state
  autoModeEnabled: boolean;
  autoModeMaxIterations: number;
  autoModeMaxRuntime: number; // in minutes
  autoModeMaxCost: number; // in dollars
  // Multi-directory support
  additionalDirs: string[];
};

export class AutohandAcpAgent implements Agent {
  private sessions = new Map<string, SessionState>();
  private clientCapabilities?: InitializeRequest["clientCapabilities"];
  private clientInfo?: { name: string; version?: string };

  constructor(private client: AgentSideConnection) {}

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = params.clientCapabilities;

    // Capture client info (e.g., "zed", "Zed Editor")
    if (params.clientInfo) {
      this.clientInfo = {
        name: params.clientInfo.name,
        version: (params.clientInfo as { version?: string }).version,
      };
    }

    const agentCapabilities: InitializeResponse["agentCapabilities"] = {
      promptCapabilities: {
        embeddedContext: true,
        image: true, // Enable image support for screenshot analysis
        audio: isTruthy(process.env.AUTOHAND_SUPPORTS_AUDIO) || undefined,
      },
      loadSession: true,
      mcpCapabilities: {
        http: true, // Support HTTP MCP servers
        sse: true, // Support SSE MCP servers
      },
      sessionCapabilities: {
        list: {}, // Support session/list
        resume: {}, // Support session/resume
        fork: {}, // Support session/fork
      },
    };

    // Check if Autohand CLI is installed
    const cliCheck = await checkCliInstalled();

    // Build auth methods based on CLI and auth status
    const authMethods: AuthMethod[] = [];

    if (!cliCheck.installed) {
      // CLI not installed - show install instructions as auth method
      authMethods.push({
        id: "autohand-install",
        name: "Install Autohand CLI",
        description:
          cliCheck.error || "Autohand CLI is required but not installed",
        _meta: {
          "terminal-auth": {
            command: "npm",
            args: ["install", "-g", "autohand-cli"],
            label: "Install Autohand CLI",
          },
        },
      } as AuthMethod);
    } else {
      // CLI installed - check authentication status
      const isAuthenticated = await checkAuthStatus();

      if (!isAuthenticated) {
        authMethods.push({
          id: "autohand-login",
          name: "Login to Autohand",
          description: "Sign in with your Autohand account",
          _meta: {
            "terminal-auth": {
              command: "autohand",
              args: ["login"],
              label: "Autohand Login",
            },
          },
        } as AuthMethod);
      }
    }

    const response = {
      protocolVersion: params.protocolVersion ?? 1,
      agentCapabilities,
      agentInfo: {
        name: packageJson.name,
        title: "Autohand CLI",
        version: packageJson.version,
        ...(cliCheck.version && { _meta: { cliVersion: cliCheck.version } }),
      },
      authMethods: authMethods.length > 0 ? authMethods : undefined,
      // Include warning if CLI not installed
      ...(!cliCheck.installed && {
        _meta: {
          warning: cliCheck.error,
          installUrl: "https://autohand.ai/docs/guides/zed-integration",
        },
      }),
    };

    return response;
  }

  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse> {
    // Check if already authenticated
    const isStub =
      process.env.AUTOHAND_CMD && existsSync(process.env.AUTOHAND_CMD);
    if (isStub || (await checkAuthStatus())) {
      return {};
    }

    // Check if client supports terminal-auth (like Zed does)
    // If so, the client handles running the terminal command itself
    const meta = (
      this.clientCapabilities as { _meta?: Record<string, unknown> }
    )?._meta;
    const supportsTerminalAuth = meta?.["terminal-auth"] === true;

    if (!supportsTerminalAuth) {
      // Client doesn't support terminal-auth, tell user to run manually
      throw RequestError.authRequired({
        message:
          "Please run `autohand login` in your terminal, then try again.",
      });
    }

    // With terminal-auth, client ran the login command - just verify it worked
    if (!(await checkAuthStatus())) {
      throw RequestError.authRequired({
        message: "Login was not completed. Please try again.",
      });
    }

    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (!path.isAbsolute(params.cwd)) {
      throw RequestError.invalidParams({
        message: "Session cwd must be an absolute path.",
        cwd: params.cwd,
      });
    }

    // Check authentication - if not logged in, throw authRequired
    // With terminal-auth support in authMethods, Zed will open a terminal
    const isStub =
      process.env.AUTOHAND_CMD && existsSync(process.env.AUTOHAND_CMD);
    if (!isStub && !(await checkAuthStatus())) {
      // Check if client supports terminal-auth
      const meta = (
        this.clientCapabilities as { _meta?: Record<string, unknown> }
      )?._meta;
      const supportsTerminalAuth = meta?.["terminal-auth"] === true;

      const message = supportsTerminalAuth
        ? "Please log in to use Autohand"
        : "Please run `autohand login` in your terminal, then try again.";

      throw RequestError.authRequired({ message });
    }

    const availableModes = parseAvailableModes();
    const modeId = resolveDefaultMode(availableModes);
    const availableModels = await parseAvailableModelsAsync();
    const modelId = await resolveDefaultModelAsync(availableModels);
    const availableCommands = parseAvailableCommands();
    const configOptions = await buildConfigOptionsAsync();
    const useClientTerminal = isTruthy(
      process.env.AUTOHAND_USE_CLIENT_TERMINAL,
    );

    // Store MCP servers from client for later use
    const mcpServers = parseMcpServers(params.mcpServers);

    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd: params.cwd,
      history: [],
      cancelled: false,
      updateQueue: Promise.resolve(),
      promptQueue: Promise.resolve({ stopReason: "end_turn" }),
      availableModes,
      modeId,
      availableModels,
      modelId,
      availableCommands,
      configOptions,
      toolCalls: new Map(),
      toolCallOutputs: new Map(),
      streamingToolCalls: new Set(),
      terminalToolCalls: new Set(),
      conversationOffset: 0,
      conversationRemainder: "",
      hasStructuredOutput: false,
      hasAgentResponse: false,
      stdoutFallbackActive: false,
      stdoutBuffer: "",
      rawStdoutForStats: "",
      useClientTerminal,
      autohandHome: resolveAutohandHome(),
      titleGenerated: false,
      mcpServers,
      interactionCount: 0,
      feedbackPending: false,
      feedbackShownThisSession: false,
      feedbackTriggerAt: generateFeedbackTrigger(),
      clientName: this.clientInfo?.name,
      clientVersion: this.clientInfo?.version,
      // Auto-mode state
      autoModeEnabled: isTruthy(process.env.AUTOHAND_AUTO_MODE),
      autoModeMaxIterations: parseInt(
        process.env.AUTOHAND_AUTO_MODE_MAX_ITERATIONS ?? "50",
        10,
      ),
      autoModeMaxRuntime: parseInt(
        process.env.AUTOHAND_AUTO_MODE_MAX_RUNTIME ?? "120",
        10,
      ),
      autoModeMaxCost: parseInt(
        process.env.AUTOHAND_AUTO_MODE_MAX_COST ?? "10",
        10,
      ),
      // Multi-directory support
      additionalDirs: [],
    });

    const response: NewSessionResponse = { sessionId };
    if (availableModes.length > 0) {
      response.modes = {
        availableModes,
        currentModeId: modeId,
      } as SessionModeState;
    }
    if (availableModels.length > 0) {
      response.models = {
        availableModels,
        currentModelId: modelId,
      } as SessionModelState;
    }
    if (configOptions.length > 0) {
      response.configOptions = configOptions;
    }

    // Track session start in telemetry
    const currentModel = availableModels.find((m) => m.modelId === modelId);
    void getTelemetryClient().startSession(
      sessionId,
      currentModel?.name || modelId,
    );

    // Send commands notification and welcome message AFTER the response is returned
    // Use setImmediate to ensure the response is sent first
    const session = this.sessions.get(sessionId);
    if (session) {
      setImmediate(async () => {
        void this.queueSessionUpdate(session, {
          sessionUpdate: "available_commands_update",
          availableCommands: availableCommands,
        });

        // Send welcome message with user's name
        const userInfo = await getUserInfo();
        const userName = userInfo?.name?.split(" ")[0] || "there";
        void this.queueSessionUpdate(session, {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Hey ${userName}! How can I help you today?`,
          },
        });
      });
    }

    return response;
  }

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
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

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse> {
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

  async unstable_setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams({
        message: "Unknown session id.",
        sessionId: params.sessionId,
      });
    }

    // Find and update the config option
    const configId = params.configId;
    const newValue = params.value;

    const option = session.configOptions.find((opt) => opt.id === configId);
    if (!option) {
      throw RequestError.invalidParams({
        message: "Unknown config option.",
        configId,
      });
    }

    // Update the current value
    option.currentValue = newValue;

    // Apply the config change to environment/state
    await this.applyConfigOption(session, configId, newValue);

    // Note: config_option_update is not a valid ACP notification type in Zed
    // The config options are returned in the response instead

    return { configOptions: session.configOptions };
  }

  async unstable_forkSession(
    params: ForkSessionRequest,
  ): Promise<ForkSessionResponse> {
    const parentSession = this.sessions.get(params.sessionId);
    if (!parentSession) {
      throw RequestError.invalidParams({
        message: "Unknown session id.",
        sessionId: params.sessionId,
      });
    }

    // Create a new session with copied state from parent
    const newSessionId = randomUUID();
    const mcpServers = parseMcpServers(params.mcpServers);

    this.sessions.set(newSessionId, {
      id: newSessionId,
      cwd: params.cwd,
      history: [...parentSession.history], // Copy history
      cancelled: false,
      updateQueue: Promise.resolve(),
      promptQueue: Promise.resolve({ stopReason: "end_turn" }),
      availableModes: [...parentSession.availableModes],
      modeId: parentSession.modeId,
      availableModels: [...parentSession.availableModels],
      modelId: parentSession.modelId,
      availableCommands: [...parentSession.availableCommands],
      configOptions: parentSession.configOptions.map((opt) => ({ ...opt })),
      toolCalls: new Map(),
      toolCallOutputs: new Map(),
      streamingToolCalls: new Set(),
      terminalToolCalls: new Set(),
      conversationOffset: 0,
      conversationRemainder: "",
      hasStructuredOutput: false,
      hasAgentResponse: false,
      stdoutFallbackActive: false,
      stdoutBuffer: "",
      rawStdoutForStats: "",
      useClientTerminal: parentSession.useClientTerminal,
      autohandHome: parentSession.autohandHome,
      titleGenerated: false,
      title: parentSession.title ? `${parentSession.title} (fork)` : undefined,
      parentSessionId: parentSession.id,
      mcpServers,
      interactionCount: 0,
      feedbackPending: false,
      feedbackShownThisSession: false,
      feedbackTriggerAt: generateFeedbackTrigger(),
      clientName: this.clientInfo?.name,
      clientVersion: this.clientInfo?.version,
      // Copy auto-mode state from parent
      autoModeEnabled: parentSession.autoModeEnabled,
      autoModeMaxIterations: parentSession.autoModeMaxIterations,
      autoModeMaxRuntime: parentSession.autoModeMaxRuntime,
      autoModeMaxCost: parentSession.autoModeMaxCost,
      // Copy additional directories from parent
      additionalDirs: [...parentSession.additionalDirs],
    });

    const forkedSession = this.sessions.get(newSessionId)!;

    const response: ForkSessionResponse = { sessionId: newSessionId };
    if (forkedSession.availableModes.length > 0) {
      response.modes = {
        availableModes: forkedSession.availableModes,
        currentModeId: forkedSession.modeId,
      } as SessionModeState;
    }
    if (forkedSession.availableModels.length > 0) {
      response.models = {
        availableModels: forkedSession.availableModels,
        currentModelId: forkedSession.modelId,
      } as SessionModelState;
    }
    if (forkedSession.configOptions.length > 0) {
      response.configOptions = forkedSession.configOptions;
    }

    // Notify about forked session
    await this.queueTextUpdate(
      forkedSession,
      `Forked from session ${parentSession.id.slice(0, 8)}. History preserved.\n`,
    );

    return response;
  }

  async unstable_resumeSession(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    const sessionIdToResume = params.sessionId;
    const autohandHome = resolveAutohandHome();
    const conversationPath = path.join(
      autohandHome,
      "sessions",
      sessionIdToResume,
      "conversation.jsonl",
    );

    // Check if session exists
    const sessions = await readSessionIndex(autohandHome);
    const existingSession = sessions.find((s) => s.id === sessionIdToResume);
    if (!existingSession) {
      throw RequestError.invalidParams({
        message: "Session not found.",
        sessionId: sessionIdToResume,
      });
    }

    const availableModes = parseAvailableModes();
    const modeId = resolveDefaultMode(availableModes);
    const availableModels = await parseAvailableModelsAsync();
    const modelId = await resolveDefaultModelAsync(availableModels);
    const configOptions = await buildConfigOptionsAsync();
    const useClientTerminal = isTruthy(
      process.env.AUTOHAND_USE_CLIENT_TERMINAL,
    );

    const mcpServers = parseMcpServers(params.mcpServers);

    // Create session state for the resumed session
    this.sessions.set(sessionIdToResume, {
      id: sessionIdToResume,
      cwd: params.cwd,
      history: [],
      cancelled: false,
      updateQueue: Promise.resolve(),
      promptQueue: Promise.resolve({ stopReason: "end_turn" }),
      availableModes,
      modeId,
      availableModels,
      modelId,
      availableCommands: parseAvailableCommands(),
      configOptions,
      toolCalls: new Map(),
      toolCallOutputs: new Map(),
      streamingToolCalls: new Set(),
      terminalToolCalls: new Set(),
      conversationPath,
      conversationOffset: 0,
      conversationRemainder: "",
      hasStructuredOutput: false,
      hasAgentResponse: false,
      stdoutFallbackActive: false,
      stdoutBuffer: "",
      rawStdoutForStats: "",
      useClientTerminal,
      autohandHome,
      titleGenerated: true, // Don't regenerate title for resumed sessions
      title: `Resumed: ${sessionIdToResume.slice(0, 8)}`,
      mcpServers,
      interactionCount: 0,
      feedbackPending: false,
      feedbackShownThisSession: false,
      feedbackTriggerAt: generateFeedbackTrigger(),
      clientName: this.clientInfo?.name,
      clientVersion: this.clientInfo?.version,
      // Auto-mode state (default values for resumed sessions)
      autoModeEnabled: isTruthy(process.env.AUTOHAND_AUTO_MODE),
      autoModeMaxIterations: parseInt(
        process.env.AUTOHAND_AUTO_MODE_MAX_ITERATIONS ?? "50",
        10,
      ),
      autoModeMaxRuntime: parseInt(
        process.env.AUTOHAND_AUTO_MODE_MAX_RUNTIME ?? "120",
        10,
      ),
      autoModeMaxCost: parseInt(
        process.env.AUTOHAND_AUTO_MODE_MAX_COST ?? "10",
        10,
      ),
      // Multi-directory support (empty for resumed sessions)
      additionalDirs: [],
    });

    // Note: session_info_update is not a valid ACP notification type in Zed
    // The title is set on the session object but we can't notify Zed about it

    const response: ResumeSessionResponse = {};
    if (availableModes.length > 0) {
      response.modes = {
        availableModes,
        currentModeId: modeId,
      } as SessionModeState;
    }
    if (availableModels.length > 0) {
      response.models = {
        availableModels,
        currentModelId: modelId,
      } as SessionModelState;
    }
    if (configOptions.length > 0) {
      response.configOptions = configOptions;
    }

    return response;
  }

  private async applyConfigOption(
    session: SessionState,
    configId: string,
    value: string,
  ): Promise<void> {
    // Persist to config file
    const persistValue = value === "enabled" ? true : value === "disabled" ? false : value;
    void saveExtensionSetting(configId, persistValue);

    switch (configId) {
      case "thinking_level":
        process.env.AUTOHAND_THINKING_LEVEL = value;
        break;
      case "auto_commit":
        if (value === "enabled") {
          process.env.AUTOHAND_AUTO_COMMIT = "1";
        } else {
          delete process.env.AUTOHAND_AUTO_COMMIT;
        }
        break;
      case "include_history":
        if (value === "enabled") {
          process.env.AUTOHAND_INCLUDE_HISTORY = "1";
        } else {
          delete process.env.AUTOHAND_INCLUDE_HISTORY;
        }
        break;
      case "auto_mode":
        session.autoModeEnabled = value === "enabled";
        if (session.autoModeEnabled) {
          // Auto-mode automatically switches to Unrestricted mode
          const previousMode = session.modeId;
          session.modeId = "unrestricted";
          process.env.AUTOHAND_AUTO_MODE = "1";
          // Notify client of mode change
          void this.queueSessionUpdate(session, {
            sessionUpdate: "current_mode_update" as const,
            currentModeId: "unrestricted",
          });
          void this.queueTextUpdate(
            session,
            `Auto-mode enabled. Switched from ${previousMode} to unrestricted mode.\n`,
          );
        } else {
          delete process.env.AUTOHAND_AUTO_MODE;
          void this.queueTextUpdate(session, "Auto-mode disabled.\n");
        }
        break;
      case "auto_mode_max_iterations":
        session.autoModeMaxIterations = parseInt(value, 10);
        process.env.AUTOHAND_AUTO_MODE_MAX_ITERATIONS = value;
        break;
      case "auto_mode_max_runtime":
        session.autoModeMaxRuntime = parseInt(value, 10);
        process.env.AUTOHAND_AUTO_MODE_MAX_RUNTIME = value;
        break;
      case "auto_mode_max_cost":
        session.autoModeMaxCost = parseInt(value, 10);
        process.env.AUTOHAND_AUTO_MODE_MAX_COST = value;
        break;
      case "temperature":
        process.env.AUTOHAND_TEMPERATURE = value;
        break;
      case "stream_output":
        if (value === "disabled") {
          process.env.AUTOHAND_NO_STREAM = "1";
        } else {
          delete process.env.AUTOHAND_NO_STREAM;
        }
        break;
      default:
        // Unknown config option, ignore
        break;
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams({
        message: "Unknown session id.",
        sessionId: params.sessionId,
      });
    }

    // Queue this prompt to run after any pending prompts complete
    const previousPrompt = session.promptQueue;
    const thisPrompt = previousPrompt.then(() =>
      this.executePrompt(session, params),
    );
    session.promptQueue = thisPrompt.catch(() => ({
      stopReason: "end_turn" as const,
    }));

    const result = await thisPrompt;
    return result;
  }

  private async executePrompt(
    session: SessionState,
    params: PromptRequest,
  ): Promise<PromptResponse> {
    if (!existsSync(session.cwd)) {
      await this.queueTextUpdate(
        session,
        `\n> **Error:** Workspace not found\n> \`${session.cwd}\`\n`,
      );
      return { stopReason: "end_turn" };
    }

    // Check authentication
    const isStub =
      process.env.AUTOHAND_CMD && existsSync(process.env.AUTOHAND_CMD);
    const isAuthenticated = isStub || (await checkAuthStatus());

    if (!isAuthenticated) {
      // Throw authRequired error to trigger Zed's auth flow
      throw RequestError.authRequired({
        message: "Please log in to use Autohand",
      });
    }

    const resolvedPrompt = await this.resolvePromptBlocks(
      session,
      params.prompt,
    );
    const userText = normalizePromptText(promptToText(resolvedPrompt));

    // Generate dynamic session title from first user message
    if (!session.titleGenerated && userText.trim()) {
      session.title = generateSessionTitle(userText);
      session.titleGenerated = true;
      // Note: session_info_update is not a valid ACP notification type in Zed
      // The title is stored locally but we can't notify Zed about it
    }

    // Check for slash commands
    const parsedCommand = parseSlashCommand(userText);
    if (parsedCommand) {
      const result = await this.handleSlashCommand(session, parsedCommand);
      if (result.handled) {
        return { stopReason: "end_turn" };
      }
      // If not handled, continue with regular flow (command passed to Autohand CLI)
    }

    // Build instruction with image support
    const instruction = buildInstruction(session, userText);

    // Track if prompt contains images (for future multimodal support)
    const hasImages = resolvedPrompt.some((block) => block.type === "image");
    if (hasImages) {
      // Note: Currently images are described as metadata in the instruction text.
      // Future enhancement: Pass image data directly to Autohand CLI when supported.
      console.error(
        `[ACP] Prompt includes ${resolvedPrompt.filter((b) => b.type === "image").length} image(s)`,
      );
    }

    session.history.push({ role: "user", content: userText });
    session.cancelled = false;
    session.hasStructuredOutput = false;
    session.hasAgentResponse = false;
    session.stdoutFallbackActive = false;
    session.stdoutBuffer = "";
    if (session.stdoutFallbackTimer) {
      clearTimeout(session.stdoutFallbackTimer);
      session.stdoutFallbackTimer = undefined;
    }

    // Start permission server if mode is external
    const permissionMode = (
      process.env.AUTOHAND_PERMISSION_MODE ?? DEFAULT_PERMISSION_MODE
    ).toLowerCase();
    let permissionCallbackUrl: string | undefined;
    if (permissionMode === "external") {
      try {
        session.permissionServer = await createPermissionServer({
          sessionId: session.id,
          client: this.client,
        });
        permissionCallbackUrl = session.permissionServer.url;
      } catch (error) {
        console.error("Failed to start permission server:", error);
      }
    }

    const sessionsSnapshot = await snapshotSessionIds(session.autohandHome);
    const { command, args, env, configPath } = buildAutohandCommand({
      cwd: session.cwd,
      instruction,
      modelId: session.modelId,
      modeId: session.modeId,
      autohandHome: session.autohandHome,
      permissionCallbackUrl,
      // Auto-mode options
      autoModeEnabled: session.autoModeEnabled,
      autoModeMaxIterations: session.autoModeMaxIterations,
      autoModeMaxRuntime: session.autoModeMaxRuntime,
      autoModeMaxCost: session.autoModeMaxCost,
      // Multi-directory support
      additionalDirs: session.additionalDirs,
    });

    // Add client identification to environment for session logging
    if (session.clientName) {
      env.AUTOHAND_CLIENT_NAME = session.clientName;
    }
    if (session.clientVersion) {
      env.AUTOHAND_CLIENT_VERSION = session.clientVersion;
    }

    if (configPath && !existsSync(configPath)) {
      await this.queueTextUpdate(
        session,
        `\n> **Warning:** Config not found at \`${configPath}\`\n> Run \`autohand\` once to create it or set \`AUTOHAND_CONFIG\`.\n`,
      );
    }

    const tailAbort = new AbortController();
    const tailPromise = this.trackConversation(
      session,
      sessionsSnapshot,
      tailAbort.signal,
    );

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

      // Clean up permission server
      if (session.permissionServer) {
        await session.permissionServer.stop().catch(() => {});
        session.permissionServer = undefined;
      }

      // Ensure all pending notifications are sent before returning
      await session.updateQueue.catch(() => {});

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

    const STDOUT_FALLBACK_DELAY_MS = 800;

    session.stdoutFallbackTimer = setTimeout(() => {
      if (!session.hasAgentResponse) {
        session.stdoutFallbackActive = true;
        if (session.stdoutBuffer) {
          void this.queueTextUpdate(session, session.stdoutBuffer);
          session.stdoutBuffer = "";
        }
      }
    }, STDOUT_FALLBACK_DELAY_MS);

    // Structured events (tool calls, thoughts, responses) come from conversation.jsonl
    // If conversation output doesn't show up quickly, fall back to stdout.
    let stderrOutput = "";
    const MAX_STDERR = 8000;

    const onStdout = (chunk: Buffer) => {
      let text = stripAnsi(chunk.toString("utf8"));
      if (!text) {
        return;
      }

      // Always buffer raw stdout for stats extraction after process exits
      // This avoids issues with stats line being split across chunks
      session.rawStdoutForStats += text;

      // Filter out hook events from stdout (they are CLI internal markers)
      if (text.match(/\[hook:[^\]]+\]/)) {
        return;
      }

      // Filter out CLI status messages and internal output
      if (
        text.match(/Turn complete:/i) ||
        text.match(/^Thinking:/i) ||
        text.match(/^→/i) ||
        text.match(/^Step \d+:/i) ||
        text.match(/Completed in/i) // Stats will be extracted from rawStdoutForStats later
      ) {
        return;
      }

      text = text
        .replace(/<\/?thinking>/gi, "")
        .replace(/<\/?reasoning>/gi, "");
      if (!text.trim()) {
        return;
      }

      // Skip structured JSON output (let conversation.jsonl handle these)
      const trimmedText = text.trim();
      if (
        (trimmedText.startsWith("{") && trimmedText.includes('"thought"')) ||
        (trimmedText.startsWith("{") &&
          trimmedText.includes('"finalResponse"')) ||
        (trimmedText.startsWith("{") && trimmedText.includes('"toolCalls"'))
      ) {
        return;
      }

      if (session.hasAgentResponse) {
        return;
      }

      if (session.stdoutFallbackActive) {
        void this.queueTextUpdate(session, text);
        return;
      }

      session.stdoutBuffer += text;
    };

    const onStderr = (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString("utf8"));
      if (stderrOutput.length < MAX_STDERR) {
        stderrOutput += text.slice(0, MAX_STDERR - stderrOutput.length);
      }
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);

    const exitResult = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolve) => {
      let resolved = false;
      const finish = (
        code: number | null,
        signal: NodeJS.Signals | null,
        error?: Error,
      ) => {
        if (!resolved) {
          resolved = true;
          resolve({ code, signal, error });
        }
      };
      child.on("close", (code, signal) => finish(code, signal));
      child.on("exit", (code, signal) => finish(code, signal));
      child.on("error", (error) => finish(1, null, error));
    });

    // Clean up streams and listeners
    child.stdout.off("data", onStdout);
    child.stderr.off("data", onStderr);
    child.stdout.destroy();
    child.stderr.destroy();
    if (session.stdoutFallbackTimer) {
      clearTimeout(session.stdoutFallbackTimer);
      session.stdoutFallbackTimer = undefined;
    }
    if (!session.hasAgentResponse && session.stdoutBuffer) {
      await this.queueTextUpdate(session, session.stdoutBuffer);
      session.stdoutBuffer = "";
    }

    session.activeProcess = undefined;
    tailAbort.abort();

    // Wait for tail with timeout to prevent hanging
    await Promise.race([
      tailPromise,
      sleep(2000), // 2 second timeout
    ]);

    if (session.cancelled) {
      await Promise.race([session.updateQueue.catch(() => {}), sleep(1000)]);
      return { stopReason: "cancelled" };
    }

    if (exitResult.error) {
      const isNotFound =
        (exitResult.error as NodeJS.ErrnoException).code === "ENOENT";
      if (isNotFound) {
        await this.queueTextUpdate(
          session,
          `\n> **Error:** Autohand CLI not found\n>\n> Please install Autohand CLI first:\n> \`\`\`\n> npm install -g @autohand-cli\n> \`\`\`\n>\n> Or visit: https://autohand.ai/cli/\n`,
        );
      } else {
        await this.queueTextUpdate(
          session,
          `\n> **Error:** Failed to launch Autohand\n> ${exitResult.error.message}\n`,
        );
      }
    }

    if (exitResult.code !== 0 && exitResult.code !== null) {
      let errorMsg = `\n> **Error:** Autohand exited with code ${exitResult.code}\n`;
      if (stderrOutput.trim()) {
        errorMsg += `>\n> \`\`\`\n> ${stderrOutput.trim().split("\n").join("\n> ")}\n> \`\`\`\n`;
      }
      await this.queueTextUpdate(session, errorMsg);
    }

    if (exitResult.signal) {
      let errorMsg = `\n> **Error:** Autohand terminated with signal ${exitResult.signal}\n`;
      if (stderrOutput.trim()) {
        errorMsg += `>\n> \`\`\`\n> ${stderrOutput.trim().split("\n").join("\n> ")}\n> \`\`\`\n`;
      }
      await this.queueTextUpdate(session, errorMsg);
    }

    // Clean up permission server
    if (session.permissionServer) {
      await session.permissionServer.stop().catch(() => {});
      session.permissionServer = undefined;
    }

    // Extract completion stats from buffered stdout (avoids chunking issues)
    const statsMatch = session.rawStdoutForStats.match(
      /Completed in ([^·\n]+)·?\s*([^·\n]*tokens[^\n]*)?/i,
    );
    if (statsMatch) {
      const time = statsMatch[1]?.trim() || "";
      const tokens = statsMatch[2]?.trim() || "";
      session.completionStats = tokens ? `${time} · ${tokens}` : time;
    }
    session.rawStdoutForStats = ""; // Clear buffer

    // Ensure all pending notifications are sent before returning
    // Use timeout to prevent hanging
    await Promise.race([session.updateQueue.catch(() => {}), sleep(2000)]);

    // Display completion stats if available (after draining main queue)
    if (session.completionStats) {
      this.queueTextUpdate(session, `\n_${session.completionStats}_\n`);
      session.completionStats = undefined;
      // Wait for stats to be sent before returning
      await Promise.race([session.updateQueue.catch(() => {}), sleep(1000)]);
    }

    // Track interaction and check for auto feedback prompt
    session.interactionCount++;
    await this.maybeShowFeedbackPrompt(session);

    // Final queue drain to ensure loading state stops properly
    await session.updateQueue.catch(() => {});

    return { stopReason: "end_turn" };
  }

  private async maybeShowFeedbackPrompt(session: SessionState): Promise<void> {
    // Only show feedback once per session
    if (session.feedbackShownThisSession) {
      return;
    }

    // Check if we've reached the trigger point for this session
    const triggerAt = session.feedbackTriggerAt ?? 10;
    if (session.interactionCount < triggerAt) {
      return;
    }

    // Check global cooldown (48 hours between prompts across sessions)
    if (session.lastFeedbackPrompt) {
      const lastPrompt = new Date(session.lastFeedbackPrompt).getTime();
      const hoursSince = (Date.now() - lastPrompt) / 1000 / 60 / 60;
      if (hoursSince < FEEDBACK_COOLDOWN_HOURS) {
        return;
      }
    }

    // Mark as shown for this session
    session.feedbackShownThisSession = true;
    session.lastFeedbackPrompt = new Date().toISOString();

    // Show feedback prompt with distinct styling
    const reminder = [
      "",
      "╔══════════════════════════════════════════════╗",
      "║  💭 How's your experience with Autohand?     ║",
      "║     Type /feedback to share your thoughts    ║",
      "╚══════════════════════════════════════════════╝",
      "",
    ];
    this.queueTextUpdate(session, reminder.join("\n"));
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      return;
    }

    session.cancelled = true;

    // Track session end in telemetry
    void getTelemetryClient().endSession("abandoned");

    // Clean up permission server
    if (session.permissionServer) {
      await session.permissionServer.stop().catch(() => {});
      session.permissionServer = undefined;
    }

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

  /**
   * Extension method handler for custom ACP requests.
   * Allows clients to send arbitrary requests that are not part of the ACP spec.
   */
  async extMethod(
    method: string,
    _params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Handle custom extension methods here
    // Currently no custom methods are implemented
    throw RequestError.methodNotFound(method);
  }

  /**
   * Extension notification handler for custom ACP notifications.
   * Allows clients to send arbitrary notifications that are not part of the ACP spec.
   */
  async extNotification(
    _method: string,
    _params: Record<string, unknown>,
  ): Promise<void> {
    // Handle custom extension notifications here
    // Currently no custom notifications are implemented
    // Notifications don't return errors, just silently ignore unknown ones
  }

  async unstable_listSessions(
    params: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const autohandHome = resolveAutohandHome();
    const allSessions = await readSessionIndex(autohandHome);

    // Filter by cwd if provided
    let filteredSessions = allSessions;
    if (params.cwd) {
      const resolvedCwd = path.resolve(params.cwd);
      filteredSessions = allSessions.filter(
        (s) => s.projectPath === resolvedCwd,
      );
    }

    // Sort by createdAt descending (most recent first)
    filteredSessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // Convert to SessionInfo format
    const sessions: SessionInfo[] = filteredSessions.map((s) => ({
      sessionId: s.id,
      cwd: s.projectPath,
      title: `Session ${s.id.slice(0, 8)}`,
      updatedAt: s.createdAt,
    }));

    return { sessions };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const loadSessionId = params.sessionId;

    // Read the conversation.jsonl from the session to get history
    const autohandHome = resolveAutohandHome();
    const conversationPath = path.join(
      autohandHome,
      "sessions",
      loadSessionId,
      "conversation.jsonl",
    );

    // Create a new internal session for tracking
    const availableModes = DEFAULT_MODES;
    const modeId = "default";
    const availableModels = await parseAvailableModelsAsync();
    const modelId = await resolveDefaultModelAsync(availableModels);
    const availableCommands = parseAvailableCommands();
    const configOptions = await buildConfigOptionsAsync();
    const useClientTerminal = isTruthy(
      process.env.AUTOHAND_USE_CLIENT_TERMINAL,
    );

    const mcpServers = parseMcpServers(params.mcpServers);

    // Use the provided sessionId for the loaded session
    this.sessions.set(loadSessionId, {
      id: loadSessionId,
      cwd: params.cwd,
      history: [],
      cancelled: false,
      updateQueue: Promise.resolve(),
      promptQueue: Promise.resolve({ stopReason: "end_turn" }),
      availableModes,
      modeId,
      availableModels,
      modelId,
      availableCommands,
      configOptions,
      toolCalls: new Map(),
      toolCallOutputs: new Map(),
      streamingToolCalls: new Set(),
      terminalToolCalls: new Set(),
      conversationOffset: 0,
      conversationRemainder: "",
      hasStructuredOutput: false,
      hasAgentResponse: false,
      stdoutFallbackActive: false,
      stdoutBuffer: "",
      rawStdoutForStats: "",
      useClientTerminal,
      autohandHome,
      titleGenerated: true, // Don't regenerate title for loaded sessions
      title: `Loaded: ${loadSessionId.slice(0, 8)}`,
      mcpServers,
      interactionCount: 0,
      feedbackPending: false,
      feedbackShownThisSession: false,
      feedbackTriggerAt: generateFeedbackTrigger(),
      clientName: this.clientInfo?.name,
      clientVersion: this.clientInfo?.version,
      // Auto-mode state (default values for loaded sessions)
      autoModeEnabled: isTruthy(process.env.AUTOHAND_AUTO_MODE),
      autoModeMaxIterations: parseInt(
        process.env.AUTOHAND_AUTO_MODE_MAX_ITERATIONS ?? "50",
        10,
      ),
      autoModeMaxRuntime: parseInt(
        process.env.AUTOHAND_AUTO_MODE_MAX_RUNTIME ?? "120",
        10,
      ),
      autoModeMaxCost: parseInt(
        process.env.AUTOHAND_AUTO_MODE_MAX_COST ?? "10",
        10,
      ),
      // Multi-directory support (empty for loaded sessions)
      additionalDirs: [],
    });

    const session = this.sessions.get(loadSessionId)!;

    // Load conversation history and replay it via notifications
    try {
      const content = await fs.readFile(conversationPath, "utf8");
      const lines = content.split("\n").filter((line) => line.trim());

      for (const line of lines) {
        try {
          const message = JSON.parse(line) as SessionMessage;

          // Replay user and assistant messages to client
          if (message.role === "user") {
            await this.queueSessionUpdate(session, {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: message.content },
            });
            session.history.push(message);
          } else if (message.role === "assistant" && message.content) {
            const parsed = parseAssistantContent(message.content);
            const toolCalls = Array.isArray(message.toolCalls)
              ? message.toolCalls
              : parsed.toolCalls;
            const responseText = resolveAssistantResponse(parsed, toolCalls);
            if (responseText) {
              await this.queueSessionUpdate(session, {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: responseText },
              });
              session.history.push({
                role: "assistant",
                content: responseText,
              });
            }
          }
        } catch {
          // Skip invalid JSON lines
        }
      }

      await this.queueTextUpdate(
        session,
        `\n--- Resumed session ${loadSessionId.slice(0, 8)} ---\n\n`,
      );
    } catch {
      await this.queueTextUpdate(session, `Session ${loadSessionId} loaded.\n`);
    }

    // Send available commands
    setImmediate(() => {
      void this.queueSessionUpdate(session, {
        sessionUpdate: "available_commands_update",
        availableCommands,
      });
    });

    return {};
  }

  private async handleSlashCommand(
    session: SessionState,
    parsed: { command: string; args: string[] },
  ): Promise<{ handled: boolean }> {
    const { command, args } = parsed;

    // Track command usage in telemetry
    void getTelemetryClient().trackCommand(command, args);

    // Handle /help locally
    if (command === "help" || command === "?") {
      const helpText = this.generateHelpText(session);
      await this.queueTextUpdate(session, helpText);
      return { handled: true };
    }

    // Handle /new - reset session
    if (command === "new") {
      session.history = [];
      session.toolCalls.clear();
      session.toolCallOutputs.clear();
      session.streamingToolCalls.clear();
      session.terminalToolCalls.clear();
      session.conversationPath = undefined;
      session.conversationOffset = 0;
      session.conversationRemainder = "";

      await this.queueTextUpdate(
        session,
        "Started a new conversation. History cleared.\n",
      );
      return { handled: true };
    }

    // Handle /model - show picker or set model
    if (command === "model") {
      if (args.length > 0) {
        const newModel = args.join(" ");
        const validModel = session.availableModels.find(
          (m) => m.modelId === newModel || m.name === newModel,
        );
        if (validModel) {
          session.modelId = validModel.modelId;
          await this.queueTextUpdate(
            session,
            `Model changed to: ${validModel.modelId}\n`,
          );
        } else {
          const available = session.availableModels
            .map((m) => m.modelId)
            .join(", ");
          await this.queueTextUpdate(
            session,
            `Unknown model: ${newModel}\nAvailable models: ${available || "(none configured)"}\n`,
          );
        }
      } else if (session.availableModels.length > 0) {
        // Show interactive model picker
        const selectedModel = await this.showModelPicker(session);
        if (selectedModel) {
          session.modelId = selectedModel;
          await this.queueTextUpdate(
            session,
            `Model changed to: ${selectedModel}\n`,
          );
        } else {
          await this.queueTextUpdate(session, "Model selection cancelled.\n");
        }
      } else {
        await this.queueTextUpdate(
          session,
          `Current model: ${session.modelId || "(default)"}\nNo models configured. Set AUTOHAND_AVAILABLE_MODELS to enable model selection.\n`,
        );
      }
      return { handled: true };
    }

    // Handle /mode - show picker or set mode
    if (command === "mode") {
      if (args.length > 0) {
        const newMode = args.join(" ");
        const validMode = session.availableModes.find(
          (m) =>
            m.id === newMode || m.name.toLowerCase() === newMode.toLowerCase(),
        );
        if (validMode) {
          session.modeId = validMode.id;
          await this.queueTextUpdate(
            session,
            `Mode changed to: ${validMode.name}\n`,
          );
        } else {
          const available = session.availableModes.map((m) => m.id).join(", ");
          await this.queueTextUpdate(
            session,
            `Unknown mode: ${newMode}\nAvailable modes: ${available}\n`,
          );
        }
      } else if (session.availableModes.length > 0) {
        // Show interactive mode picker
        const selectedMode = await this.showModePicker(session);
        if (selectedMode) {
          session.modeId = selectedMode;
          const modeName =
            session.availableModes.find((m) => m.id === selectedMode)?.name ??
            selectedMode;
          await this.queueTextUpdate(session, `Mode changed to: ${modeName}\n`);
        } else {
          await this.queueTextUpdate(session, "Mode selection cancelled.\n");
        }
      } else {
        await this.queueTextUpdate(
          session,
          `Current mode: ${session.modeId}\n`,
        );
      }
      return { handled: true };
    }

    // Handle /resume or /threads - spawn autohand resume command or show session picker
    if (command === "resume" || command === "threads") {
      const allSessions = await readSessionIndex(session.autohandHome);

      // Filter to sessions for this project, or show all if none match
      const resolvedCwd = path.resolve(session.cwd);
      let sessions = allSessions.filter((s) => s.projectPath === resolvedCwd);
      if (sessions.length === 0) {
        sessions = allSessions; // Fall back to all sessions
      }

      if (sessions.length === 0) {
        await this.queueTextUpdate(session, "No sessions found to resume.\n");
        return { handled: true };
      }

      // If no argument, show numbered list for selection
      if (args.length === 0) {
        const lines = sessions.slice(0, 10).map((s, i) => {
          const date = s.createdAt.split("T")[0];
          const proj = path.basename(s.projectPath);
          return `  ${i + 1}. ${s.id.slice(0, 8)} - ${proj} (${date})`;
        });
        await this.queueTextUpdate(
          session,
          `Select a session to resume:\n${lines.join("\n")}\n\nType /resume <number> or /resume <session-id>\n`,
        );
        return { handled: true };
      }

      // User provided an argument - could be number (1-10) or session ID
      const arg = args[0];
      let sessionIdToResume: string;

      const num = parseInt(arg, 10);
      if (!isNaN(num) && num >= 1 && num <= sessions.length) {
        sessionIdToResume = sessions[num - 1].id;
      } else {
        // Try to match by partial or full session ID
        const match = sessions.find(
          (s) => s.id === arg || s.id.startsWith(arg),
        );
        if (match) {
          sessionIdToResume = match.id;
        } else {
          await this.queueTextUpdate(
            session,
            `\n> **Error:** Session not found: \`${arg}\`\n`,
          );
          return { handled: true };
        }
      }

      return this.runAutohandResume(session, sessionIdToResume);
    }

    // Handle /sessions - list recent sessions
    if (command === "sessions") {
      const sessions = await readSessionIndex(session.autohandHome);
      if (sessions.length === 0) {
        await this.queueTextUpdate(session, "No sessions found.\n");
      } else {
        const lines = sessions
          .slice(0, 10)
          .map(
            (s) => `  ${s.id.slice(0, 8)}  ${s.createdAt}  ${s.projectPath}`,
          );
        await this.queueTextUpdate(
          session,
          `Recent sessions:\n${lines.join("\n")}\n`,
        );
      }
      return { handled: true };
    }

    // Handle /session - show current session info
    if (command === "session") {
      const info = [
        `Session ID: ${session.id}`,
        `Workspace: ${session.cwd}`,
        `Model: ${session.modelId || "(default)"}`,
        `Mode: ${session.modeId}`,
        `History entries: ${session.history.length}`,
        `Tool calls tracked: ${session.toolCalls.size}`,
      ];
      await this.queueTextUpdate(session, info.join("\n") + "\n");
      return { handled: true };
    }

    // Handle /status - show Autohand status
    if (command === "status") {
      const configPath =
        process.env.AUTOHAND_CONFIG ??
        path.join(os.homedir(), ".autohand", "config.json");
      const hasConfig = existsSync(configPath);
      const autohandCmd = process.env.AUTOHAND_CMD ?? "autohand";

      const status = [
        `Autohand command: ${autohandCmd}`,
        `Config file: ${configPath} (${hasConfig ? "exists" : "not found"})`,
        `Permission mode: ${process.env.AUTOHAND_PERMISSION_MODE ?? DEFAULT_PERMISSION_MODE}`,
        `Session workspace: ${session.cwd}`,
      ];
      await this.queueTextUpdate(session, status.join("\n") + "\n");
      return { handled: true };
    }

    // Handle /feedback - spawn terminal for interactive feedback
    if (command === "feedback") {
      // Check if client supports terminal
      if (!this.clientCapabilities?.terminal) {
        await this.queueTextUpdate(
          session,
          "Terminal not supported. Please run `autohand feedback` in your terminal.\n",
        );
        return { handled: true };
      }

      // Spawn terminal for feedback
      const { command, baseArgs } = findAutohandBinary();
      try {
        await this.queueTextUpdate(session, "Opening feedback terminal...\n");

        const terminal = await this.client.createTerminal({
          sessionId: session.id,
          command,
          args: [...baseArgs, "-p", "/feedback"],
          title: "Autohand Feedback",
          cwd: session.cwd,
        });

        // Wait for terminal to complete in background
        terminal
          .waitForExit()
          .then(async (result) => {
            await terminal.release();
            if (result.exitCode === 0) {
              this.queueTextUpdate(
                session,
                "✅ Thank you for your feedback!\n",
              );
            }
          })
          .catch(() => {
            // Ignore errors - user may have closed terminal
          });

        return { handled: true };
      } catch {
        await this.queueTextUpdate(
          session,
          `Failed to open feedback terminal. Please run \`autohand feedback\` in your terminal.\n`,
        );
        return { handled: true };
      }
    }

    // Handle /automode - toggle or control auto-mode
    if (command === "automode") {
      const subcommand = args[0]?.toLowerCase();

      if (
        subcommand === "start" ||
        subcommand === "on" ||
        subcommand === "enable"
      ) {
        if (session.autoModeEnabled) {
          await this.queueTextUpdate(
            session,
            "Auto-mode is already enabled.\n",
          );
        } else {
          await this.applyConfigOption(session, "auto_mode", "enabled");
        }
        return { handled: true };
      }

      if (
        subcommand === "stop" ||
        subcommand === "off" ||
        subcommand === "disable"
      ) {
        if (!session.autoModeEnabled) {
          await this.queueTextUpdate(session, "Auto-mode is not enabled.\n");
        } else {
          await this.applyConfigOption(session, "auto_mode", "disabled");
        }
        return { handled: true };
      }

      if (subcommand === "status" || !subcommand) {
        const status = session.autoModeEnabled ? "enabled" : "disabled";
        const statusLines = [
          `Auto-mode: ${status}`,
          `Max iterations: ${session.autoModeMaxIterations}`,
          `Max runtime: ${session.autoModeMaxRuntime} minutes`,
          `Max cost: $${session.autoModeMaxCost}`,
          `Current mode: ${session.modeId}`,
        ];
        await this.queueTextUpdate(session, statusLines.join("\n") + "\n");
        return { handled: true };
      }

      await this.queueTextUpdate(
        session,
        "Usage: /automode [start|stop|status]\n",
      );
      return { handled: true };
    }

    // Handle /add-dir - add additional working directory
    if (command === "add-dir" || command === "adddir") {
      if (args.length === 0) {
        if (session.additionalDirs.length === 0) {
          await this.queueTextUpdate(
            session,
            "No additional directories added.\nUsage: /add-dir <path>\n",
          );
        } else {
          const dirList = session.additionalDirs
            .map((d, i) => `  ${i + 1}. ${d}`)
            .join("\n");
          await this.queueTextUpdate(
            session,
            `Additional directories:\n${dirList}\n`,
          );
        }
        return { handled: true };
      }

      const dirPath = args.join(" "); // Handle paths with spaces
      const absolutePath = path.isAbsolute(dirPath)
        ? dirPath
        : path.resolve(session.cwd, dirPath);

      if (!existsSync(absolutePath)) {
        await this.queueTextUpdate(
          session,
          `Directory not found: ${absolutePath}\n`,
        );
        return { handled: true };
      }

      if (session.additionalDirs.includes(absolutePath)) {
        await this.queueTextUpdate(
          session,
          `Directory already added: ${absolutePath}\n`,
        );
        return { handled: true };
      }

      session.additionalDirs.push(absolutePath);
      await this.queueTextUpdate(session, `Added directory: ${absolutePath}\n`);
      return { handled: true };
    }

    // Handle /remove-dir - remove additional working directory
    if (command === "remove-dir" || command === "removedir") {
      if (args.length === 0) {
        await this.queueTextUpdate(
          session,
          "Usage: /remove-dir <path or number>\n",
        );
        return { handled: true };
      }

      const arg = args.join(" ");
      const num = parseInt(arg, 10);

      if (!isNaN(num) && num >= 1 && num <= session.additionalDirs.length) {
        const removed = session.additionalDirs.splice(num - 1, 1)[0];
        await this.queueTextUpdate(session, `Removed directory: ${removed}\n`);
        return { handled: true };
      }

      const absolutePath = path.isAbsolute(arg)
        ? arg
        : path.resolve(session.cwd, arg);
      const index = session.additionalDirs.indexOf(absolutePath);
      if (index >= 0) {
        session.additionalDirs.splice(index, 1);
        await this.queueTextUpdate(
          session,
          `Removed directory: ${absolutePath}\n`,
        );
      } else {
        await this.queueTextUpdate(
          session,
          `Directory not found in list: ${absolutePath}\n`,
        );
      }
      return { handled: true };
    }

    // Handle /skills - manage skills
    if (command === "skills") {
      const subcommand = args[0]?.toLowerCase();

      if (!subcommand || subcommand === "list") {
        // List installed skills - pass to CLI
        return { handled: false };
      }

      if (subcommand === "install") {
        const skillName = args.slice(1).join(" ");
        if (!skillName) {
          await this.queueTextUpdate(
            session,
            "Usage: /skills install <skill-name>\n",
          );
          return { handled: true };
        }
        // Pass to CLI to handle installation
        return { handled: false };
      }

      if (subcommand === "remove" || subcommand === "uninstall") {
        const skillName = args.slice(1).join(" ");
        if (!skillName) {
          await this.queueTextUpdate(
            session,
            "Usage: /skills remove <skill-name>\n",
          );
          return { handled: true };
        }
        // Pass to CLI to handle removal
        return { handled: false };
      }

      await this.queueTextUpdate(
        session,
        "Usage: /skills [list|install <name>|remove <name>]\n",
      );
      return { handled: true };
    }

    // Handle /memory - manage conversation memory
    if (command === "memory") {
      const subcommand = args[0]?.toLowerCase();

      if (!subcommand || subcommand === "list") {
        // List memories - pass to CLI
        return { handled: false };
      }

      if (subcommand === "save" || subcommand === "add") {
        const key = args[1];
        const value = args.slice(2).join(" ");
        if (!key || !value) {
          await this.queueTextUpdate(
            session,
            "Usage: /memory save <key> <value>\n",
          );
          return { handled: true };
        }
        // Pass to CLI to handle save
        return { handled: false };
      }

      if (subcommand === "recall" || subcommand === "get") {
        const key = args[1];
        if (!key) {
          await this.queueTextUpdate(session, "Usage: /memory recall <key>\n");
          return { handled: true };
        }
        // Pass to CLI to handle recall
        return { handled: false };
      }

      if (subcommand === "delete" || subcommand === "remove") {
        const key = args[1];
        if (!key) {
          await this.queueTextUpdate(session, "Usage: /memory delete <key>\n");
          return { handled: true };
        }
        // Pass to CLI to handle delete
        return { handled: false };
      }

      await this.queueTextUpdate(
        session,
        "Usage: /memory [list|save <key> <value>|recall <key>|delete <key>]\n",
      );
      return { handled: true };
    }

    // Commands that should be passed to Autohand CLI
    // Return handled: false to continue with regular prompt flow
    return { handled: false };
  }

  private async submitUserFeedback(
    session: SessionState,
    rating: number,
    comment: string | undefined,
    triggerType: "manual" | "auto_prompt",
  ): Promise<boolean> {
    const feedback: FeedbackResponse = {
      npsScore: rating,
      reason: comment,
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      triggerType,
    };

    session.lastFeedbackPrompt = new Date().toISOString();
    return submitFeedback(feedback);
  }

  private generateHelpText(session: SessionState): string {
    const lines = ["Available commands:", ""];

    for (const cmd of session.availableCommands) {
      lines.push(`  /${cmd.name.padEnd(12)} ${cmd.description}`);
    }

    lines.push("");
    lines.push(
      "File mentions: Use @filename to include file content in your prompt",
    );
    lines.push("");

    return lines.join("\n") + "\n";
  }

  private async runAutohandResume(
    session: SessionState,
    sessionIdToResume: string,
  ): Promise<{ handled: boolean }> {
    const autohandCmd = process.env.AUTOHAND_CMD ?? "autohand";
    const configPath =
      process.env.AUTOHAND_CONFIG ??
      path.join(os.homedir(), ".autohand", "config.json");

    const args = [
      "resume",
      sessionIdToResume,
      "--config",
      configPath,
      "--path",
      session.cwd,
    ];

    if (session.modelId) {
      args.push("--model", session.modelId);
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AUTOHAND_NO_BANNER: "1",
      AUTOHAND_NON_INTERACTIVE: "1",
      CI: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      TERM: "dumb",
      AUTOHAND_HOME: session.autohandHome,
    };

    const child = spawn(autohandCmd, args, {
      cwd: session.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    session.activeProcess = child;

    let output = "";

    const onChunk = (chunk: Buffer) => {
      const raw = chunk.toString("utf8");
      const text = stripAnsi(raw);
      output += text;
      if (text) {
        void this.queueTextUpdate(session, text);
      }
    };

    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });

    session.activeProcess = undefined;

    if (output.trim()) {
      session.history.push({ role: "assistant", content: output.trim() });
    }

    return { handled: true };
  }

  private async showModelPicker(session: SessionState): Promise<string | null> {
    if (session.availableModels.length === 0) {
      return null;
    }

    const options: Array<{
      optionId: string;
      name: string;
      kind: "allow_once" | "reject_once";
    }> = session.availableModels.map((m) => ({
      optionId: m.modelId,
      name: m.name || m.modelId,
      kind: "allow_once" as const,
    }));

    // Add cancel option
    options.push({
      optionId: "__cancel__",
      name: "Cancel",
      kind: "reject_once",
    });

    try {
      const response = await this.client.requestPermission({
        sessionId: session.id,
        options,
        _meta: {
          title: "Select a model",
          description: `Current model: ${session.modelId || "(default)"}`,
        },
      });

      if (response.outcome.outcome === "cancelled") {
        return null;
      }

      if (response.outcome.outcome === "selected") {
        const selectedId = response.outcome.optionId;
        if (selectedId === "__cancel__") {
          return null;
        }
        return selectedId;
      }

      return null;
    } catch {
      return null;
    }
  }

  private async showModePicker(session: SessionState): Promise<string | null> {
    if (session.availableModes.length === 0) {
      return null;
    }

    const options: Array<{
      optionId: string;
      name: string;
      kind: "allow_once" | "reject_once";
    }> = session.availableModes.map((m) => ({
      optionId: m.id,
      name: `${m.name}${m.description ? ` - ${m.description}` : ""}`,
      kind: "allow_once" as const,
    }));

    // Add cancel option
    options.push({
      optionId: "__cancel__",
      name: "Cancel",
      kind: "reject_once",
    });

    try {
      const response = await this.client.requestPermission({
        sessionId: session.id,
        options,
        _meta: {
          title: "Select a mode",
          description: `Current mode: ${session.modeId}`,
        },
      });

      if (response.outcome.outcome === "cancelled") {
        return null;
      }

      if (response.outcome.outcome === "selected") {
        const selectedId = response.outcome.optionId;
        if (selectedId === "__cancel__") {
          return null;
        }
        return selectedId;
      }

      return null;
    } catch {
      return null;
    }
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

    // Disable stdout fallback immediately when we find conversation.jsonl
    // This prevents duplicate messages from stdout racing with conversation.jsonl
    session.hasStructuredOutput = true;
    session.stdoutFallbackActive = false;
    if (session.stdoutFallbackTimer) {
      clearTimeout(session.stdoutFallbackTimer);
      session.stdoutFallbackTimer = undefined;
    }
    session.stdoutBuffer = "";

    if (session.conversationPath !== conversationPath) {
      session.conversationOffset = 0;
      session.conversationRemainder = "";
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

    // Read only new bytes from the file using file handle with position
    const CHUNK_SIZE = 64 * 1024; // 64KB chunks
    let fileHandle: fs.FileHandle | undefined;

    try {
      fileHandle = await fs.open(session.conversationPath, "r");
      const stats = await fileHandle.stat();

      if (stats.size <= session.conversationOffset) {
        return;
      }

      const bytesToRead = Math.min(
        stats.size - session.conversationOffset,
        CHUNK_SIZE,
      );
      const buffer = Buffer.alloc(bytesToRead);

      const { bytesRead } = await fileHandle.read(
        buffer,
        0,
        bytesToRead,
        session.conversationOffset,
      );

      if (bytesRead === 0) {
        return;
      }

      session.conversationOffset += bytesRead;
      const slice = buffer.toString("utf8", 0, bytesRead);

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
    } catch {
      return;
    } finally {
      if (fileHandle) {
        await fileHandle.close().catch(() => {});
      }
    }
  }

  private async handleSessionMessage(
    session: SessionState,
    message: SessionMessage,
  ): Promise<void> {
    if (message.role === "assistant") {
      const parsed = message.content
        ? parseAssistantContent(message.content)
        : null;
      const toolCalls = Array.isArray(message.toolCalls)
        ? message.toolCalls
        : parsed?.toolCalls;
      const markStructuredOutput = () => {
        if (session.hasStructuredOutput) {
          return;
        }
        session.hasStructuredOutput = true;
        session.stdoutFallbackActive = false;
        if (session.stdoutFallbackTimer) {
          clearTimeout(session.stdoutFallbackTimer);
          session.stdoutFallbackTimer = undefined;
        }
      };
      const markAgentResponse = () => {
        if (session.hasAgentResponse) {
          return;
        }
        session.hasAgentResponse = true;
        session.stdoutFallbackActive = false;
        if (session.stdoutFallbackTimer) {
          clearTimeout(session.stdoutFallbackTimer);
          session.stdoutFallbackTimer = undefined;
        }
        session.stdoutBuffer = "";
      };

      const usesThoughtAsResponse = shouldUseThoughtAsResponse(
        parsed,
        toolCalls,
      );
      if (
        !usesThoughtAsResponse &&
        parsed?.thought &&
        hasText(parsed.thought)
      ) {
        markStructuredOutput();
        await this.queueThoughtUpdate(session, parsed.thought);
      }

      const responseText = parsed
        ? resolveAssistantResponse(parsed, toolCalls)
        : null;
      if (responseText) {
        markStructuredOutput();
        markAgentResponse();
        await this.queueTextUpdate(session, responseText + "\n");
        session.history.push({ role: "assistant", content: responseText });
      }

      // Handle tool calls
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          await this.handleToolCallStart(session, call);
        }
      }
    }

    if (message.role === "tool") {
      const stream = message._meta?.stream;
      if (stream === "stdout" || stream === "stderr") {
        await this.handleToolCallOutputDelta(session, message, stream);
        return;
      }
      await this.handleToolCallResult(session, message);
    }
  }

  private async handleToolCallStart(
    session: SessionState,
    call: ToolCallRecord,
  ): Promise<void> {
    const tool = call.tool ?? "tool";
    const toolCallId = call.id ?? randomUUID();
    const kind = TOOL_KIND_MAP[tool] ?? "other";
    const title = buildToolTitle(tool, call.args);
    const isCommand = tool === "run_command";
    const supportsTerminalOutput = isCommand && this.supportsTerminalOutput();

    const toolCall: ToolCall = {
      toolCallId,
      title,
      kind,
      status: isCommand ? "in_progress" : "pending",
      rawInput: call.args,
      locations: resolveLocations(call.args),
      content: supportsTerminalOutput
        ? [
            {
              type: "terminal",
              terminalId: toolCallId,
            },
          ]
        : undefined,
      _meta: supportsTerminalOutput
        ? {
            terminal_info: {
              terminal_id: toolCallId,
              cwd: session.cwd,
            },
          }
        : undefined,
    };

    session.toolCalls.set(toolCallId, toolCall);
    if (supportsTerminalOutput) {
      session.terminalToolCalls.add(toolCallId);
    }
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

  private async handleToolCallOutputDelta(
    session: SessionState,
    message: SessionMessage,
    stream: "stdout" | "stderr",
  ): Promise<void> {
    const toolCallId = message.tool_call_id ?? randomUUID();
    const chunk = message.content ?? "";
    if (!chunk) {
      return;
    }

    session.streamingToolCalls.add(toolCallId);

    if (!session.toolCalls.has(toolCallId) && message.name) {
      const fallback: ToolCall = {
        toolCallId,
        title: message.name,
        kind: TOOL_KIND_MAP[message.name] ?? "other",
        status: "in_progress",
      };
      session.toolCalls.set(toolCallId, fallback);
      await this.queueSessionUpdate(session, {
        sessionUpdate: "tool_call",
        ...fallback,
      });
    }

    if (session.terminalToolCalls.has(toolCallId)) {
      const update: ToolCallUpdate = {
        toolCallId,
        status: "in_progress",
        _meta: {
          terminal_output: {
            terminal_id: toolCallId,
            data: chunk,
            stream,
          },
        },
      };

      await this.queueSessionUpdate(session, {
        sessionUpdate: "tool_call_update",
        ...update,
      });
      return;
    }

    const current = session.toolCallOutputs.get(toolCallId) ?? "";
    const next = current + chunk;
    session.toolCallOutputs.set(toolCallId, next);

    const update: ToolCallUpdate = {
      toolCallId,
      status: "in_progress",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: next,
          },
        },
      ],
    };

    await this.queueSessionUpdate(session, {
      sessionUpdate: "tool_call_update",
      ...update,
    });
  }

  private async handleToolCallResult(
    session: SessionState,
    message: SessionMessage,
  ): Promise<void> {
    const toolCallId = message.tool_call_id ?? randomUUID();
    const outputText = message.content ?? "";
    const failed = /error|failed|exception/i.test(outputText);
    const isStreaming = session.streamingToolCalls.has(toolCallId);
    const usesTerminal = session.terminalToolCalls.has(toolCallId);
    const bufferedOutput = session.toolCallOutputs.get(toolCallId);

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

    const contentText =
      usesTerminal && isStreaming
        ? undefined
        : isStreaming
          ? (bufferedOutput ?? outputText)
          : outputText;

    const update: ToolCallUpdate = {
      toolCallId,
      status: failed ? "failed" : "completed",
      rawOutput: outputText,
      content: contentText
        ? [
            {
              type: "content",
              content: {
                type: "text",
                text: contentText,
              },
            },
          ]
        : undefined,
    };

    await this.queueSessionUpdate(session, {
      sessionUpdate: "tool_call_update",
      ...update,
    });

    session.toolCallOutputs.delete(toolCallId);
    session.streamingToolCalls.delete(toolCallId);
    session.terminalToolCalls.delete(toolCallId);
  }

  private supportsTerminalOutput(): boolean {
    return Boolean(this.clientCapabilities?.terminal);
  }

  private async resolvePromptBlocks(
    session: SessionState,
    prompt: ContentBlock[],
  ): Promise<ContentBlock[]> {
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

      // Resolve path relative to session cwd if not absolute
      const absolutePath = path.isAbsolute(pathFromUri)
        ? pathFromUri
        : path.resolve(session.cwd, pathFromUri);

      // Try ACP readTextFile first, then fall back to direct file read
      let content: string | null = null;

      if (this.clientCapabilities?.fs?.readTextFile) {
        try {
          const response = await this.client.readTextFile({
            sessionId: session.id,
            path: absolutePath,
          });
          content = response.content;
        } catch {
          // Fall through to direct read
        }
      }

      if (content === null) {
        // Use delegated file read (tries client first, then direct)
        content = await this.delegatedReadFile(session, absolutePath);
        if (content === null) {
          // Keep as resource_link if we can't read
          resolved.push(block);
          continue;
        }
      }

      resolved.push({
        type: "resource",
        resource: {
          uri: block.uri,
          text: content,
          mimeType: block.mimeType ?? "text/plain",
        },
      });
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

  private queueThoughtUpdate(
    session: SessionState,
    thought: string,
  ): Promise<void> {
    const chunks = chunkText(thought, MAX_UPDATE_CHUNK);

    session.updateQueue = session.updateQueue
      .catch(() => undefined)
      .then(async () => {
        for (const chunk of chunks) {
          const notification: SessionNotification = {
            sessionId: session.id,
            update: {
              sessionUpdate: "agent_thought_chunk",
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

  /**
   * Forward hook events to the client via agent_thought_chunk with metadata.
   * Hook events include: session-start, session-end, pre-tool, post-tool,
   * file-modified, automode:start, automode:iteration, automode:checkpoint, automode:complete
   */
  private forwardHookEvent(
    session: SessionState,
    hookEvent: string,
    rawOutput: string,
  ): Promise<void> {
    // Parse the hook event and any associated data
    const [eventType, ...dataParts] = hookEvent.split(":");
    const eventData = dataParts.join(":").trim();

    // Build metadata for the hook event
    const hookMeta: Record<string, unknown> = {
      hook: true,
      event: eventType,
      timestamp: new Date().toISOString(),
    };

    // Parse event-specific data
    if (eventType === "pre-tool" || eventType === "post-tool") {
      // Format: [hook:pre-tool:tool_name]
      hookMeta.tool = eventData;
    } else if (eventType === "file-modified") {
      // Format: [hook:file-modified:filepath]
      hookMeta.file = eventData;
    } else if (eventType === "automode") {
      // Format: [hook:automode:action:data]
      const [action, ...actionData] = eventData.split(":");
      hookMeta.action = action;
      if (actionData.length > 0) {
        hookMeta.data = actionData.join(":");
      }
    }

    session.updateQueue = session.updateQueue
      .catch(() => undefined)
      .then(async () => {
        const notification: SessionNotification = {
          sessionId: session.id,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: `[Hook: ${hookEvent}]`,
            },
            _meta: hookMeta,
          },
        };
        await this.client.sessionUpdate(notification);
      });

    return session.updateQueue;
  }

  /**
   * Delegate file read to client if supported, otherwise read directly.
   */
  private async delegatedReadFile(
    session: SessionState,
    filePath: string,
  ): Promise<string | null> {
    // Try client-delegated read first
    if (this.clientCapabilities?.fs?.readTextFile) {
      try {
        const response = await this.client.readTextFile({
          sessionId: session.id,
          path: filePath,
        });
        return response.content;
      } catch {
        // Fall through to direct read
      }
    }

    // Direct file read
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Delegate file write to client if supported, otherwise write directly.
   */
  private async delegatedWriteFile(
    session: SessionState,
    filePath: string,
    content: string,
  ): Promise<boolean> {
    // Try client-delegated write first
    if (this.clientCapabilities?.fs?.writeTextFile) {
      try {
        await this.client.writeTextFile({
          sessionId: session.id,
          path: filePath,
          content,
        });
        return true;
      } catch {
        // Fall through to direct write
      }
    }

    // Direct file write
    try {
      await fs.writeFile(filePath, content, "utf8");
      return true;
    } catch {
      return false;
    }
  }
}

function hasText(value?: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseAssistantContent(raw: string): ParsedAssistantContent {
  const trimmed = raw.trim();
  if (!hasText(trimmed)) {
    return { raw, structured: false };
  }

  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return { raw, response: raw, structured: false };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { raw, response: raw, structured: false };
    }

    const record = parsed as Record<string, unknown>;
    const structured =
      "thought" in record ||
      "toolCalls" in record ||
      "finalResponse" in record ||
      "response" in record;

    if (!structured) {
      return { raw, response: raw, structured: false };
    }

    return {
      raw,
      structured: true,
      thought: typeof record.thought === "string" ? record.thought : undefined,
      response:
        typeof record.finalResponse === "string"
          ? record.finalResponse
          : typeof record.response === "string"
            ? record.response
            : undefined,
      toolCalls: Array.isArray(record.toolCalls)
        ? (record.toolCalls as ToolCallRecord[])
        : undefined,
    };
  } catch {
    return { raw, response: raw, structured: false };
  }
}

function resolveAssistantResponse(
  parsed: ParsedAssistantContent,
  toolCalls?: ToolCallRecord[] | null,
): string | null {
  if (hasText(parsed.response)) {
    return parsed.response;
  }

  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  if (!hasToolCalls && hasText(parsed.thought)) {
    return parsed.thought;
  }

  if (!parsed.structured && hasText(parsed.raw)) {
    return parsed.raw;
  }

  return null;
}

function shouldUseThoughtAsResponse(
  parsed: ParsedAssistantContent | null,
  toolCalls?: ToolCallRecord[] | null,
): boolean {
  if (!parsed) {
    return false;
  }
  if (hasText(parsed.response)) {
    return false;
  }
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  return !hasToolCalls && hasText(parsed.thought);
}

function promptToText(prompt: ContentBlock[]): string {
  const parts: string[] = [];
  let imageCount = 0;

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
          const header = resource.uri
            ? `[resource: ${resource.uri}]`
            : "[resource]";
          parts.push(`${header}\n${resource.text}`.trim());
        } else {
          const uri = "uri" in resource ? resource.uri : "unknown";
          parts.push(`[resource: ${uri}] (binary content omitted)`);
        }
        break;
      }
      case "image": {
        imageCount++;
        // For images, include metadata and notify about the image
        // The actual base64 data is available in block.data
        const imageInfo = [
          `[Image ${imageCount}]`,
          `  Type: ${block.mimeType ?? "image/png"}`,
        ];
        if (block.uri) {
          imageInfo.push(`  URI: ${block.uri}`);
        }
        // Include a truncated preview of the data length
        if (block.data) {
          const sizeKB = Math.round((block.data.length * 3) / 4 / 1024);
          imageInfo.push(`  Size: ~${sizeKB}KB`);
        }
        parts.push(imageInfo.join("\n"));
        break;
      }
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
  const historyLimit = Number.isNaN(historyLimitRaw)
    ? DEFAULT_HISTORY_LIMIT
    : historyLimitRaw;
  const maxChars = Number.isNaN(maxCharsRaw)
    ? DEFAULT_MAX_HISTORY_CHARS
    : maxCharsRaw;

  const history = session.history.slice(-Math.max(0, historyLimit));
  const historyText = history
    .map(
      (entry) =>
        `${entry.role === "user" ? "User" : "Assistant"}: ${entry.content}`,
    )
    .join("\n\n");

  const combined = `Conversation context:\n${historyText}\n\nCurrent request:\n${requestText}`;
  return truncateText(combined, maxChars);
}

function buildAutohandCommand(options: {
  cwd: string;
  instruction: string;
  modelId: string;
  modeId: string;
  autohandHome: string;
  permissionCallbackUrl?: string;
  // Auto-mode options
  autoModeEnabled?: boolean;
  autoModeMaxIterations?: number;
  autoModeMaxRuntime?: number;
  autoModeMaxCost?: number;
  // Multi-directory support
  additionalDirs?: string[];
}): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  configPath: string | null;
} {
  const rawCommand = process.env.AUTOHAND_CMD;
  const commandParts = rawCommand ? parseEnvArgs(rawCommand) : [];
  const command = commandParts[0] || rawCommand || "autohand";
  const commandArgs = commandParts.slice(1);
  const args: string[] = [
    ...commandArgs,
    "--prompt",
    options.instruction,
    "--path",
    options.cwd,
  ];

  const configPath =
    process.env.AUTOHAND_CONFIG ??
    path.join(os.homedir(), ".autohand", "config.json");
  args.push("--config", configPath);

  if (options.modelId) {
    args.push("--model", options.modelId);
  }

  const temperature = process.env.AUTOHAND_TEMPERATURE;
  if (temperature) {
    args.push("--temperature", temperature);
  }

  // Use session mode to determine permission flags
  // Mode IDs: interactive, full-access, unrestricted, auto-mode, restricted, dry-run
  const modeId = options.modeId;

  // Check if auto-mode is selected via mode dropdown (not just config option)
  const isAutoModeViaMode = modeId === "auto-mode";

  if (modeId === "dry-run") {
    args.push("--dry-run");
  } else if (modeId === "full-access") {
    // Full access: auto-approve everything
    args.push("--yes");
  } else if (modeId === "unrestricted" || isAutoModeViaMode) {
    // Unrestricted: skip all approval prompts
    // Auto-mode also runs in unrestricted mode
    args.push("--unrestricted");
  } else if (modeId === "restricted") {
    args.push("--restricted");
  } else if (modeId === "interactive") {
    // Interactive mode: no flags, CLI will ask for permissions
    // Use external permission callback if available for better UX in Zed
    // Otherwise CLI prompts go to stdout (may not work well in non-TTY)
  }

  if (isTruthy(process.env.AUTOHAND_AUTO_COMMIT)) {
    args.push("--auto-commit");
  }

  // Auto-mode flags
  // Note: --auto-mode takes the instruction as its argument (not --prompt)
  // Auto-mode can be triggered via config option (autoModeEnabled) or mode selection (auto-mode)
  if (options.autoModeEnabled || isAutoModeViaMode) {
    // Find and remove --prompt from args since --auto-mode takes the instruction
    const promptIndex = args.indexOf("--prompt");
    if (promptIndex !== -1) {
      const instruction = args[promptIndex + 1];
      args.splice(promptIndex, 2); // Remove --prompt and its value
      args.push("--auto-mode", instruction);
    }
    if (options.autoModeMaxIterations) {
      args.push("--max-iterations", String(options.autoModeMaxIterations));
    }
    if (options.autoModeMaxRuntime) {
      args.push("--max-runtime", String(options.autoModeMaxRuntime));
    }
    if (options.autoModeMaxCost) {
      args.push("--max-cost", String(options.autoModeMaxCost));
    }
  }

  // Multi-directory support
  if (options.additionalDirs && options.additionalDirs.length > 0) {
    for (const dir of options.additionalDirs) {
      args.push("--add-dir", dir);
    }
  }

  args.push(...parseEnvArgs(process.env.AUTOHAND_EXTRA_ARGS));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AUTOHAND_NO_BANNER: "1",
    AUTOHAND_NON_INTERACTIVE: "1",
    AUTOHAND_SKIP_GIT_INIT: "1",
    CI: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    TERM: "dumb",
    AUTOHAND_STREAM_TOOL_OUTPUT: process.env.AUTOHAND_STREAM_TOOL_OUTPUT ?? "1",
    AUTOHAND_HOME: options.autohandHome,
  };

  // Add permission callback URL for external mode
  if (options.permissionCallbackUrl) {
    env.AUTOHAND_PERMISSION_CALLBACK_URL = options.permissionCallbackUrl;
  }

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
  return modes[0]?.id ?? "interactive";
}

// Default models as fallback
const DEFAULT_MODELS: ModelInfo[] = [
  // Anthropic
  {
    modelId: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    description: "Anthropic - Fast and intelligent",
  },
  {
    modelId: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    description: "Anthropic - Most capable",
  },
  // OpenAI
  {
    modelId: "gpt-4o",
    name: "GPT-4o",
    description: "OpenAI - Multimodal flagship",
  },
  {
    modelId: "gpt-4o-mini",
    name: "GPT-4o Mini",
    description: "OpenAI - Fast and affordable",
  },
  { modelId: "o1", name: "o1", description: "OpenAI - Advanced reasoning" },
  {
    modelId: "o1-mini",
    name: "o1 Mini",
    description: "OpenAI - Fast reasoning",
  },
  // Google
  {
    modelId: "gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    description: "Google - Fast multimodal",
  },
  {
    modelId: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    description: "Google - Most capable",
  },
];

/**
 * Read models from user's config file
 */
async function readModelsFromConfig(): Promise<ModelInfo[]> {
  const configPath = path.join(resolveAutohandHome(), "config.json");
  try {
    const configContent = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(configContent);

    const models: ModelInfo[] = [];
    const seenModelIds = new Set<string>();

    // Helper to create model info
    const addModel = (modelId: string, source: string) => {
      if (seenModelIds.has(modelId)) return;
      seenModelIds.add(modelId);

      // Create display name from model ID
      const name =
        modelId
          .split("/")
          .pop() // Remove provider prefix like "anthropic/"
          ?.split(":")[0] // Remove version suffix like ":free"
          ?.replace(/-/g, " ") // Replace dashes with spaces
          ?.replace(/\b\w/g, (c: string) => c.toUpperCase()) ?? modelId; // Title case

      models.push({
        modelId,
        name,
        description: `${source} - ${modelId}`,
      });
    };

    // Add top-level model first (if configured)
    if (config.model) {
      const provider = config.provider ?? "default";
      addModel(
        config.model,
        provider.charAt(0).toUpperCase() + provider.slice(1),
      );
    }

    // Add models from each provider section
    const providers = ["openrouter", "ollama", "llamacpp", "openai", "mlx"];
    for (const provider of providers) {
      const providerConfig = config[provider];
      if (providerConfig?.model) {
        addModel(
          providerConfig.model,
          provider.charAt(0).toUpperCase() + provider.slice(1),
        );
      }
    }

    return models;
  } catch {
    return [];
  }
}

function parseAvailableModels(): ModelInfo[] {
  // Check env vars first (can be set by CLI or extension)
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
      .map((model) => {
        // Check if it matches a default model for better naming
        const defaultModel = DEFAULT_MODELS.find((m) => m.modelId === model);
        if (defaultModel) {
          return defaultModel;
        }
        return { modelId: model, name: model };
      });
  }

  const fallback = process.env.AUTOHAND_MODEL;
  if (fallback) {
    const defaultModel = DEFAULT_MODELS.find((m) => m.modelId === fallback);
    if (defaultModel) {
      return [defaultModel];
    }
    return [{ modelId: fallback, name: fallback }];
  }

  // Return default models if nothing configured
  return DEFAULT_MODELS;
}

/**
 * Async version that reads from config file
 */
async function parseAvailableModelsAsync(): Promise<ModelInfo[]> {
  // Try env vars first
  const envModels = parseAvailableModels();
  if (envModels !== DEFAULT_MODELS) {
    return envModels;
  }

  // Try reading from config file
  const configModels = await readModelsFromConfig();
  if (configModels.length > 0) {
    return configModels;
  }

  // Fall back to defaults
  return DEFAULT_MODELS;
}

function resolveDefaultModel(models: ModelInfo[]): string {
  const envModel = process.env.AUTOHAND_MODEL;
  if (envModel && models.some((model) => model.modelId === envModel)) {
    return envModel;
  }
  return models[0]?.modelId ?? "";
}

/**
 * Async version that reads default model from config file
 */
async function resolveDefaultModelAsync(models: ModelInfo[]): Promise<string> {
  // Check env first
  const envModel = process.env.AUTOHAND_MODEL;
  if (envModel && models.some((model) => model.modelId === envModel)) {
    return envModel;
  }

  // Read from config file to get the active provider's model
  const configPath = path.join(resolveAutohandHome(), "config.json");
  try {
    const configContent = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(configContent);

    // Get the active provider
    const provider = config.provider;
    if (provider && config[provider]?.model) {
      const providerModel = config[provider].model;
      // Check if this model is in our list
      if (models.some((m) => m.modelId === providerModel)) {
        return providerModel;
      }
    }

    // Fall back to top-level model
    if (config.model && models.some((m) => m.modelId === config.model)) {
      return config.model;
    }
  } catch {
    // Ignore errors reading config
  }

  // Fall back to first model in list
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

type McpServerInfo = {
  name: string;
  type: string;
  url?: string;
  command?: string;
};

function parseMcpServers(
  servers?: Array<{
    type?: string;
    name: string;
    url?: string;
    command?: string;
  }>,
): McpServerInfo[] {
  if (!servers) return [];

  return servers.map((server) => {
    if ("type" in server && server.type === "http") {
      return { name: server.name, type: "http", url: server.url };
    } else if ("type" in server && server.type === "sse") {
      return { name: server.name, type: "sse", url: server.url };
    } else if ("command" in server && server.command) {
      return { name: server.name, type: "stdio", command: server.command };
    }
    return { name: server.name, type: "unknown" };
  });
}

function resolveAutohandHome(): string {
  if (process.env.AUTOHAND_HOME) {
    return process.env.AUTOHAND_HOME;
  }
  return path.join(os.homedir(), ".autohand");
}

/**
 * Find the autohand binary path
 */
type AutohandCommand = { command: string; baseArgs: string[] };

function findAutohandBinary(): AutohandCommand {
  // Use AUTOHAND_CMD if set (for testing/development)
  if (process.env.AUTOHAND_CMD) {
    return { command: process.env.AUTOHAND_CMD, baseArgs: [] };
  }
  // Use globally installed autohand command
  return { command: "autohand", baseArgs: [] };
}

/**
 * Check if the Autohand CLI is installed and accessible
 */
async function checkCliInstalled(): Promise<{
  installed: boolean;
  version?: string;
  error?: string;
}> {
  const { command } = findAutohandBinary();

  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({
          installed: false,
          error: `Autohand CLI not found. Please install it first:\n\n  npm install -g @anthropics/autohand\n\nOr visit: https://autohand.ai/docs/install`,
        });
      } else {
        resolve({
          installed: false,
          error: `Failed to check Autohand CLI: ${err.message}`,
        });
      }
    });

    child.on("close", (code) => {
      if (code === 0) {
        const version = stdout.trim().match(/\d+\.\d+\.\d+/)?.[0];
        resolve({ installed: true, version });
      } else {
        resolve({
          installed: false,
          error: stderr.trim() || `Autohand CLI exited with code ${code}`,
        });
      }
    });
  });
}

/**
 * Check if the user is authenticated with a valid, non-expired token
 */
async function checkAuthStatus(): Promise<boolean> {
  const configPath = path.join(resolveAutohandHome(), "config.json");
  try {
    const configContent = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(configContent);
    // Check if token exists and not expired
    if (config.auth?.token && config.auth?.expiresAt) {
      return new Date(config.auth.expiresAt) > new Date();
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Get authenticated user info from config
 */
async function getUserInfo(): Promise<{
  name?: string;
  email?: string;
} | null> {
  const configPath = path.join(resolveAutohandHome(), "config.json");
  try {
    const configContent = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(configContent);
    if (config.auth?.user) {
      return {
        name: config.auth.user.name,
        email: config.auth.user.email,
      };
    }
    return null;
  } catch {
    return null;
  }
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
    const candidates = sessions
      .filter(
        (session) =>
          !snapshot.has(session.id) &&
          path.resolve(session.projectPath) === resolvedCwd,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (candidates.length > 0) {
      for (const candidate of candidates) {
        const result = path.join(
          sessionsDir,
          candidate.id,
          "conversation.jsonl",
        );
        if (existsSync(result)) {
          return result;
        }
      }
    }

    if (existsSync(sessionsDir)) {
      const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
      const dirCandidates: Array<{
        createdAt: string;
        conversationPath: string;
      }> = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || snapshot.has(entry.name)) {
          continue;
        }
        const metadataPath = path.join(
          sessionsDir,
          entry.name,
          "metadata.json",
        );
        let metadata: { projectPath?: string; createdAt?: string } | null =
          null;
        try {
          const raw = await fs.readFile(metadataPath, "utf8");
          metadata = JSON.parse(raw) as {
            projectPath?: string;
            createdAt?: string;
          };
        } catch {
          continue;
        }
        if (
          !metadata?.projectPath ||
          path.resolve(metadata.projectPath) !== resolvedCwd
        ) {
          continue;
        }
        const conversationPath = path.join(
          sessionsDir,
          entry.name,
          "conversation.jsonl",
        );
        if (!existsSync(conversationPath)) {
          continue;
        }
        dirCandidates.push({
          createdAt: metadata.createdAt ?? "",
          conversationPath,
        });
      }
      if (dirCandidates.length > 0) {
        const latest = dirCandidates.sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        )[0];
        return latest.conversationPath;
      }
    }

    await sleep(200);
  }

  return null;
}

async function readSessionIndex(
  autohandHome: string,
): Promise<Array<{ id: string; projectPath: string; createdAt: string }>> {
  const indexPath = path.join(autohandHome, "sessions", "index.json");
  try {
    const content = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(content) as {
      sessions?: Array<{ id: string; projectPath: string; createdAt: string }>;
    };
    return parsed.sessions ?? [];
  } catch {
    return [];
  }
}

function buildToolTitle(tool: string, args?: unknown): string {
  const displayName = TOOL_DISPLAY_NAMES[tool] ?? tool;

  if (!args || typeof args !== "object") {
    return displayName;
  }

  const pathArg = (args as { path?: string }).path;
  if (pathArg) {
    return `${displayName} ${pathArg}`;
  }

  const queryArg = (args as { query?: string }).query;
  if (queryArg) {
    return `${displayName} "${queryArg}"`;
  }

  // For run_command, show the command
  const cmdArg = (args as { command?: string }).command;
  if (cmdArg) {
    return `${displayName} ${cmdArg}`;
  }

  return displayName;
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
  const tasks = (
    args as {
      tasks?: Array<{
        id: string;
        title: string;
        status: string;
        description?: string;
      }>;
    }
  ).tasks;
  if (!Array.isArray(tasks)) {
    return null;
  }
  const entries: PlanEntry[] = tasks.map((task) => ({
    content: task.description
      ? `${task.title} — ${task.description}`
      : task.title,
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
  const entries: PlanEntry[] = [
    {
      content: notes,
      status: "in_progress",
      priority: "low",
    },
  ];
  return { entries };
}

function normalizePlanStatus(
  status?: string,
): "pending" | "in_progress" | "completed" {
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
  return (
    value === "1" ||
    value.toLowerCase() === "true" ||
    value.toLowerCase() === "yes"
  );
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

/**
 * Generate a short, descriptive session title from the first user message.
 */
function generateSessionTitle(userText: string): string {
  // Clean up the text
  const cleaned = userText
    .replace(/\[resource[^\]]*\]/gi, "") // Remove resource tags
    .replace(/\[image[^\]]*\]/gi, "") // Remove image tags
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return "New Session";
  }

  // Take first 50 chars, break at word boundary
  if (cleaned.length <= 50) {
    return cleaned;
  }

  const truncated = cleaned.slice(0, 50);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > 20) {
    return truncated.slice(0, lastSpace) + "...";
  }
  return truncated + "...";
}

/**
 * Read extension settings from config file
 */
async function readExtensionSettings(): Promise<Record<string, unknown>> {
  const configPath = path.join(resolveAutohandHome(), "config.json");
  try {
    const content = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(content);
    return config.extension ?? {};
  } catch {
    return {};
  }
}

/**
 * Save extension setting to config file
 */
async function saveExtensionSetting(key: string, value: unknown): Promise<void> {
  const configPath = path.join(resolveAutohandHome(), "config.json");
  try {
    let config: Record<string, unknown> = {};
    try {
      const content = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(content);
    } catch {
      // Config doesn't exist, start fresh
    }

    // Ensure extension section exists
    if (!config.extension || typeof config.extension !== "object") {
      config.extension = {};
    }

    // Update the setting
    (config.extension as Record<string, unknown>)[key] = value;

    // Write back
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  } catch (error) {
    console.error(`Failed to save setting ${key}:`, error);
  }
}

/**
 * Build session config options with values from config file (async version)
 */
async function buildConfigOptionsAsync(): Promise<SessionConfigOption[]> {
  const settings = await readExtensionSettings();

  // Read from config with env var fallback
  const thinkingLevel = (settings.thinking_level as string) ?? process.env.AUTOHAND_THINKING_LEVEL ?? "normal";
  const autoCommit = settings.auto_commit === true || isTruthy(process.env.AUTOHAND_AUTO_COMMIT);
  const includeHistory = settings.include_history === true || isTruthy(process.env.AUTOHAND_INCLUDE_HISTORY);
  const autoModeEnabled = settings.auto_mode === true || isTruthy(process.env.AUTOHAND_AUTO_MODE);
  const autoModeMaxIterations = String(settings.auto_mode_max_iterations ?? process.env.AUTOHAND_AUTO_MODE_MAX_ITERATIONS ?? "50");
  const autoModeMaxRuntime = String(settings.auto_mode_max_runtime ?? process.env.AUTOHAND_AUTO_MODE_MAX_RUNTIME ?? "120");
  const autoModeMaxCost = String(settings.auto_mode_max_cost ?? process.env.AUTOHAND_AUTO_MODE_MAX_COST ?? "10");
  const temperature = String(settings.temperature ?? process.env.AUTOHAND_TEMPERATURE ?? "0.7");
  const streamOutput = settings.stream_output !== false; // default true

  return [
    {
      type: "select",
      id: "thinking_level",
      name: "Thinking",
      description: "Reasoning depth for complex tasks",
      currentValue: thinkingLevel,
      options: [
        {
          value: "none",
          name: "None",
          description: "Direct responses, no reasoning",
        },
        { value: "normal", name: "Normal", description: "Standard reasoning" },
        {
          value: "extended",
          name: "Extended",
          description: "Deep reasoning for complex tasks",
        },
      ],
    },
    {
      type: "select",
      id: "auto_commit",
      name: "Auto-commit",
      description: "Automatically commit changes",
      currentValue: autoCommit ? "enabled" : "disabled",
      options: [
        {
          value: "disabled",
          name: "Disabled",
          description: "Manual commits only",
        },
        {
          value: "enabled",
          name: "Enabled",
          description: "Auto-commit after changes",
        },
      ],
    },
    {
      type: "select",
      id: "include_history",
      name: "Include History",
      description: "Include conversation history in prompts",
      currentValue: includeHistory ? "enabled" : "disabled",
      options: [
        {
          value: "disabled",
          name: "Disabled",
          description: "Start fresh each prompt",
        },
        {
          value: "enabled",
          name: "Enabled",
          description: "Carry context forward",
        },
      ],
    },
    {
      type: "select",
      id: "auto_mode",
      name: "Auto-Mode",
      description:
        "Autonomous development loop (switches to Unrestricted mode)",
      currentValue: autoModeEnabled ? "enabled" : "disabled",
      options: [
        {
          value: "disabled",
          name: "Disabled",
          description: "Interactive mode",
        },
        {
          value: "enabled",
          name: "Enabled",
          description: "Autonomous agent loop",
        },
      ],
    },
    {
      type: "select",
      id: "auto_mode_max_iterations",
      name: "Max Iterations",
      description: "Maximum iterations for auto-mode",
      currentValue: autoModeMaxIterations,
      options: [
        { value: "25", name: "25", description: "Light tasks" },
        { value: "50", name: "50", description: "Standard tasks (default)" },
        { value: "100", name: "100", description: "Complex tasks" },
        { value: "200", name: "200", description: "Extended tasks" },
      ],
    },
    {
      type: "select",
      id: "auto_mode_max_runtime",
      name: "Max Runtime",
      description: "Maximum runtime in minutes for auto-mode",
      currentValue: autoModeMaxRuntime,
      options: [
        { value: "30", name: "30 min", description: "Quick tasks" },
        { value: "60", name: "1 hour", description: "Standard tasks" },
        {
          value: "120",
          name: "2 hours",
          description: "Extended tasks (default)",
        },
        { value: "240", name: "4 hours", description: "Long-running tasks" },
      ],
    },
    {
      type: "select",
      id: "auto_mode_max_cost",
      name: "Max Cost",
      description: "Maximum cost in dollars for auto-mode",
      currentValue: autoModeMaxCost,
      options: [
        { value: "5", name: "$5", description: "Budget limit" },
        { value: "10", name: "$10", description: "Standard limit (default)" },
        { value: "25", name: "$25", description: "Extended limit" },
        { value: "50", name: "$50", description: "High limit" },
      ],
    },
    {
      type: "select",
      id: "temperature",
      name: "Temperature",
      description: "Controls randomness in responses (lower = more focused)",
      currentValue: temperature,
      options: [
        { value: "0", name: "0.0", description: "Deterministic, most focused" },
        { value: "0.3", name: "0.3", description: "Low creativity" },
        { value: "0.7", name: "0.7", description: "Balanced (default)" },
        { value: "1.0", name: "1.0", description: "High creativity" },
      ],
    },
    {
      type: "select",
      id: "stream_output",
      name: "Stream Output",
      description: "Stream responses in real-time",
      currentValue: streamOutput ? "enabled" : "disabled",
      options: [
        { value: "enabled", name: "Enabled", description: "Show responses as they generate" },
        { value: "disabled", name: "Disabled", description: "Wait for complete response" },
      ],
    },
  ];
}

/**
 * Build session config options for UI dropdowns (sync version for fallback).
 */
function buildConfigOptions(): SessionConfigOption[] {
  const thinkingLevel = process.env.AUTOHAND_THINKING_LEVEL ?? "normal";
  const autoCommit = isTruthy(process.env.AUTOHAND_AUTO_COMMIT);
  const includeHistory = isTruthy(process.env.AUTOHAND_INCLUDE_HISTORY);
  const autoModeEnabled = isTruthy(process.env.AUTOHAND_AUTO_MODE);
  const autoModeMaxIterations = process.env.AUTOHAND_AUTO_MODE_MAX_ITERATIONS ?? "50";
  const autoModeMaxRuntime = process.env.AUTOHAND_AUTO_MODE_MAX_RUNTIME ?? "120";
  const autoModeMaxCost = process.env.AUTOHAND_AUTO_MODE_MAX_COST ?? "10";
  const temperature = process.env.AUTOHAND_TEMPERATURE ?? "0.7";
  const streamOutput = !isTruthy(process.env.AUTOHAND_NO_STREAM);

  return [
    {
      type: "select",
      id: "thinking_level",
      name: "Thinking",
      description: "Reasoning depth for complex tasks",
      currentValue: thinkingLevel,
      options: [
        { value: "none", name: "None", description: "Direct responses" },
        { value: "normal", name: "Normal", description: "Standard reasoning" },
        { value: "extended", name: "Extended", description: "Deep reasoning" },
      ],
    },
    {
      type: "select",
      id: "auto_commit",
      name: "Auto-commit",
      description: "Automatically commit changes",
      currentValue: autoCommit ? "enabled" : "disabled",
      options: [
        { value: "disabled", name: "Disabled", description: "Manual commits" },
        { value: "enabled", name: "Enabled", description: "Auto-commit" },
      ],
    },
    {
      type: "select",
      id: "auto_mode",
      name: "Auto-Mode",
      description: "Autonomous development loop",
      currentValue: autoModeEnabled ? "enabled" : "disabled",
      options: [
        { value: "disabled", name: "Disabled", description: "Interactive" },
        { value: "enabled", name: "Enabled", description: "Autonomous" },
      ],
    },
    {
      type: "select",
      id: "temperature",
      name: "Temperature",
      description: "Response randomness",
      currentValue: temperature,
      options: [
        { value: "0", name: "0.0", description: "Deterministic" },
        { value: "0.7", name: "0.7", description: "Balanced" },
        { value: "1.0", name: "1.0", description: "Creative" },
      ],
    },
  ];
}

export function runAcp(): void {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(input, output);
  new AgentSideConnection((client) => new AutohandAcpAgent(client), stream);
}
