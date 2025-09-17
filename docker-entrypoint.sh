#!/bin/sh
# docker-entrypoint.sh

echo "Custom n8n image with ffmpeg and OpenTelemetry"

# Trust custom certificates if they exist
if [ -d /opt/custom-certificates ]; then
  echo "Trusting custom certificates from /opt/custom-certificates."
  export NODE_OPTIONS="--use-openssl-ca $NODE_OPTIONS"
  export SSL_CERT_DIR=/opt/custom-certificates
  c_rehash /opt/custom-certificates
fi

if [ "${OTEL_SDK_DISABLED}" = "false" ]; then
  echo "Starting n8n with OpenTelemetry instrumentation..."
  # Ensure n8n's own nested dependencies (like n8n-workflow) are resolvable.
  # These live under the n8n package's internal node_modules folder.
  export NODE_PATH="/opt/opentelemetry/node_modules:/usr/local/lib/node_modules/n8n/node_modules:/usr/local/lib/node_modules:${NODE_PATH}"
  # Debug (optional): uncomment to verify resolution
  # echo "NODE_PATH=$NODE_PATH"
  exec node --require /opt/opentelemetry/tracing.js /usr/local/bin/n8n "$@"
else
  echo "OpenTelemetry disabled, starting n8n normally..."
  if [ "$#" -gt 0 ]; then
    # Got started with arguments
    exec n8n "$@"
  else
    # Got started without arguments
    exec n8n
  fi
fi
