#!/bin/bash
# ============================================
# OREN LOCAL SCRAPER — Setup script for Mac
# Run once to install everything
# ============================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "  OREN SCRAPER — Installation Mac"
echo "=========================================="

# 1. Check Node.js
echo ""
echo "1. Vérification Node.js..."
if ! command -v node &>/dev/null; then
    echo "  ✗ Node.js non trouvé. Installe-le avec:"
    echo "    brew install node"
    exit 1
fi
NODE_VERSION=$(node --version)
echo "  ✓ Node.js $NODE_VERSION"

# 2. Install dependencies
echo ""
echo "2. Installation des dépendances..."
npm install
echo "  ✓ Dépendances installées"

# 3. Install Playwright Chromium
echo ""
echo "3. Installation de Chromium (Playwright)..."
npx playwright install chromium
echo "  ✓ Chromium installé"

# 4. Create .env if missing
if [ ! -f .env ]; then
    echo ""
    echo "4. Création du fichier .env..."
    cp .env.example .env
    echo "  ⚠ IMPORTANT: Édite .env avec tes clés Supabase:"
    echo "    nano $SCRIPT_DIR/.env"
else
    echo ""
    echo "4. .env existe déjà ✓"
fi

# 5. Create logs directory
mkdir -p logs
echo ""
echo "5. Dossier logs créé ✓"

# 6. Test run
echo ""
echo "6. Test rapide..."
echo "  Lancement en mode test (Ctrl+C pour annuler)..."
timeout 10 node src/index.mjs --source linkedin 2>&1 || true
echo "  ✓ Test terminé"

# 7. Install launchd (cron)
echo ""
echo "=========================================="
echo "  CRON — Installation launchd"
echo "=========================================="
echo ""
echo "Pour activer le scraping automatique (7h30 + 18h00):"
echo ""

# Detect Node.js path and update plist
NODE_PATH=$(which node)
PLIST_SRC="$SCRIPT_DIR/com.oren.job-scraper.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.oren.job-scraper.plist"

echo "  Commandes à exécuter:"
echo ""
echo "  # 1. Copier le plist (met à jour les chemins)"
echo "  sed -e 's|/usr/local/bin/node|$NODE_PATH|' \\"
echo "      -e 's|/Users/oren/Assistant-/local-scraper|$SCRIPT_DIR|' \\"
echo "      '$PLIST_SRC' > '$PLIST_DST'"
echo ""
echo "  # 2. Charger le job"
echo "  launchctl load '$PLIST_DST'"
echo ""
echo "  # 3. Vérifier"
echo "  launchctl list | grep oren"
echo ""
echo "  # Pour désactiver:"
echo "  launchctl unload '$PLIST_DST'"
echo ""
echo "=========================================="
echo "  ✅ Installation terminée !"
echo "=========================================="
echo ""
echo "  Usage manuel:"
echo "    npm run scrape          # LinkedIn + WTTJ"
echo "    npm run scrape:linkedin # LinkedIn seulement"
echo "    npm run scrape:wttj     # WTTJ seulement"
echo ""
echo "  Logs: $SCRIPT_DIR/logs/"
echo ""
