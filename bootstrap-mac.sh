#!/bin/bash
# ============================================
# OREN BOOTSTRAP — Run ONCE on the Mac
# Sets up: oren-server (24/7) + auto-sync
# ============================================
# Usage:
#   bash ~/Assistant-/bootstrap-mac.sh
# ============================================

set -e

echo ""
echo "=========================================="
echo "  OREN BOOTSTRAP — Mac Server Setup"
echo "=========================================="
echo ""

REPO_DIR="$HOME/Assistant-"

# 1. Clone repo if not exists
if [ -d "$REPO_DIR/.git" ]; then
    echo "1. Repo exists at $REPO_DIR ✓"
    cd "$REPO_DIR"
    git pull origin main 2>/dev/null || true
else
    echo "1. Cloning repo..."
    git clone https://github.com/Elore26/Assistant-.git "$REPO_DIR"
    cd "$REPO_DIR"
fi

# 2. Setup oren-server
echo ""
echo "2. Setting up oren-server..."
cd "$REPO_DIR/oren-server"
npm install
npx playwright install chromium

# Create .env if missing
if [ ! -f .env ] && [ -f .env.example ]; then
    cp .env.example .env
    echo "  ⚠ EDIT .env with your keys:"
    echo "    nano $REPO_DIR/oren-server/.env"
fi

# 3. Make scripts executable
cd "$REPO_DIR"
chmod +x auto-sync.sh

# 4. Install auto-sync launchd agent (git pull every 30 min)
echo ""
echo "3. Installing auto-sync (every 30 min)..."

PLIST_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"

PLIST_SRC="$REPO_DIR/com.oren.auto-sync.plist"
PLIST_DST="$PLIST_DIR/com.oren.auto-sync.plist"

launchctl unload "$PLIST_DST" 2>/dev/null || true
sed -e "s|/Users/oren/Assistant-|$REPO_DIR|g" \
    -e "s|/Users/oren|$HOME|g" \
    "$PLIST_SRC" > "$PLIST_DST"
launchctl load "$PLIST_DST"
echo "  ✓ Auto-sync installed"

# 5. Install oren-server launchd agent (24/7 daemon)
echo ""
echo "4. Installing oren-server (24/7 daemon)..."

NODE_PATH=$(which node)
SERVER_PLIST_SRC="$REPO_DIR/oren-server/com.oren.server.plist"
SERVER_PLIST_DST="$PLIST_DIR/com.oren.server.plist"

launchctl unload "$SERVER_PLIST_DST" 2>/dev/null || true
sed -e "s|/usr/local/bin/node|$NODE_PATH|" \
    -e "s|/Users/oren/Assistant-|$REPO_DIR|g" \
    -e "s|/Users/oren|$HOME|g" \
    "$SERVER_PLIST_SRC" > "$SERVER_PLIST_DST"
launchctl load "$SERVER_PLIST_DST"
echo "  ✓ Oren server installed (auto-restart on crash)"

# 6. Remove old scraper plist (replaced by oren-server)
OLD_SCRAPER_PLIST="$PLIST_DIR/com.oren.job-scraper.plist"
if [ -f "$OLD_SCRAPER_PLIST" ]; then
    launchctl unload "$OLD_SCRAPER_PLIST" 2>/dev/null || true
    rm "$OLD_SCRAPER_PLIST"
    echo "  ✓ Removed old standalone scraper (now handled by oren-server)"
fi

# 7. Verify
echo ""
echo "5. Verification..."
launchctl list | grep oren || true
sleep 2

# Check if server is running
if curl -s http://localhost:7600/health > /dev/null 2>&1; then
    echo "  ✓ Server is running on port 7600"
else
    echo "  ⏳ Server starting up... check in a few seconds"
fi

echo ""
echo "=========================================="
echo "  ✅ TOUT EST INSTALLÉ !"
echo "=========================================="
echo ""
echo "  Le Mac est maintenant un serveur 24/7 qui:"
echo ""
echo "  📡 OREN SERVER (port 7600, redémarre auto)"
echo "    • Scrape LinkedIn + WTTJ + Indeed 3x/jour"
echo "    • Score les offres avec AI automatiquement"
echo "    • Envoie les top offres sur Telegram"
echo "    • Health check: http://localhost:7600/health"
echo ""
echo "  🔄 AUTO-SYNC (toutes les 30 min)"
echo "    • Pull GitHub automatiquement"
echo "    • Met à jour les dépendances si besoin"
echo ""
echo "  📝 Logs:"
echo "    tail -f /tmp/oren-server-stdout.log"
echo "    tail -f /tmp/oren-auto-sync.log"
echo ""
echo "  🔧 Commandes manuelles:"
echo "    cd $REPO_DIR/oren-server"
echo "    npm run scrape          # scrape maintenant"
echo "    npm run score           # scorer maintenant"
echo "    npm run health          # check santé serveur"
echo ""
