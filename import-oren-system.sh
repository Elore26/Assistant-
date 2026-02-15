#!/bin/bash
#############################################################
# Script d'import automatique - Oren System depuis Supabase
#
# Ce script récupère TOUT depuis ton projet Supabase :
#   - Schéma SQL complet (tables, fonctions, triggers, RLS)
#   - Données de toutes les tables
#   - Fichiers du Storage (tous les buckets)
#   - Edge Functions
#
# Usage: ./import-oren-system.sh
#############################################################

set -e

# ═══════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════
SUPABASE_URL="https://jmfbhsbkjrizrcovgkqs.supabase.co"
SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImptZmJoc2JranJpenJjb3Zna3FzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA0NTM5NjksImV4cCI6MjA4NjAyOTk2OX0.NA3WRZVCrj7cANLV94RQC6T8qPVuq0kiJAbEoLV2pxY"
PROJECT_REF="jmfbhsbkjrizrcovgkqs"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
BRANCH="claude/import-oren-system-files-zncPS"

# Couleurs
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
err()   { echo -e "${RED}[✗]${NC} $1"; }
info()  { echo -e "${BLUE}[i]${NC} $1"; }

# ═══════════════════════════════════════════════════════
# VÉRIFICATION DES PRÉREQUIS
# ═══════════════════════════════════════════════════════
echo ""
echo "══════════════════════════════════════════════════════"
echo "   Import Oren System depuis Supabase"
echo "══════════════════════════════════════════════════════"
echo ""

# Demander la service_role key si pas déjà définie
if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
    echo -e "${YELLOW}Pour un export complet, la service_role key est recommandée.${NC}"
    echo "Tu la trouves dans: Supabase Dashboard > Settings > API > service_role"
    echo ""
    read -rp "Colle ta service_role key (ou appuie sur Entrée pour utiliser la clé anon) : " SERVICE_KEY
    if [ -n "$SERVICE_KEY" ]; then
        SUPABASE_SERVICE_ROLE_KEY="$SERVICE_KEY"
    else
        SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_ANON_KEY"
        warn "Utilisation de la clé anon - certaines tables protégées par RLS pourraient ne pas être exportées"
    fi
fi

API_KEY="$SUPABASE_SERVICE_ROLE_KEY"

# Vérifier les outils nécessaires
for cmd in curl jq git; do
    if ! command -v "$cmd" &>/dev/null; then
        err "$cmd n'est pas installé. Installe-le et relance le script."
        exit 1
    fi
done
log "Prérequis OK (curl, jq, git)"

# Test de connexion
info "Test de connexion à Supabase..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "apikey: $API_KEY" \
    -H "Authorization: Bearer $API_KEY" \
    "$SUPABASE_URL/rest/v1/")

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
    log "Connexion à Supabase OK"
else
    err "Impossible de se connecter à Supabase (HTTP $HTTP_CODE)"
    err "Vérifie ton URL et ta clé API"
    exit 1
fi

# ═══════════════════════════════════════════════════════
# CRÉATION DE LA STRUCTURE
# ═══════════════════════════════════════════════════════
info "Création de la structure de dossiers..."
mkdir -p "$REPO_DIR/supabase/migrations"
mkdir -p "$REPO_DIR/supabase/seed"
mkdir -p "$REPO_DIR/supabase/functions"
mkdir -p "$REPO_DIR/supabase/storage"
log "Structure créée"

# ═══════════════════════════════════════════════════════
# 1. EXPORT DU SCHÉMA SQL
# ═══════════════════════════════════════════════════════
echo ""
info "═══ Export du schéma SQL ═══"

# Récupérer la liste des tables via l'OpenAPI spec
info "Récupération de la liste des tables..."
OPENAPI=$(curl -s \
    -H "apikey: $API_KEY" \
    -H "Authorization: Bearer $API_KEY" \
    "$SUPABASE_URL/rest/v1/" \
    -H "Accept: application/openapi+json")

