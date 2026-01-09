/**
 * TelemetryClient - Analytics and usage tracking for Zed extension
 * @license Apache-2.0
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import packageJson from "../package.json" with { type: "json" };

const API_BASE_URL = "https://api.autohand.ai";
const AUTOHAND_DIR = path.join(os.homedir(), ".autohand");
const DEVICE_ID_FILE = path.join(AUTOHAND_DIR, "device-id");
const TELEMETRY_QUEUE_FILE = path.join(AUTOHAND_DIR, "telemetry", "zed-queue.json");

type ClientType = "cli" | "vscode" | "zed" | "unknown";

type TelemetryEventType =
  | "session_start"
  | "session_end"
  | "tool_use"
  | "error"
  | "model_switch"
  | "command_use"
  | "heartbeat";

interface TelemetryEvent {
  id: string;
  eventType: TelemetryEventType;
  eventData?: Record<string, unknown>;
  deviceId: string;
  sessionId: string;
  clientType: ClientType;
  clientVersion: string;
  cliVersion: string;
  platform: string;
  osVersion?: string;
  nodeVersion?: string;
  timestamp: string;
}

interface TelemetryStats {
  queued: number;
  sent: number;
  failed: number;
}

/**
 * Check if telemetry is enabled via environment variable
 */
function isTelemetryEnabled(): boolean {
  const envValue = process.env.AUTOHAND_TELEMETRY;
  if (envValue === undefined) return true; // Default: enabled
  return envValue.toLowerCase() !== "false" && envValue !== "0";
}

/**
 * TelemetryClient - Lightweight telemetry for Zed extension
 */
export class TelemetryClient {
  private deviceId: string;
  private queue: TelemetryEvent[] = [];
  private stats: TelemetryStats = { queued: 0, sent: 0, failed: 0 };
  private sessionId: string | null = null;
  private sessionStartTime: Date | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isFlushing = false;
  private enabled: boolean;

  constructor() {
    this.enabled = isTelemetryEnabled();
    this.deviceId = this.getOrCreateDeviceId();
    if (this.enabled) {
      this.loadQueue();
      this.startFlushTimer();
    }
  }

  /**
   * Get or create persistent device ID
   */
  private getOrCreateDeviceId(): string {
    try {
      if (!fs.existsSync(AUTOHAND_DIR)) {
        fs.mkdirSync(AUTOHAND_DIR, { recursive: true });
      }

      if (fs.existsSync(DEVICE_ID_FILE)) {
        return fs.readFileSync(DEVICE_ID_FILE, "utf8").trim();
      }

      const id = randomUUID();
      fs.writeFileSync(DEVICE_ID_FILE, id);
      return id;
    } catch {
      return randomUUID();
    }
  }

  /**
   * Load queued events from disk
   */
  private loadQueue(): void {
    try {
      const dir = path.dirname(TELEMETRY_QUEUE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(TELEMETRY_QUEUE_FILE)) {
        const data = fs.readFileSync(TELEMETRY_QUEUE_FILE, "utf8");
        this.queue = JSON.parse(data);
        this.stats.queued = this.queue.length;
      }
    } catch {
      this.queue = [];
    }
  }

