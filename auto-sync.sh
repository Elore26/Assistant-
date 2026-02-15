#!/bin/bash
# ============================================
# OREN AUTO-SYNC — Git pull + auto-setup
# Runs via launchd every 30 min on the Mac
# ============================================

set -e

# Resolve the repo root (this script lives at repo root)
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

LOG_FILE="/tmp/oren-auto-sync.log"
LOCK_FILE="/tmp/oren-auto-sync.lock"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Prevent concurrent runs
if [ -f "$LOCK_FILE" ]; then
    # Check if lock is stale (older than 10 min)
    if [ "$(find "$LOCK_FILE" -mmin +10 2>/dev/null)" ]; then
        rm -f "$LOCK_FILE"
        log "Removed stale lock file"
    else
        log "Already running (lock exists). Skipping."
        exit 0
    fi
fi
trap 'rm -f "$LOCK_FILE"' EXIT
touch "$LOCK_FILE"

log "=== Auto-sync started ==="

# 1. Fetch latest from origin/main
log "Fetching origin/main..."
git fetch origin main 2>> "$LOG_FILE" || {
    log "ERROR: git fetch failed"
    exit 1
}

# 2. Check if there are new commits
LOCAL_HASH=$(git rev-parse HEAD)
REMOTE_HASH=$(git rev-parse origin/main)

if [ "$LOCAL_HASH" = "$REMOTE_HASH" ]; then
    log "Already up to date. Nothing to do."
    exit 0
fi

log "New commits detected! $LOCAL_HASH -> $REMOTE_HASH"

# 3. Pull changes (fast-forward only to avoid conflicts)
log "Pulling changes..."
git pull --ff-only origin main 2>> "$LOG_FILE" || {
    log "ERROR: git pull failed (possible conflicts). Manual intervention needed."
    # Send notification on Mac
    osascript -e 'display notification "Git pull failed — conflicts detected" with title "Oren Sync" sound name "Basso"' 2>/dev/null || true
    exit 1
}

log "Pull successful!"

# 4. Check if local-scraper dependencies changed
if git diff "$LOCAL_HASH" "$REMOTE_HASH" --name-only | grep -q "local-scraper/package.json"; then
    log "package.json changed — running npm install..."
    cd "$REPO_DIR/local-scraper"
    npm install 2>> "$LOG_FILE"
    log "npm install done"
    cd "$REPO_DIR"
fi

# 5. Check if Playwright needs update
if git diff "$LOCAL_HASH" "$REMOTE_HASH" --name-only | grep -q "local-scraper/package.json"; then
    if git diff "$LOCAL_HASH" "$REMOTE_HASH" -- local-scraper/package.json | grep -q "playwright"; then
        log "Playwright version changed — reinstalling chromium..."
        cd "$REPO_DIR/local-scraper"
        npx playwright install chromium 2>> "$LOG_FILE"
        log "Playwright chromium updated"
        cd "$REPO_DIR"
    fi
fi

# 6. Check if supabase functions changed
if git diff "$LOCAL_HASH" "$REMOTE_HASH" --name-only | grep -q "supabase/"; then
    log "Supabase functions changed (deploy manually or via CI)"
fi

# 7. Send success notification on Mac
COMMIT_COUNT=$(git rev-list "$LOCAL_HASH".."$REMOTE_HASH" --count)
osascript -e "display notification \"$COMMIT_COUNT new commit(s) pulled successfully\" with title \"Oren Sync ✓\" sound name \"Glass\"" 2>/dev/null || true

log "=== Auto-sync complete ($COMMIT_COUNT commits pulled) ==="
