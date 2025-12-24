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
      AUTOHAND_PERMISSION_MODE: "restricted",
      ...envOverrides,
    },
  });

  const stderrChunks = [];
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  const stream = ndJsonStream(nodeToWebWritable(child.stdin), nodeToWebReadable(child.stdout));
  const updates = [];

  const client = {
    async sessionUpdate(notification) {
      updates.push(notification);
    },
    async requestPermission() {
      return { outcome: { outcome: "cancelled" } };
    },
  };

  const connection = new ClientSideConnection(() => client, stream);
  return { child, connection, updates, stderrChunks };
}

function collectText(updates) {
  return updates
    .map((notification) => notification.update)
    .filter((update) => update.sessionUpdate === "agent_message_chunk")
    .map((update) => update.content?.type === "text" ? update.content.text : "")
    .join("");
}

async function cleanupChild(child) {
  if (child.exitCode !== null || child.signalCode) {
    return;
  }
  child.kill("SIGTERM");
  await once(child, "close");
}

if (process.platform === "win32") {
  test("skip e2e tests on windows", { skip: "Stub uses unix shebang" }, () => {});
} else {
  test("streams Autohand output over ACP", { timeout: 10000 }, async () => {
    const { child, connection, updates } = createConnection({
      AUTOHAND_STUB_OUTPUT: "AUTOSTUB ready",
    });

    try {
      const init = await connection.initialize({
        protocolVersion: 1,
        clientInfo: { name: "autohand-test", version: "0.0.0" },
      });
      assert.equal(init.protocolVersion, 1);

      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autohand-acp-"));
      const { sessionId } = await connection.newSession({ cwd: workspace, mcpServers: [] });

      const result = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "hello from e2e" }],
      });

      assert.equal(result.stopReason, "end_turn");
      const output = collectText(updates);
      assert.match(output, /AUTOSTUB ready/);
      assert.match(output, /AUTOSTUB prompt=/);
      assert.ok(output.includes(`AUTOSTUB path=${workspace}`));
    } finally {
      await cleanupChild(child);
    }
  });

  test("reports missing workspace", { timeout: 10000 }, async () => {
    const { child, connection, updates } = createConnection();

    try {
      await connection.initialize({ protocolVersion: 1 });
      const { sessionId } = await connection.newSession({
        cwd: path.join(os.tmpdir(), "autohand-acp-missing"),
        mcpServers: [],
      });

      const result = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "test" }],
      });

      assert.equal(result.stopReason, "end_turn");
      const output = collectText(updates);
      assert.match(output, /Workspace not found/);
    } finally {
      await cleanupChild(child);
    }
  });

  test("supports cancellation", { timeout: 15000 }, async () => {
    const { child, connection } = createConnection({
      AUTOHAND_STUB_SLEEP_MS: "3000",
    });

    try {
      await connection.initialize({ protocolVersion: 1 });
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autohand-acp-"));
      const { sessionId } = await connection.newSession({ cwd: workspace, mcpServers: [] });

      const promptPromise = connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "slow" }],
      });

      setTimeout(() => {
        void connection.cancel({ sessionId });
      }, 200);

      const result = await promptPromise;
      assert.equal(result.stopReason, "cancelled");
    } finally {
      await cleanupChild(child);
    }
  });

  test("handles /help command locally", { timeout: 10000 }, async () => {
    const { child, connection, updates } = createConnection();

    try {
      await connection.initialize({ protocolVersion: 1 });
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autohand-acp-"));
      const { sessionId } = await connection.newSession({ cwd: workspace, mcpServers: [] });

      const result = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "/help" }],
      });

      assert.equal(result.stopReason, "end_turn");
      const output = collectText(updates);
      assert.match(output, /Available commands/);
      assert.match(output, /\/help/);
      // Should NOT spawn Autohand stub for local commands
      assert.ok(!output.includes("AUTOSTUB"));
    } finally {
      await cleanupChild(child);
    }
  });

  test("handles /new command to reset session", { timeout: 10000 }, async () => {
    const { child, connection, updates } = createConnection();

    try {
      await connection.initialize({ protocolVersion: 1 });
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autohand-acp-"));
      const { sessionId } = await connection.newSession({ cwd: workspace, mcpServers: [] });

      const result = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "/new" }],
      });

      assert.equal(result.stopReason, "end_turn");
      const output = collectText(updates);
      assert.match(output, /Started a new conversation/);
    } finally {
      await cleanupChild(child);
    }
  });

  test("handles /session command", { timeout: 10000 }, async () => {
    const { child, connection, updates } = createConnection();

    try {
      await connection.initialize({ protocolVersion: 1 });
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autohand-acp-"));
      const { sessionId } = await connection.newSession({ cwd: workspace, mcpServers: [] });

      const result = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "/session" }],
      });

      assert.equal(result.stopReason, "end_turn");
      const output = collectText(updates);
      assert.match(output, /Session ID:/);
      assert.match(output, /Workspace:/);
    } finally {
      await cleanupChild(child);
    }
  });

  test("handles /status command", { timeout: 10000 }, async () => {
    const { child, connection, updates } = createConnection();

    try {
      await connection.initialize({ protocolVersion: 1 });
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autohand-acp-"));
      const { sessionId } = await connection.newSession({ cwd: workspace, mcpServers: [] });

      const result = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "/status" }],
      });

      assert.equal(result.stopReason, "end_turn");
      const output = collectText(updates);
      assert.match(output, /Autohand command:/);
      assert.match(output, /Permission mode:/);
    } finally {
      await cleanupChild(child);
    }
  });

  test("handles /model command with argument", { timeout: 10000 }, async () => {
    const { child, connection, updates } = createConnection({
      AUTOHAND_AVAILABLE_MODELS: "gpt-4,claude-3",
      AUTOHAND_MODEL: "gpt-4",
    });

    try {
      await connection.initialize({ protocolVersion: 1 });
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autohand-acp-"));
      const { sessionId } = await connection.newSession({ cwd: workspace, mcpServers: [] });

      // Use /model with an argument to avoid picker
      const result = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "/model claude-3" }],
      });

      assert.equal(result.stopReason, "end_turn");
      const output = collectText(updates);
      assert.match(output, /Model changed to: claude-3/);
    } finally {
      await cleanupChild(child);
    }
  });

  test("handles /mode command with argument", { timeout: 10000 }, async () => {
    const { child, connection, updates } = createConnection();

    try {
      await connection.initialize({ protocolVersion: 1 });
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autohand-acp-"));
      const { sessionId } = await connection.newSession({ cwd: workspace, mcpServers: [] });

      const result = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "/mode ask" }],
      });

      assert.equal(result.stopReason, "end_turn");
      const output = collectText(updates);
      assert.match(output, /Mode changed to: Ask/);
    } finally {
      await cleanupChild(child);
    }
  });

  test("resolves file mentions (resource_link) in prompts", { timeout: 10000 }, async () => {
    const { child, connection, updates } = createConnection({
      AUTOHAND_STUB_OUTPUT: "File content received",
    });

    try {
      await connection.initialize({ protocolVersion: 1 });
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autohand-acp-"));

      // Create a test file
      const testFile = path.join(workspace, "test.txt");
      await fs.writeFile(testFile, "Hello from test file!");

      const { sessionId } = await connection.newSession({ cwd: workspace, mcpServers: [] });

      const result = await connection.prompt({
        sessionId,
        prompt: [
          { type: "text", text: "Please analyze this file:" },
          { type: "resource_link", uri: `file://${testFile}`, name: "test.txt" },
        ],
      });

      assert.equal(result.stopReason, "end_turn");
      const output = collectText(updates);
      // The prompt should include the file content
      assert.match(output, /AUTOSTUB prompt=/);
    } finally {
      await cleanupChild(child);
    }
  });

  test("passes non-local commands to Autohand CLI", { timeout: 10000 }, async () => {
    const { child, connection, updates } = createConnection({
      AUTOHAND_STUB_OUTPUT: "Command executed",
    });

    try {
      await connection.initialize({ protocolVersion: 1 });
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autohand-acp-"));
      const { sessionId } = await connection.newSession({ cwd: workspace, mcpServers: [] });

      // /init is not handled locally, should be passed to Autohand CLI
      const result = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "/init" }],
      });

      assert.equal(result.stopReason, "end_turn");
      const output = collectText(updates);
      // Should spawn Autohand stub since /init is not handled locally
      assert.match(output, /AUTOSTUB/);
    } finally {
      await cleanupChild(child);
    }
  });

  test("queues multiple prompts and processes sequentially", { timeout: 15000 }, async () => {
    const { child, connection, updates } = createConnection({
      AUTOHAND_STUB_OUTPUT: "Message processed",
      AUTOHAND_STUB_SLEEP_MS: "500",
    });

    try {
      await connection.initialize({ protocolVersion: 1 });
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autohand-acp-"));
      const { sessionId } = await connection.newSession({ cwd: workspace, mcpServers: [] });

      // Send two prompts in quick succession without waiting
      const prompt1 = connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "first message" }],
      });
      const prompt2 = connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "second message" }],
      });

      // Both should complete successfully (not throw error)
      const [result1, result2] = await Promise.all([prompt1, prompt2]);

      assert.equal(result1.stopReason, "end_turn");
      assert.equal(result2.stopReason, "end_turn");

      const output = collectText(updates);
      // Both messages should have been processed
      assert.match(output, /first message/);
      assert.match(output, /second message/);
    } finally {
      await cleanupChild(child);
    }
  });
}