  /**
   * Save queue to disk
   */
  private saveQueue(): void {
    try {
      const dir = path.dirname(TELEMETRY_QUEUE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(TELEMETRY_QUEUE_FILE, JSON.stringify(this.queue, null, 2));
    } catch {
      // Silently fail
    }
  }

  /**
   * Start periodic flush timer
   */
  private startFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    // Flush every 60 seconds
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, 60000);
  }

  /**
   * Stop flush timer
   */
  stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Check if API is reachable
   */
  private async isOnline(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`${API_BASE_URL}/health`, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get system info for events
   */
  private getSystemInfo(): Partial<TelemetryEvent> {
    return {
      clientType: "zed",
      clientVersion: packageJson.version,
      cliVersion: `zed-${packageJson.version}`,
      platform: process.platform,
      osVersion: os.release(),
      nodeVersion: process.version,
    };
  }

  /**
   * Track an event
   */
  private async track(
    eventType: TelemetryEventType,
    eventData?: Record<string, unknown>
  ): Promise<void> {
    if (!this.enabled) return;

    const event: TelemetryEvent = {
      id: randomUUID(),
      eventType,
      eventData,
      deviceId: this.deviceId,
      sessionId: this.sessionId || "unknown",
      timestamp: new Date().toISOString(),
      ...this.getSystemInfo(),
    } as TelemetryEvent;

    this.queue.push(event);
    this.stats.queued++;

    // Trim queue if too large (max 500)
    if (this.queue.length > 500) {
      this.queue = this.queue.slice(-500);
    }

    this.saveQueue();

    // Auto-flush if batch size reached (20)
    if (this.queue.length >= 20) {
      await this.flush();
    }
  }

  /**
   * Flush queued events to server
   */
  async flush(): Promise<{ sent: number; failed: number; queued: number }> {
    if (!this.enabled || this.isFlushing || this.queue.length === 0) {
      return { sent: 0, failed: 0, queued: this.queue.length };
    }

    const online = await this.isOnline();
    if (!online) {
      return { sent: 0, failed: 0, queued: this.queue.length };
    }

    this.isFlushing = true;

    try {
      const eventsToSend = this.queue.slice(0, 20);

      const response = await fetch(`${API_BASE_URL}/v1/telemetry`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.deviceId}.`,
          "X-Client-Type": "zed",
          "X-Client-Version": packageJson.version,
        },
        body: JSON.stringify({ events: eventsToSend }),
      });

      if (response.ok) {
        this.queue = this.queue.slice(eventsToSend.length);
        this.stats.sent += eventsToSend.length;
        this.saveQueue();
        return { sent: eventsToSend.length, failed: 0, queued: this.queue.length };
      } else {
        this.stats.failed += eventsToSend.length;
        return { sent: 0, failed: eventsToSend.length, queued: this.queue.length };
      }
    } catch {
      return { sent: 0, failed: 0, queued: this.queue.length };
    } finally {
      this.isFlushing = false;
    }
  }

  // --- Public API ---

  /**
   * Start a new session
   */
  async startSession(sessionId: string, model?: string): Promise<void> {
    this.sessionId = sessionId;
    this.sessionStartTime = new Date();

    await this.track("session_start", {
      model,
    });
  }

  /**
   * End current session
   */
  async endSession(status: "completed" | "crashed" | "abandoned" = "completed"): Promise<void> {
    const duration = this.sessionStartTime
      ? Math.round((Date.now() - this.sessionStartTime.getTime()) / 1000)
      : 0;

    await this.track("session_end", {
      status,
      duration,
    });

    await this.flush();
  }

  /**
   * Track tool usage
   */
  async trackToolUse(data: {
    tool: string;
    success: boolean;
    duration?: number;
    error?: string;
  }): Promise<void> {
    await this.track("tool_use", data);
  }

  /**
   * Track an error
   */
  async trackError(data: {
    type: string;
    message: string;
    context?: string;
  }): Promise<void> {
    await this.track("error", {
      type: data.type,
      message: data.message,
      context: data.context,
    });
  }

  /**
   * Track slash command usage
   */
  async trackCommand(command: string, args?: string[]): Promise<void> {
    await this.track("command_use", {
      command,
      args,
    });
  }

  /**
   * Track model switch
   */
  async trackModelSwitch(fromModel: string | undefined, toModel: string): Promise<void> {
    await this.track("model_switch", {
      fromModel,
      toModel,
    });
  }

  /**
   * Get device ID
   */
  getDeviceId(): string {
    return this.deviceId;
  }

  /**
   * Get session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Get stats
   */
  getStats(): TelemetryStats {
    return { ...this.stats, queued: this.queue.length };
  }

  /**
   * Enable telemetry
   */
  enable(): void {
    this.enabled = true;
    this.startFlushTimer();
  }

  /**
   * Disable telemetry
   */
  disable(): void {
    this.enabled = false;
    this.stopFlushTimer();
  }

  /**
   * Shutdown and flush all events
   */
  async shutdown(): Promise<void> {
    this.stopFlushTimer();
    await this.flush();
  }
}

// Singleton instance
let telemetryClient: TelemetryClient | null = null;

export function getTelemetryClient(): TelemetryClient {
  if (!telemetryClient) {
    telemetryClient = new TelemetryClient();
  }
  return telemetryClient;
}
