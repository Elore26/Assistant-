// ============================================
// LOGGER — File + console logging
// ============================================

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, "..", "logs");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

function getLogFile() {
  const today = new Date().toISOString().split("T")[0];
  return join(LOG_DIR, `server-${today}.log`);
}

function timestamp() {
  return new Date().toLocaleTimeString("fr-FR", { timeZone: "Asia/Jerusalem" });
}

function write(level, msg) {
  const line = `[${timestamp()}] [${level}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(getLogFile(), line + "\n");
  } catch (_) {}
}

export const logger = {
  info: (msg) => write("INFO", msg),
  warn: (msg) => write("WARN", msg),
  error: (msg) => write("ERROR", msg),
};
