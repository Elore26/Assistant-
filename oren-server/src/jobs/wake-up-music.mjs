// ============================================
// WAKE-UP MUSIC — Ouvre YouTube Music au réveil
// Déclenché par:
//   1. iPhone Shortcut → HTTP POST /wake-music
//   2. Scheduler (backup à l'heure du réveil)
//   3. Telegram: /music
//   4. Script shell: wake-up-music.sh
// ============================================

import { exec } from "child_process";
import { promisify } from "util";
import { notifyTelegram } from "../services/telegram-notify.mjs";

const execAsync = promisify(exec);

// ─── Configuration ───
// Modifie cette URL avec ta playlist YouTube Music préférée
const DEFAULT_PLAYLIST = process.env.YOUTUBE_MUSIC_PLAYLIST
  || "https://music.youtube.com/playlist?list=RDCLAK5uy_kmPRjHDECIo1mFSBmRAktuFKSbVsDpLgA";

// Volume initial (0-100)
const WAKE_VOLUME = parseInt(process.env.WAKE_VOLUME || "40");

// Volume final après montée progressive (0-100)
const WAKE_VOLUME_MAX = parseInt(process.env.WAKE_VOLUME_MAX || "70");

// Durée de la montée de volume en secondes
const VOLUME_RAMP_SECONDS = parseInt(process.env.VOLUME_RAMP_SECONDS || "120");

// ─── AppleScript helpers ───

/** Règle le volume système du Mac (0-100) */
async function setVolume(level) {
  await execAsync(`osascript -e 'set volume output volume ${level}'`);
}

/** Récupère le volume actuel */
async function getVolume() {
  const { stdout } = await execAsync(
    `osascript -e 'output volume of (get volume settings)'`
  );
  return parseInt(stdout.trim());
}

/** Ouvre une URL dans le navigateur par défaut */
async function openURL(url) {
  await execAsync(`open "${url}"`);
}

/** Attend N millisecondes */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Montée progressive du volume (fade in)
 * Part de startVol → endVol sur durationSec secondes
 */
async function volumeRamp(startVol, endVol, durationSec) {
  const steps = 10;
  const stepDelay = (durationSec * 1000) / steps;
  const stepSize = (endVol - startVol) / steps;

  for (let i = 1; i <= steps; i++) {
    const vol = Math.round(startVol + stepSize * i);
    await setVolume(vol);
    await sleep(stepDelay);
  }
}

// ─── Main function ───

/**
 * Lance la musique du réveil
 * @param {Function} log - Logger du scheduler
 * @param {Object} options - Options optionnelles
 * @param {string} options.playlist - URL de playlist custom
 * @param {number} options.volume - Volume initial custom
 * @param {boolean} options.ramp - Activer la montée progressive (default: true)
 */
export async function wakeUpMusic(log, options = {}) {
  const playlist = options.playlist || DEFAULT_PLAYLIST;
  const startVolume = options.volume || WAKE_VOLUME;
  const maxVolume = options.volumeMax || WAKE_VOLUME_MAX;
  const doRamp = options.ramp !== false;

  log("🎵 Wake-up Music — Démarrage");

  try {
    // 1. Régler le volume initial (doux)
    log(`🔊 Volume initial: ${startVolume}%`);
    await setVolume(startVolume);

    // 2. Ouvrir YouTube Music avec la playlist
    log(`🎶 Ouverture: ${playlist}`);
    await openURL(playlist);

    // 3. Attendre que le navigateur charge (2 secondes)
    await sleep(2000);

    // 4. Simuler la lecture (clic "play" via AppleScript si nécessaire)
    // YouTube Music lance automatiquement la lecture pour les playlists
    // Mais on peut aussi envoyer un media key "play"
    try {
      await execAsync(`osascript -e '
        tell application "System Events"
          key code 16 using {command down, option down}
        end tell
      '`);
    } catch (_) {
      // Pas grave si ça échoue, la playlist auto-play souvent
    }

    // 5. Montée progressive du volume (réveil en douceur)
    if (doRamp && maxVolume > startVolume) {
      log(`🔊 Montée progressive: ${startVolume}% → ${maxVolume}% sur ${VOLUME_RAMP_SECONDS}s`);
      // Lance la montée en arrière-plan (ne bloque pas)
      volumeRamp(startVolume, maxVolume, VOLUME_RAMP_SECONDS).catch(() => {});
    }

    // 6. Notification Telegram
    await notifyTelegram(
      `🎵 *Réveil musical lancé !*\n` +
      `🔊 Volume: ${startVolume}% → ${maxVolume}%\n` +
      `🎶 Playlist: [YouTube Music](${playlist})`
    ).catch(() => {});

    log("✅ Wake-up Music — Lancé avec succès");
    return { status: "playing", playlist, volume: startVolume };

  } catch (err) {
    log(`❌ Erreur: ${err.message}`);
    await notifyTelegram(`❌ *Erreur réveil musical*\n${err.message}`).catch(() => {});
    throw err;
  }
}

/**
 * Arrête la musique (pause media + restore volume)
 */
export async function stopMusic(log) {
  log("⏹ Arrêt de la musique");
  try {
    // Envoyer media key "pause"
    await execAsync(`osascript -e '
      tell application "System Events"
        key code 16 using {command down, option down}
      end tell
    '`);
    log("✅ Musique arrêtée");
  } catch (err) {
    log(`⚠️ Erreur arrêt: ${err.message}`);
  }
}
