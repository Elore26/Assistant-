#!/bin/bash
# ============================================
# OREN BOOTSTRAP — Run ONCE on the Mac
# After this, everything syncs automatically
# ============================================
# Usage (copy-paste in Terminal):
#   curl -sL https://raw.githubusercontent.com/Elore26/Assistant-/main/bootstrap-mac.sh | bash
#   OR if repo already cloned:
#   bash ~/Assistant-/bootstrap-mac.sh
# ============================================

set -e

echo ""
echo "=========================================="
echo "  OREN BOOTSTRAP — Setup Mac + Auto-Sync"
echo "=========================================="
echo ""

# 1. Clone repo if not exists
REPO_DIR="$HOME/Assistant-"
if [ -d "$REPO_DIR/.git" ]; then
    echo "1. Repo already cloned at $REPO_DIR ✓"
    cd "$REPO_DIR"
    git pull origin main
else
    echo "1. Cloning repo..."
    git clone https://github.com/Elore26/Assistant-.git "$REPO_DIR"
    cd "$REPO_DIR"
fi

# 2. Setup local-scraper
echo ""
echo "2. Setting up local-scraper..."
cd "$REPO_DIR/local-scraper"
npm install
npx playwright install chromium

# Create .env if missing
if [ ! -f .env ] && [ -f .env.example ]; then
    cp .env.example .env
    echo "  ⚠ IMPORTANT: Edit .env with your Supabase keys:"
    echo "    nano $REPO_DIR/local-scraper/.env"
fi

# 3. Make auto-sync executable
cd "$REPO_DIR"
chmod +x auto-sync.sh

# 4. Install auto-sync launchd agent
echo ""
echo "3. Installing auto-sync (every 30 min)..."

PLIST_SRC="$REPO_DIR/com.oren.auto-sync.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.oren.auto-sync.plist"

# Ensure LaunchAgents directory exists
mkdir -p "$HOME/Library/LaunchAgents"

# Unload existing if present
launchctl unload "$PLIST_DST" 2>/dev/null || true

# Copy and adapt paths
sed -e "s|/Users/oren/Assistant-|$REPO_DIR|g" \
    -e "s|/Users/oren|$HOME|g" \
    "$PLIST_SRC" > "$PLIST_DST"

# Load the agent
launchctl load "$PLIST_DST"
echo "  ✓ Auto-sync installed (runs every 30 min)"

# 5. Install job-scraper launchd agent
echo ""
echo "4. Installing job-scraper (7h30 + 18h00)..."

SCRAPER_PLIST_SRC="$REPO_DIR/local-scraper/com.oren.job-scraper.plist"
SCRAPER_PLIST_DST="$HOME/Library/LaunchAgents/com.oren.job-scraper.plist"

NODE_PATH=$(which node)
launchctl unload "$SCRAPER_PLIST_DST" 2>/dev/null || true

sed -e "s|/usr/local/bin/node|$NODE_PATH|" \
    -e "s|/Users/oren/Assistant-/local-scraper|$REPO_DIR/local-scraper|" \
    "$SCRAPER_PLIST_SRC" > "$SCRAPER_PLIST_DST"

launchctl load "$SCRAPER_PLIST_DST"
echo "  ✓ Job scraper installed (7h30 + 18h00)"

# 6. Verify
echo ""
echo "5. Vérification..."
launchctl list | grep oren || true

echo ""
echo "=========================================="
echo "  ✅ TOUT EST INSTALLÉ !"
echo "=========================================="
echo ""
echo "  Le Mac va maintenant:"
echo "  • Pull GitHub toutes les 30 min (auto-sync)"
echo "  • Scraper LinkedIn+WTTJ 2x/jour (7h30+18h00)"
echo "  • Tu recevras une notification Mac à chaque sync"
echo ""
echo "  Tu peux tout piloter depuis l'iPhone:"
echo "  → Merge un PR sur GitHub = le Mac pull auto"
echo ""
echo "  Logs:"
echo "    tail -f /tmp/oren-auto-sync.log"
echo "    tail -f /tmp/oren-scraper-stdout.log"
echo ""