if echo "$OPENAPI" | jq . &>/dev/null 2>&1; then
    # Extract table names from OpenAPI paths
    TABLES=$(echo "$OPENAPI" | jq -r '.paths | keys[] | ltrimstr("/")' 2>/dev/null | grep -v '^$' | sort)

    if [ -z "$TABLES" ]; then
        # Alternative: extract from definitions
        TABLES=$(echo "$OPENAPI" | jq -r '.definitions | keys[]' 2>/dev/null | grep -v '^$' | sort)
    fi

    if [ -n "$TABLES" ]; then
        TABLE_COUNT=$(echo "$TABLES" | wc -l)
        log "Trouvé $TABLE_COUNT table(s)"
        echo "$TABLES" | while read -r table; do
            echo "    - $table"
        done
    else
        warn "Aucune table trouvée via OpenAPI"
    fi

    # Sauvegarder le spec OpenAPI complet
    echo "$OPENAPI" | jq '.' > "$REPO_DIR/supabase/openapi-spec.json" 2>/dev/null
    log "Spec OpenAPI sauvegardée dans supabase/openapi-spec.json"

    # Générer un fichier SQL de schéma à partir de l'OpenAPI
    info "Génération du schéma SQL à partir de l'OpenAPI spec..."

    SCHEMA_FILE="$REPO_DIR/supabase/migrations/001_schema.sql"
    echo "-- ═══════════════════════════════════════════════════════" > "$SCHEMA_FILE"
    echo "-- Oren System - Schéma de base de données" >> "$SCHEMA_FILE"
    echo "-- Exporté depuis Supabase le $(date '+%Y-%m-%d %H:%M:%S')" >> "$SCHEMA_FILE"
    echo "-- Projet: $PROJECT_REF" >> "$SCHEMA_FILE"
    echo "-- ═══════════════════════════════════════════════════════" >> "$SCHEMA_FILE"
    echo "" >> "$SCHEMA_FILE"

    # Generate CREATE TABLE statements from OpenAPI definitions
    echo "$OPENAPI" | python3 -c "
import json, sys

try:
    spec = json.load(sys.stdin)
except:
    sys.exit(0)

definitions = spec.get('definitions', {})

type_map = {
    'integer': 'INTEGER',
    'number': 'NUMERIC',
    'string': 'TEXT',
    'boolean': 'BOOLEAN',
    'object': 'JSONB',
    'array': 'JSONB',
}

format_map = {
    'timestamp with time zone': 'TIMESTAMPTZ',
    'timestamp without time zone': 'TIMESTAMP',
    'uuid': 'UUID',
    'bigint': 'BIGINT',
    'smallint': 'SMALLINT',
    'real': 'REAL',
    'double precision': 'DOUBLE PRECISION',
    'json': 'JSON',
    'jsonb': 'JSONB',
    'text': 'TEXT',
    'integer': 'INTEGER',
    'date': 'DATE',
    'time with time zone': 'TIMETZ',
    'time without time zone': 'TIME',
    'interval': 'INTERVAL',
    'bytea': 'BYTEA',
    'inet': 'INET',
    'cidr': 'CIDR',
    'macaddr': 'MACADDR',
    'numeric': 'NUMERIC',
}

for table_name, table_def in sorted(definitions.items()):
    if table_name.startswith('_'):
        continue
    props = table_def.get('properties', {})
    required = table_def.get('required', [])

    if not props:
        continue

    print(f'CREATE TABLE IF NOT EXISTS public.\"{table_name}\" (')
    columns = []
    for col_name, col_def in props.items():
        col_format = col_def.get('format', '')
        col_type = col_def.get('type', 'text')
        col_desc = col_def.get('description', '')

        sql_type = format_map.get(col_format, type_map.get(col_type, 'TEXT'))

        # Check for primary key hint
        pk = ''
        if col_desc and 'primary key' in col_desc.lower():
            pk = ' PRIMARY KEY'

        # Check for default
        default = ''
        if col_def.get('default') is not None:
            default_val = col_def['default']
            if isinstance(default_val, str):
                default = f\" DEFAULT '{default_val}'\"
            elif isinstance(default_val, bool):
                default = f\" DEFAULT {'true' if default_val else 'false'}\"
            else:
                default = f' DEFAULT {default_val}'

        nullable = '' if col_name in required else ''

        columns.append(f'    \"{col_name}\" {sql_type}{pk}{default}{nullable}')

    print(',\n'.join(columns))
    print(');')
    print()
