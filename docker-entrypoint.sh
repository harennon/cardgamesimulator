#!/bin/sh
set -e

# Default PORT to 8080 if Railway doesn't inject it
export PORT="${PORT:-8080}"

# Substitute $PORT in nginx config and write to the active config location
envsubst '${PORT}' < /etc/nginx/conf.d/production.conf.template > /etc/nginx/conf.d/default.conf

# Start nginx in the background
nginx -g "daemon off;" &
NGINX_PID=$!

# Start Node in the foreground
node /app/build/backend/index.js &
NODE_PID=$!

# Forward SIGTERM to both processes so Railway can shut the container down cleanly
trap 'kill $NGINX_PID $NODE_PID 2>/dev/null; wait $NGINX_PID $NODE_PID 2>/dev/null' TERM INT

# Wait for either process to exit; if one dies the container should exit too
wait -n $NGINX_PID $NODE_PID 2>/dev/null || true

# Kill the remaining process and exit with a non-zero code so Railway restarts
kill $NGINX_PID $NODE_PID 2>/dev/null || true
wait $NGINX_PID $NODE_PID 2>/dev/null || true
exit 1
