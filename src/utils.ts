import { Readable, Writable } from "node:stream";

export function nodeToWebWritable(nodeStream: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        nodeStream.write(Buffer.from(chunk), (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  });
}

export function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (error) => controller.error(error));
    },
  });
}

export function parseEnvArgs(value?: string): string[] {
  if (!value) {
    return [];
  }

  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (quote) {
      if (char === "\\" && index + 1 < value.length) {
        current += value[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    if (char === "\\" && index + 1 < value.length) {
      current += value[index + 1];
      index += 1;
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

export function normalizePromptText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

/**
 * Strip ANSI escape codes from text.
 * Removes color codes, cursor control, and other terminal sequences.
 */
export function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\))/g, "");
}
