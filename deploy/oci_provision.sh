#!/usr/bin/env bash
# Provisionne le réseau public + lance l'instance A1 en boucle jusqu'à décrocher
# un créneau de capacité (contourne le "Out of host capacity" d'Oracle Always Free).
#
# Prérequis : OCI CLI installé + `oci setup config` fait + clé API ajoutée dans la console
#             (vérifie avec : oci iam region list --output table).
#
# Usage :
#   bash deploy/oci_provision.sh
# Options (variables d'env) :
#   OCPUS=1 MEM=6            → shape plus petit = plus de chances de capacité (défaut 2/12)
#   SSH_PUB_FILE=~/.ssh/id_rsa.pub
#   RETRY_SECONDS=60
set -euo pipefail

# ── Paramètres ────────────────────────────────────────────────────────────────
OCPUS="${OCPUS:-2}"
MEM="${MEM:-12}"
RETRY_SECONDS="${RETRY_SECONDS:-60}"
SSH_PUB_FILE="${SSH_PUB_FILE:-$HOME/.ssh/id_rsa.pub}"
DISPLAY_NAME="anime-sama"
VCN_NAME="anime-vcn"
SUBNET_NAME="anime-public-subnet"

# ── Pré-checks ────────────────────────────────────────────────────────────────
command -v oci >/dev/null || { echo "OCI CLI absent. Installe-le d'abord."; exit 1; }

if [ ! -f "$SSH_PUB_FILE" ]; then
  echo "Pas de clé publique à $SSH_PUB_FILE."
  echo "Génères-en une :  ssh-keygen -t rsa -b 2048 -f ~/.ssh/id_rsa -N ''"
  exit 1
fi
SSH_PUB="$(cat "$SSH_PUB_FILE")"

# Compartment = tenancy racine (lu depuis ~/.oci/config)
COMPARTMENT="$(awk -F= '/^tenancy[[:space:]]*=/{gsub(/[[:space:]]/,"",$2);print $2}' ~/.oci/config | head -1)"
[ -n "$COMPARTMENT" ] || { echo "tenancy introuvable dans ~/.oci/config"; exit 1; }
echo "→ Compartment (tenancy) : $COMPARTMENT"

# ── Availability domain + image ARM Ubuntu 22.04 ──────────────────────────────
echo "→ Recherche de l'availability domain…"
AD="$(oci iam availability-domain list -c "$COMPARTMENT" --query 'data[0].name' --raw-output)"
echo "   AD = $AD"

echo "→ Recherche de l'image Ubuntu 22.04 (ARM)…"
IMAGE="$(oci compute image list -c "$COMPARTMENT" \
  --operating-system 'Canonical Ubuntu' --operating-system-version '22.04' \
  --shape 'VM.Standard.A1.Flex' --sort-by TIMECREATED --sort-order DESC \
  --query 'data[0].id' --raw-output)"
[ -n "$IMAGE" ] && [ "$IMAGE" != "null" ] || { echo "image introuvable"; exit 1; }
echo "   IMAGE = $IMAGE"

# ── Réseau (idempotent : réutilise si déjà créé) ──────────────────────────────
VCN="$(oci network vcn list -c "$COMPARTMENT" --display-name "$VCN_NAME" \
  --query 'data[0].id' --raw-output 2>/dev/null || true)"