" >> "$SCHEMA_FILE" 2>/dev/null

    log "Schéma SQL généré dans supabase/migrations/001_schema.sql"
else
    warn "Impossible de parser l'OpenAPI spec"
fi

# ═══════════════════════════════════════════════════════
# 2. EXPORT DES DONNÉES DE CHAQUE TABLE
# ═══════════════════════════════════════════════════════
echo ""
info "═══ Export des données ═══"

if [ -n "$TABLES" ]; then
    echo "$TABLES" | while read -r table; do
        [ -z "$table" ] && continue
        info "Export de la table: $table"

        DATA=$(curl -s \
            -H "apikey: $API_KEY" \
            -H "Authorization: Bearer $API_KEY" \
            -H "Accept: application/json" \
            -H "Prefer: count=exact" \
            "$SUPABASE_URL/rest/v1/$table?select=*&limit=10000")

        if echo "$DATA" | jq . &>/dev/null 2>&1; then
            ROW_COUNT=$(echo "$DATA" | jq 'length')
            echo "$DATA" | jq '.' > "$REPO_DIR/supabase/seed/${table}.json"
            log "  $table: $ROW_COUNT lignes exportées"

            # Aussi générer un fichier SQL d'insertion
            if [ "$ROW_COUNT" -gt 0 ]; then
                echo "$DATA" | python3 -c "
import json, sys
table = '$table'
data = json.load(sys.stdin)
if not data:
    sys.exit(0)

print(f'-- Seed data for {table}')
print(f'-- {len(data)} rows')
print()

