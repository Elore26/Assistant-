# Setup Réveil Musical — YouTube Music sur Mac

## Architecture

```
iPhone Réveil sonne
       │
       ▼
Raccourci iOS (Automatisation)
       │
       ▼ HTTP GET
Mac oren-server :7600/wake-music
       │
       ├─→ Volume Mac 40% → 70% (progressif)
       ├─→ Ouvre YouTube Music (playlist)
       └─→ Notification Telegram ✅
```

## Méthode 1 : iPhone Shortcut (RECOMMANDÉ)

### Étape 1 : Trouver l'IP locale du Mac
Sur le Mac, ouvre Terminal :
```bash
ipconfig getifaddr en0
# exemple: 192.168.1.42
```

### Étape 2 : Créer l'Automatisation iPhone
1. Ouvre l'app **Raccourcis** (Shortcuts)
2. Va dans l'onglet **Automatisation**
3. Appuie sur **+** → **Créer une automatisation personnelle**
4. Choisis **Réveil** → "Quand mon réveil est arrêté"
5. Ajoute l'action **Obtenir le contenu de l'URL** :
   - URL : `http://192.168.1.42:7600/wake-music`
   - Méthode : GET
6. **Désactive** "Demander avant d'exécuter"
7. Appuie sur **OK**

### Étape 3 : Vérifier
```bash
# Depuis l'iPhone ou un autre appareil sur le même réseau :
curl http://192.168.1.42:7600/wake-music
```

## Méthode 2 : Scheduler automatique (BACKUP)

Le serveur oren lance automatiquement la musique à 06:45 (heure Israël).

Pour changer l'heure, ajoute dans `.env` :
```
WAKE_TIME=07:00
```

## Méthode 3 : Telegram

Depuis n'importe où :
```
/music          → lance la musique
/music stop     → arrête
/music 50       → lance avec volume 50%
/music https://music.youtube.com/playlist?list=xxx → playlist custom
```

## Méthode 4 : Script shell direct
```bash
./wake-up-music.sh              # lance
./wake-up-music.sh stop         # arrête
./wake-up-music.sh "https://music.youtube.com/playlist?list=xxx"
```

## Méthode 5 : launchd (timer macOS natif)
```bash
cp com.oren.wake-music.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.oren.wake-music.plist
```

## Configuration (.env)

Ajouter dans `oren-server/.env` :
```bash
# URL de la playlist YouTube Music par défaut
YOUTUBE_MUSIC_PLAYLIST=https://music.youtube.com/playlist?list=RDCLAK5uy_kmPRjHDECIo1mFSBmRAktuFKSbVsDpLgA

# Volume de départ (doux)
WAKE_VOLUME=40

# Volume final après montée progressive
WAKE_VOLUME_MAX=70

# Durée de la montée en secondes
VOLUME_RAMP_SECONDS=120

# Heure du réveil (backup scheduler, format HH:MM)
WAKE_TIME=06:45
```

## API Endpoints

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/wake-music` | GET | Lance la musique (config par défaut) |
| `/wake-music` | POST | Lance avec options `{ playlist, volume, volumeMax }` |
| `/wake-music/stop` | GET | Arrête la musique |

## Dépannage

**La musique ne se lance pas ?**
1. Vérifie que oren-server tourne : `curl http://localhost:7600/health`
2. Vérifie que le Mac n'est pas en veille (désactive la mise en veille automatique)
3. Vérifie le réseau WiFi (iPhone et Mac sur le même réseau)

**Le volume ne monte pas ?**
- Vérifie que le Mac n'est pas en mode silencieux
- Teste manuellement : `osascript -e 'set volume output volume 50'`

**L'iPhone ne déclenche pas ?**
- Vérifie que "Demander avant d'exécuter" est désactivé dans l'automatisation
- Vérifie que l'IP du Mac n'a pas changé (utilise une IP fixe sur le routeur)
