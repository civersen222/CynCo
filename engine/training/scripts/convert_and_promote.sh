#!/bin/bash
# Convert a Unsloth LoRA adapter to GGUF and promote it for use in CynCo.
#
# Usage:
#   ./convert_and_promote.sh --adapter ~/.cynco/adapters/sft-v1 \
#                            --base /models/qwen3.6-27b \
#                            --tag cynco-personalized:v1
#
# Requires: llama.cpp's convert_lora_to_gguf.py

set -euo pipefail

ADAPTER=""
BASE=""
TAG=""
OUTTYPE="q8_0"

while [[ $# -gt 0 ]]; do
  case $1 in
    --adapter) ADAPTER="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --outtype) OUTTYPE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [ -z "$ADAPTER" ] || [ -z "$BASE" ] || [ -z "$TAG" ]; then
  echo "Usage: convert_and_promote.sh --adapter <path> --base <path> --tag <name>"
  exit 1
fi

GGUF_OUT="${ADAPTER}/adapter.gguf"
CYNCO_DIR="${HOME}/.cynco"
ADAPTERS_DIR="${CYNCO_DIR}/adapters"

echo "=== Step 1: Convert LoRA to GGUF ==="
echo "  Adapter: ${ADAPTER}"
echo "  Base:    ${BASE}"
echo "  Output:  ${GGUF_OUT}"
echo "  Quant:   ${OUTTYPE}"

# Find convert script
CONVERT_SCRIPT=""
for candidate in \
  "${CYNCO_DIR}/bin/convert_lora_to_gguf.py" \
  "$(which convert_lora_to_gguf.py 2>/dev/null)" \
  "${HOME}/.cynco/llama.cpp/convert_lora_to_gguf.py"; do
  if [ -f "$candidate" ]; then
    CONVERT_SCRIPT="$candidate"
    break
  fi
done

if [ -z "$CONVERT_SCRIPT" ]; then
  echo "ERROR: convert_lora_to_gguf.py not found."
  echo "Download llama.cpp and ensure the script is on PATH or in ~/.cynco/bin/"
  exit 1
fi

python3 "$CONVERT_SCRIPT" \
  --base "$BASE" \
  --outtype "$OUTTYPE" \
  "$ADAPTER"

if [ ! -f "$GGUF_OUT" ]; then
  # Some versions output to a different path
  GGUF_OUT=$(find "$ADAPTER" -name "*.gguf" | head -1)
fi

echo "GGUF adapter: ${GGUF_OUT}"

echo ""
echo "=== Step 2: Install adapter ==="
mkdir -p "$ADAPTERS_DIR"
cp "$GGUF_OUT" "${ADAPTERS_DIR}/${TAG}.gguf"
echo "Installed: ${ADAPTERS_DIR}/${TAG}.gguf"

echo ""
echo "=== Step 3: Create Ollama model (optional) ==="
MODELFILE=$(mktemp)
cat > "$MODELFILE" <<MEOF
FROM ${BASE}
ADAPTER ${ADAPTERS_DIR}/${TAG}.gguf
MEOF

echo "Modelfile:"
cat "$MODELFILE"

if command -v ollama &>/dev/null; then
  echo ""
  echo "Creating Ollama model: ${TAG}"
  ollama create "$TAG" -f "$MODELFILE" || echo "Ollama create failed — adapter still usable via llama.cpp --lora"
else
  echo "Ollama not found — use llama-server --lora ${ADAPTERS_DIR}/${TAG}.gguf"
fi

rm -f "$MODELFILE"

echo ""
echo "=== Done ==="
echo "To use with CynCo (llama.cpp): set LOCALCODE_ADAPTER=${TAG}"
echo "To use with Ollama: LOCALCODE_MODEL=${TAG}"
