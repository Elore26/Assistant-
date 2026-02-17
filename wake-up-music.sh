#!/bin/bash
# ============================================
# WAKE-UP MUSIC — Script autonome pour Mac
# Lance YouTube Music au réveil
#
# Usage:
#   ./wake-up-music.sh              → lance avec config par défaut
#   ./wake-up-music.sh stop         → arrête la musique
#   ./wake-up-music.sh "URL"        → lance une playlist custom
#
# Installation:
#   chmod +x wake-up-music.sh
#
# Méthodes de déclenchement:
#   1. iPhone Shortcut → curl http://mac-ip:7600/wake-music
#   2. Scheduler oren-server (automatique 06:45)
#   3. Ce script directement
#   4. launchd (com.oren.wake-music.plist)
#   5. Telegram: /music
# ============================================

# --- Configuration ---
PLAYLIST="${1:-https://music.youtube.com/playlist?list=RDCLAK5uy_kmPRjHDECIo1mFSBmRAktuFKSbVsDpLgA}"
INITIAL_VOLUME=40
MAX_VOLUME=70
RAMP_DURATION=120  # secondes
SERVER_PORT=7600

# --- Stop command ---
if [ "$1" = "stop" ] || [ "$1" = "pause" ]; then
    echo "⏹ Arrêt de la musique..."
    osascript -e 'tell application "System Events" to key code 16 using {command down, option down}' 2>/dev/null
    echo "✅ Musique arrêtée"
    exit 0
fi

# --- Essayer via le serveur d'abord ---
if curl -s "http://localhost:${SERVER_PORT}/health" > /dev/null 2>&1; then
    echo "🖥️ Serveur oren détecté — déclenchement via API..."
    if [ "$1" ] && [[ "$1" == http* ]]; then
        curl -s -X POST "http://localhost:${SERVER_PORT}/wake-music" \
            -H "Content-Type: application/json" \
            -d "{\"playlist\":\"$1\"}"
    else
        curl -s "http://localhost:${SERVER_PORT}/wake-music"
    fi
    echo ""
    echo "✅ Lancé via oren-server"
    exit 0
fi

# --- Fallback: exécution directe ---
echo "🎵 Wake-up Music — Mode standalone"
echo "⚠️  Serveur oren non disponible, exécution directe..."

# 1. Régler le volume initial
echo "🔊 Volume: ${INITIAL_VOLUME}%"
osascript -e "set volume output volume ${INITIAL_VOLUME}"

# 2. Ouvrir YouTube Music
echo "🎶 Ouverture: ${PLAYLIST}"
open "${PLAYLIST}"

# 3. Attendre le chargement
sleep 3

# 4. Montée progressive du volume en arrière-plan
(
    STEPS=10
    STEP_DELAY=$((RAMP_DURATION / STEPS))
    VOL_STEP=$(( (MAX_VOLUME - INITIAL_VOLUME) / STEPS ))
    CURRENT_VOL=${INITIAL_VOLUME}

    for i in $(seq 1 $STEPS); do
        sleep $STEP_DELAY
        CURRENT_VOL=$((CURRENT_VOL + VOL_STEP))
        osascript -e "set volume output volume ${CURRENT_VOL}"
    done
    echo "🔊 Volume final: ${MAX_VOLUME}%"
) &

echo "✅ Musique lancée! Volume montera de ${INITIAL_VOLUME}% à ${MAX_VOLUME}% sur ${RAMP_DURATION}s"
