#!/bin/sh

cleanup() {
    if [ -n "${BACKEND_PID:-}" ]; then
        kill "$BACKEND_PID" 2>/dev/null || true
    fi
}

trap cleanup INT TERM EXIT

echo "Starting backend service..."
cd /app/backend
node index.cjs server --config config.json &

BACKEND_PID=$!

echo "Waiting for backend to start..."
sleep 3

if ! kill -0 $BACKEND_PID 2>/dev/null; then
    echo "Backend failed to start"
    exit 1
fi

echo "Backend started successfully (PID: $BACKEND_PID)"

echo "Starting Caddy server..."
caddy run --config /etc/caddy/Caddyfile
