#!/usr/bin/env node
// ============================================
// SETUP — First-time setup for oren-server
// Installs dependencies, Playwright, creates .env
// ============================================

import { execSync } from "child_process";
import { existsSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
}

console.log("========================================");
console.log("  OREN SERVER — Setup");
console.log("========================================\n");

// 1. npm install
console.log("📦 Installing dependencies...");
run("npm install");

// 2. Playwright
console.log("\n🎭 Installing Playwright Chromium...");
run("npx playwright install chromium");

// 3. .env
const envFile = join(ROOT, ".env");
const envExample = join(ROOT, ".env.example");
if (!existsSync(envFile)) {
  copyFileSync(envExample, envFile);
  console.log("\n📝 .env created from .env.example");
  console.log("   ⚠ EDIT .env with your real keys before starting!");
} else {
  console.log("\n✓ .env already exists");
}

console.log("\n========================================");
console.log("  Setup complete! Next steps:");
console.log("  1. Edit .env with your Supabase/Telegram/OpenAI keys");
console.log("  2. npm start (or npm run dev for auto-reload)");
console.log("========================================\n");