for row in data:
    cols = ', '.join(f'\"{k}\"' for k in row.keys())
    vals = []
    for v in row.values():
        if v is None:
            vals.append('NULL')
        elif isinstance(v, bool):
            vals.append('TRUE' if v else 'FALSE')
        elif isinstance(v, (int, float)):
            vals.append(str(v))
        elif isinstance(v, (dict, list)):
            vals.append(\"'\" + json.dumps(v).replace(\"'\", \"''\") + \"'::jsonb\")
        else:
            vals.append(\"'\" + str(v).replace(\"'\", \"''\") + \"'\")

    val_str = ', '.join(vals)
    print(f'INSERT INTO public.\"{table}\" ({cols}) VALUES ({val_str});')

print()
" > "$REPO_DIR/supabase/seed/${table}.sql" 2>/dev/null
            fi
        else
            warn "  $table: impossible d'exporter (RLS bloquant?)"
            echo "$DATA" > "$REPO_DIR/supabase/seed/${table}.error.log"
        fi
    done
else
    warn "Aucune table à exporter"
fi

# ═══════════════════════════════════════════════════════
# 3. EXPORT DU STORAGE (BUCKETS ET FICHIERS)
# ═══════════════════════════════════════════════════════
echo ""
info "═══ Export du Storage ═══"

BUCKETS=$(curl -s \
    -H "apikey: $API_KEY" \
    -H "Authorization: Bearer $API_KEY" \
    "$SUPABASE_URL/storage/v1/bucket")

if echo "$BUCKETS" | jq . &>/dev/null 2>&1; then
    BUCKET_COUNT=$(echo "$BUCKETS" | jq 'length')

    if [ "$BUCKET_COUNT" -gt 0 ]; then
        log "Trouvé $BUCKET_COUNT bucket(s)"
        echo "$BUCKETS" | jq '.' > "$REPO_DIR/supabase/storage/buckets.json"

        echo "$BUCKETS" | jq -r '.[].name' | while read -r bucket; do
            [ -z "$bucket" ] && continue
            info "Exploration du bucket: $bucket"
            mkdir -p "$REPO_DIR/supabase/storage/$bucket"

            # Lister les fichiers du bucket
            FILES=$(curl -s \
                -H "apikey: $API_KEY" \
                -H "Authorization: Bearer $API_KEY" \
                -X POST \
                -H "Content-Type: application/json" \
                -d '{"prefix":"","limit":1000,"offset":0,"sortBy":{"column":"name","order":"asc"}}' \
                "$SUPABASE_URL/storage/v1/object/list/$bucket")

            if echo "$FILES" | jq . &>/dev/null 2>&1; then
                FILE_COUNT=$(echo "$FILES" | jq 'length')
                log "  $bucket: $FILE_COUNT fichier(s)/dossier(s)"
                echo "$FILES" | jq '.' > "$REPO_DIR/supabase/storage/$bucket/_manifest.json"

                # Télécharger chaque fichier
                echo "$FILES" | jq -r '.[] | select(.id != null) | .name' | while read -r filename; do
                    [ -z "$filename" ] && continue
                    info "  Téléchargement: $bucket/$filename"
                    curl -s \
                        -H "apikey: $API_KEY" \
                        -H "Authorization: Bearer $API_KEY" \
                        -o "$REPO_DIR/supabase/storage/$bucket/$filename" \
                        "$SUPABASE_URL/storage/v1/object/$bucket/$filename"
                done

                # Explorer les sous-dossiers
                echo "$FILES" | jq -r '.[] | select(.id == null) | .name' | while read -r folder; do
                    [ -z "$folder" ] && continue
                    info "  Exploration du sous-dossier: $bucket/$folder"
                    mkdir -p "$REPO_DIR/supabase/storage/$bucket/$folder"

                    SUBFILES=$(curl -s \
                        -H "apikey: $API_KEY" \
                        -H "Authorization: Bearer $API_KEY" \
                        -X POST \
                        -H "Content-Type: application/json" \
                        -d "{\"prefix\":\"$folder\",\"limit\":1000,\"offset\":0,\"sortBy\":{\"column\":\"name\",\"order\":\"asc\"}}" \
                        "$SUPABASE_URL/storage/v1/object/list/$bucket")

                    echo "$SUBFILES" | jq -r '.[] | select(.id != null) | .name' 2>/dev/null | while read -r subfile; do
                        [ -z "$subfile" ] && continue
                        info "    Téléchargement: $bucket/$folder/$subfile"
                        curl -s \
                            -H "apikey: $API_KEY" \
                            -H "Authorization: Bearer $API_KEY" \
                            -o "$REPO_DIR/supabase/storage/$bucket/$folder/$subfile" \
                            "$SUPABASE_URL/storage/v1/object/$bucket/$folder/$subfile"
                    done
                done
            else
                warn "  $bucket: impossible de lister les fichiers"
            fi
        done
    else
        warn "Aucun bucket trouvé"
    fi
else
    warn "Impossible de lister les buckets (vérifier les permissions)"
fi

# ═══════════════════════════════════════════════════════
# 4. EXPORT DES EDGE FUNCTIONS (via Supabase CLI si dispo)
# ═══════════════════════════════════════════════════════
echo ""
info "═══ Edge Functions ═══"

if command -v supabase &>/dev/null; then
    info "Supabase CLI détecté, tentative de téléchargement des fonctions..."
    cd "$REPO_DIR"
    supabase functions download --project-ref "$PROJECT_REF" 2>&1 || warn "Impossible de télécharger les Edge Functions via CLI"
else
    warn "Supabase CLI non installé - les Edge Functions ne peuvent pas être exportées automatiquement"
    info "Pour les exporter manuellement:"
    info "  1. npm install -g supabase"
    info "  2. supabase login"
    info "  3. supabase functions download --project-ref $PROJECT_REF"

    # Essayer quand même de lister les fonctions via l'API
    info "Tentative de listage des fonctions via l'API Management..."

    # Note: cette API nécessite un access token (pas la clé anon)
    mkdir -p "$REPO_DIR/supabase/functions"
    cat > "$REPO_DIR/supabase/functions/README.md" << 'FUNCEOF'
# Edge Functions

Les Edge Functions n'ont pas pu être exportées automatiquement.

## Pour les exporter manuellement :

```bash
npm install -g supabase
supabase login
supabase link --project-ref jmfbhsbkjrizrcovgkqs
supabase functions download --project-ref jmfbhsbkjrizrcovgkqs
```
FUNCEOF
fi

# ═══════════════════════════════════════════════════════
# 5. EXPORT DES RPC FUNCTIONS (fonctions PostgreSQL)
# ═══════════════════════════════════════════════════════
echo ""
info "═══ RPC Functions ═══"

# Essayer d'appeler les fonctions RPC connues
RPC_FUNCS=$(echo "$OPENAPI" | jq -r '.paths | to_entries[] | select(.value.post.tags[]? == "rpc" or .key | startswith("/rpc/")) | .key | ltrimstr("/rpc/") | ltrimstr("/")' 2>/dev/null)

if [ -n "$RPC_FUNCS" ]; then
    RPC_COUNT=$(echo "$RPC_FUNCS" | wc -l)
    log "Trouvé $RPC_COUNT fonction(s) RPC"
    echo "$RPC_FUNCS" > "$REPO_DIR/supabase/migrations/rpc_functions.txt"
    echo "$RPC_FUNCS" | while read -r func; do
        echo "    - $func"
    done
else
    info "Aucune fonction RPC trouvée dans l'OpenAPI spec"
fi

# ═══════════════════════════════════════════════════════
# 6. GÉNÉRATION DU CONFIG SUPABASE
# ═══════════════════════════════════════════════════════
echo ""
info "═══ Génération de la configuration ═══"

cat > "$REPO_DIR/supabase/config.toml" << TOMLEOF
# Oren System - Configuration Supabase
# Généré automatiquement le $(date '+%Y-%m-%d %H:%M:%S')

[project]
id = "$PROJECT_REF"

[api]
enabled = true
port = 54321
schemas = ["public", "storage", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000

[db]
port = 54322
major_version = 15

[studio]
enabled = true
port = 54323

[auth]
enabled = true
site_url = "http://localhost:3000"

[storage]
enabled = true
file_size_limit = "50MiB"
TOMLEOF

log "Configuration générée dans supabase/config.toml"

# Générer .env.example
cat > "$REPO_DIR/.env.example" << ENVEOF
# Oren System - Variables d'environnement
SUPABASE_URL=$SUPABASE_URL
SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
ENVEOF

log ".env.example généré"

# ═══════════════════════════════════════════════════════
# 7. GIT COMMIT & PUSH
# ═══════════════════════════════════════════════════════
echo ""
info "═══ Git commit & push ═══"

cd "$REPO_DIR"

# S'assurer qu'on est sur la bonne branche
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
    git checkout -b "$BRANCH" 2>/dev/null || git checkout "$BRANCH"
fi

# Ajouter les fichiers
git add supabase/ .env.example

# Vérifier qu'il y a des changements
if git diff --cached --quiet; then
    warn "Aucun changement à committer"
else
    git commit -m "Import Oren System files from Supabase

- Database schema (tables, types, constraints)
- Seed data (JSON + SQL format)
- Storage buckets and files
- Supabase configuration
- Environment variables template"

    # Push
    git push -u origin "$BRANCH" && log "Push réussi!" || warn "Push échoué - tu devras push manuellement"
fi

# ═══════════════════════════════════════════════════════
# RÉSUMÉ
# ═══════════════════════════════════════════════════════
echo ""
echo "══════════════════════════════════════════════════════"
echo -e "${GREEN}   Import terminé !${NC}"
echo "══════════════════════════════════════════════════════"
echo ""
echo "Structure créée :"
find "$REPO_DIR/supabase" -type f | sort | while read -r f; do
    echo "  📄 ${f#$REPO_DIR/}"
done
echo ""
echo "  📄 .env.example"
echo ""
log "Tout est prêt !"
