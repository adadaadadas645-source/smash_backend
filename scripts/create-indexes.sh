#!/usr/bin/env bash
# Creates the Firestore indexes and the log TTL this server needs. Only adds; never removes
# anything (safe on Avenia's project). An index that already exists is reported and skipped.
#   ./scripts/create-indexes.sh            (project aveniaapp)
#   ./scripts/create-indexes.sh my-project
set -u
P="${1:-aveniaapp}"
echo "Project: $P"

idx() {
  local group=$1; shift
  echo "→ $group: $*"
  local args=()
  for f in "$@"; do args+=(--field-config="$f"); done
  gcloud firestore indexes composite create --project="$P" --collection-group="$group" "${args[@]}" --async --quiet 2>&1 \
    | grep -vE "^$" | sed 's/^/   /' || true
}

idx kingdom_leaderboard field-path=level,order=descending field-path=levelReachedAt,order=ascending
idx kingdom_leaderboard field-path=level,order=ascending  field-path=levelReachedAt,order=ascending
# Country board, weekly race, country team board, a player's recent tournaments.
idx kingdom_leaderboard field-path=country,order=ascending field-path=level,order=descending field-path=levelReachedAt,order=ascending
idx kingdom_weekly field-path=week,order=ascending field-path=points,order=descending field-path=level,order=descending
idx kingdom_teams field-path=country,order=ascending field-path=score,order=descending
idx kingdom_tournament_entries field-path=playerId,order=ascending field-path=joinedAt,order=descending
for f in playerId requestId kind name; do
  idx kingdom_logs field-path=$f,order=ascending field-path=at,order=descending
done

echo "→ kingdom_logs: TTL on expireAt (rows deleted after LOG_RETENTION_DAYS)"
gcloud firestore fields ttls update expireAt --collection-group=kingdom_logs --enable-ttl --project="$P" --async --quiet 2>&1 | sed 's/^/   /' || true

echo
echo "Building takes a few minutes. Check with:"
echo "  gcloud firestore indexes composite list --project=$P --format='table(name.segment(-3):label=COLLECTION,fields.fieldPath.list():label=FIELDS,state)' | grep -E 'COLLECTION|kingdom_'"
