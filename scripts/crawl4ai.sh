#!/usr/bin/env bash
# Start the Crawl4AI MCP server for Alil (config/mcp.json → "crawl4ai").
#
# Hardening, because the crawler fetches outside Alil's own web.fetch guard:
#  - published on 127.0.0.1 only (never the LAN)
#  - bearer token required (CRAWL4AI_API_TOKEN, generated into .env on first run)
#  - hooks disabled (user Python hooks were an unauthenticated RCE before 0.8.0, CVE-2026-26216)
#  - pinned image, no-new-privileges, memory/CPU/pid limits
# Alil additionally vets every URL argument before a call (mcp.json "guardUrls": true).
# Not covered: redirects or page sub-resources the crawler loads itself.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="unclecode/crawl4ai:0.9.4"
NAME="alil-crawl4ai"
PORT="${CRAWL4AI_PORT:-11235}"

if ! grep -q '^CRAWL4AI_API_TOKEN=' .env 2>/dev/null; then
  printf '\n# Crawl4AI MCP server bearer token (scripts/crawl4ai.sh)\nCRAWL4AI_API_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
  echo "generated CRAWL4AI_API_TOKEN in .env"
fi
TOKEN="$(grep '^CRAWL4AI_API_TOKEN=' .env | tail -1 | cut -d= -f2-)"

case "${1:-start}" in
  start)
    if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
      docker start "$NAME" >/dev/null
    else
      docker run -d --name "$NAME" \
        -p "127.0.0.1:${PORT}:11235" \
        --shm-size=1g --memory=3g --cpus=2 --pids-limit=512 \
        --security-opt no-new-privileges \
        --restart unless-stopped \
        -e CRAWL4AI_API_TOKEN="$TOKEN" \
        -e CRAWL4AI_HOOKS_ENABLED=false \
        "$IMAGE" >/dev/null
    fi
    echo "crawl4ai: http://127.0.0.1:${PORT}  (MCP: /mcp/sse)"
    ;;
  stop) docker stop "$NAME" ;;
  logs) docker logs --tail 100 -f "$NAME" ;;
  rm) docker rm -f "$NAME" ;;
  *) echo "usage: $0 [start|stop|logs|rm]"; exit 2 ;;
esac
