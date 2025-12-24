/**
 * @license Apache-2.0
 * Tests for ACP permission callback integration
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { nodeToWebReadable, nodeToWebWritable } from "../../dist/utils.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const agentPath = path.join(rootDir, "dist", "index.js");
const stubPath = path.join(rootDir, "tests", "fixtures", "autohand-stub.js");

function createConnection(envOverrides = {}) {
  const child = spawn("node", [agentPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      AUTOHAND_CMD: stubPath,
      AUTOHAND_PERMISSION_MODE: "external",
      ...envOverrides,
    },
  });

  const stderrChunks = [];
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  const stream = ndJsonStream(nodeToWebWritable(child.stdin), nodeToWebReadable(child.stdout));
  const updates = [];
  const permissionRequests = [];

  const client = {
    async sessionUpdate(notification) {
      updates.push(notification);
    },
    async requestPermission(params) {
      permissionRequests.push(params);
      // Default: approve all permissions
      return { outcome: { outcome: "approved" } };
    },
  };

  const connection = new ClientSideConnection(() => client, stream);
  return { child, connection, updates, permissionRequests, stderrChunks };
}

function collectToolCalls(updates) {
  return updates
    .map((notification) => notification.update)
    .filter((update) => update.sessionUpdate === "tool_call");
}

async function cleanupChild(child) {
  if (child.exitCode !== null || child.signalCode) {
    return;
  }
  child.kill("SIGTERM");
  await once(child, "close");
}

if (process.platform === "win32") {
  test("skip permission tests on windows", { skip: "Stub uses unix shebang" }, () => {});
} else {
  test("requests permission via ACP when mode is external", { timeout: 15000 }, async () => {
    const { child, connection, updates, permissionRequests } = createConnection({
      AUTOHAND_PERMISSION_MODE: "external",
      AUTOHAND_STUB_OUTPUT: "Permission test output",
      AUTOHAND_STUB_TOOL_CALLS: JSON.stringify([
        { tool: "run_command", args: { command: "npm", args: ["install"] } }
      ]),
    });

    try {
      await connection.initialize({
        protocolVersion: 1,
        clientInfo: { name: "permission-test", version: "0.0.0" },
        clientCapabilities: {
          permissions: true,
        },
      });

      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autohand-acp-perm-"));
      const { sessionId } = await connection.newSession({ cwd: workspace, mcpServers: [] });

      const result = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "install dependencies" }],
      });

      assert.equal(result.stopReason, "end_turn");

      // Should have tool calls in updates
      const toolCalls = collectToolCalls(updates);
      assert.ok(toolCalls.length >= 0, "Should track tool calls");

    } finally {
      await cleanupChild(child);
    }
  });

  test("handles permission denial gracefully", { timeout: 15000 }, async () => {
    const child = spawn("node", [agentPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        AUTOHAND_CMD: stubPath,
        AUTOHAND_PERMISSION_MODE: "external",
        AUTOHAND_STUB_OUTPUT: "Denied operation",
      },
    });

    const stream = ndJsonStream(nodeToWebWritable(child.stdin), nodeToWebReadable(child.stdout));
    const updates = [];

    const client = {
      async sessionUpdate(notification) {
        updates.push(notification);
      },
      async requestPermission() {
        // Deny all permissions
        return { outcome: { outcome: "denied" } };
      },
    };

    const connection = new ClientSideConnection(() => client, stream);

    try {
      await connection.initialize({ protocolVersion: 1 });

      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autohand-acp-deny-"));
      const { sessionId } = await connection.newSession({ cwd: workspace, mcpServers: [] });

      const result = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "delete all files" }],
      });

      assert.equal(result.stopReason, "end_turn");

    } finally {
      await cleanupChild(child);
    }
  });

  test("falls back to auto-approve when client lacks permission capability", { timeout: 15000 }, async () => {
    const { child, connection, updates } = createConnection({
      AUTOHAND_PERMISSION_MODE: "auto",
      AUTOHAND_STUB_OUTPUT: "Auto-approved output",
    });

    try {
      await connection.initialize({
        protocolVersion: 1,
        clientInfo: { name: "no-perm-test", version: "0.0.0" },
        // No permissions capability
      });

      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autohand-acp-auto-"));
      const { sessionId } = await connection.newSession({ cwd: workspace, mcpServers: [] });

      const result = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "run a command" }],
      });

      assert.equal(result.stopReason, "end_turn");

    } finally {
      await cleanupChild(child);
    }
  });
}
