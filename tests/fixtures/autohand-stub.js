#!/usr/bin/env node

const args = process.argv.slice(2);

function getArg(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return "";
  }
  return args[index + 1] ?? "";
}

const prompt = getArg("--prompt");
const cwd = getArg("--path");
const sleepMs = Number.parseInt(process.env.AUTOHAND_STUB_SLEEP_MS ?? "0", 10);
const exitCode = Number.parseInt(process.env.AUTOHAND_STUB_EXIT_CODE ?? "0", 10);
const extraOutput = process.env.AUTOHAND_STUB_OUTPUT ?? "";

const outputLines = [];
if (extraOutput) {
  outputLines.push(extraOutput);
}
if (prompt) {
  outputLines.push(`AUTOSTUB prompt=${prompt}`);
}
if (cwd) {
  outputLines.push(`AUTOSTUB path=${cwd}`);
}

setTimeout(() => {
  if (outputLines.length > 0) {
    process.stdout.write(outputLines.join("\n") + "\n");
  }
  process.exit(exitCode);
}, Number.isNaN(sleepMs) ? 0 : sleepMs);
