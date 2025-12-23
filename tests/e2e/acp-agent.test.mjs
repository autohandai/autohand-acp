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
}
