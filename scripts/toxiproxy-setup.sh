#!/bin/sh
# Idempotent toxiproxy setup — creates the tankbet proxy and default toxic.
# Safe to re-run; skips creation if proxy already exists.

set -e

TOXI_HOST="http://localhost:8474"
PROXY_NAME="tankbet"
LISTEN="localhost:3002"
UPSTREAM="localhost:3001"

echo "[toxiproxy-setup] Waiting for toxiproxy-server..."
until curl -sf "$TOXI_HOST/version" > /dev/null 2>&1; do
  sleep 0.5
done
echo "[toxiproxy-setup] toxiproxy-server is ready."

# Create proxy (skip if it already exists)
if curl -sf "$TOXI_HOST/proxies/$PROXY_NAME" > /dev/null 2>&1; then
  echo "[toxiproxy-setup] Proxy '$PROXY_NAME' already exists — skipping creation."
else
  curl -sf -X POST "$TOXI_HOST/proxies" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$PROXY_NAME\",\"listen\":\"$LISTEN\",\"upstream\":\"$UPSTREAM\"}"
  echo ""
  echo "[toxiproxy-setup] Created proxy '$PROXY_NAME' ($LISTEN -> $UPSTREAM)."
fi

# Add latency_downstream toxic (0ms default — passthrough)
if curl -sf "$TOXI_HOST/proxies/$PROXY_NAME/toxics/latency_downstream" > /dev/null 2>&1; then
  echo "[toxiproxy-setup] Toxic 'latency_downstream' already exists — skipping."
else
  curl -sf -X POST "$TOXI_HOST/proxies/$PROXY_NAME/toxics" \
    -H 'Content-Type: application/json' \
    -d '{"name":"latency_downstream","type":"latency","stream":"downstream","attributes":{"latency":0,"jitter":0}}'
  echo ""
  echo "[toxiproxy-setup] Added latency_downstream toxic (0ms latency, 0ms jitter)."
fi

echo "[toxiproxy-setup] Done."