if [ -z "$VCN" ] || [ "$VCN" = "null" ]; then
  echo "→ Création VCN $VCN_NAME…"
  VCN="$(oci network vcn create -c "$COMPARTMENT" --cidr-blocks '["10.0.0.0/16"]' \
    --display-name "$VCN_NAME" --wait-for-state AVAILABLE --query 'data.id' --raw-output)"
  echo "   VCN = $VCN"

  echo "→ Internet gateway…"
  IGW="$(oci network internet-gateway create -c "$COMPARTMENT" --vcn-id "$VCN" \
    --is-enabled true --display-name anime-igw --wait-for-state AVAILABLE \
    --query 'data.id' --raw-output)"

  echo "→ Route 0.0.0.0/0 → IGW…"
  RT="$(oci network vcn get --vcn-id "$VCN" --query 'data."default-route-table-id"' --raw-output)"
  oci network route-table update --rt-id "$RT" --force \
    --route-rules '[{"destination":"0.0.0.0/0","destinationType":"CIDR_BLOCK","networkEntityId":"'"$IGW"'"}]' >/dev/null

  echo "→ Security list : ouverture ports 22 (SSH) et 8000 (app)…"
  SL="$(oci network vcn get --vcn-id "$VCN" --query 'data."default-security-list-id"' --raw-output)"
  oci network security-list update --security-list-id "$SL" --force \
    --egress-security-rules '[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]' \
    --ingress-security-rules '[
      {"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":22,"max":22}}},
      {"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":8000,"max":8000}}}
    ]' >/dev/null

  echo "→ Subnet public $SUBNET_NAME…"
  SUBNET="$(oci network subnet create -c "$COMPARTMENT" --vcn-id "$VCN" \
    --cidr-block '10.0.0.0/24' --display-name "$SUBNET_NAME" \
    --route-table-id "$RT" --security-list-ids '["'"$SL"'"]' \
    --prohibit-public-ip-on-vnic false --wait-for-state AVAILABLE \
    --query 'data.id' --raw-output)"
else
  echo "→ VCN $VCN_NAME déjà présent, réutilisation."
  SUBNET="$(oci network subnet list -c "$COMPARTMENT" --vcn-id "$VCN" \
    --display-name "$SUBNET_NAME" --query 'data[0].id' --raw-output)"
fi
echo "   SUBNET = $SUBNET"

# ── Boucle de lancement (retry sur capacité) ──────────────────────────────────
echo ""
echo "=== Lancement A1 ($OCPUS OCPU / $MEM Go) — retry toutes les ${RETRY_SECONDS}s jusqu'à capacité ==="
attempt=0
while true; do
  attempt=$((attempt+1))
  out="$(oci compute instance launch \
    -c "$COMPARTMENT" --availability-domain "$AD" \
    --shape VM.Standard.A1.Flex \
    --shape-config '{"ocpus":'"$OCPUS"',"memoryInGBs":'"$MEM"'}' \
    --image-id "$IMAGE" --subnet-id "$SUBNET" --assign-public-ip true \
    --display-name "$DISPLAY_NAME" \
    --metadata '{"ssh_authorized_keys":"'"$SSH_PUB"'"}' \
    2>&1 || true)"

  if echo "$out" | grep -q '"id"'; then
    ID="$(echo "$out" | grep -oE 'ocid1\.instance\.[a-z0-9.\-]+' | head -1)"
    echo ""
    echo "✅ INSTANCE LANCÉE (tentative $attempt) : $ID"
    echo "→ Attente de l'état RUNNING + IP publique…"
    oci compute instance action --instance-id "$ID" --action NONE >/dev/null 2>&1 || true
    sleep 20
    VNIC="$(oci compute instance list-vnics --instance-id "$ID" --query 'data[0]."public-ip"' --raw-output 2>/dev/null || true)"
    echo "✅ IP publique : ${VNIC:-'(pas encore attribuée, réessaie: oci compute instance list-vnics --instance-id '"$ID"')'}"
    echo ""
    echo "Connexion :  ssh -i ${SSH_PUB_FILE%.pub} ubuntu@${VNIC}"
    exit 0
  fi

  if echo "$out" | grep -qiE 'out of host capacity|OutOfCapacity|Out of capacity|InternalError|500'; then
    echo "[$(date +%H:%M:%S)] tentative $attempt : pas de capacité, retry dans ${RETRY_SECONDS}s…"
    sleep "$RETRY_SECONDS"
    continue
  fi

  echo "❌ Erreur non liée à la capacité :"
  echo "$out"
  exit 1
done
