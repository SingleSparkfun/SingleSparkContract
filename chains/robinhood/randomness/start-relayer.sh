#!/bin/sh
set -eu
if [ -n "${RELAYER_KEY_SOURCE_FILE:-}" ]; then
  [ "$(id -u)" = 0 ]
  [ "$(stat -c %a "$RELAYER_KEY_SOURCE_FILE")" = 600 ]
  umask 077
  cp "$RELAYER_KEY_SOURCE_FILE" /tmp/singlespark-relayer-key
  chmod 600 /tmp/singlespark-relayer-key
  chown node:node /tmp/singlespark-relayer-key
  export RELAYER_KEY_FILE=/tmp/singlespark-relayer-key
fi
if [ "$(id -u)" = 0 ]; then
  exec su node -s /bin/sh -c 'exec node /app/singlespark/relayer.mjs'
fi
exec node /app/singlespark/relayer.mjs
