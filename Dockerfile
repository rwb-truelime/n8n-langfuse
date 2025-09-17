FROM docker.n8n.io/n8nio/n8n:latest

USER root

# Install system dependencies and setup dbus machine-id for OpenTelemetry
RUN apk update && apk add --no-cache ghostscript libreoffice ffmpeg poppler-utils dbus && \
    dbus-uuidgen > /var/lib/dbus/machine-id

WORKDIR /usr/local/lib/node_modules/n8n

# Using OTEL api so no need to install Langfuse packages
# RUN npm i -g langfuse langfuse-langchain --loglevel verbose

# Install the custom nodes
RUN mkdir /home/node/.n8n/nodes
COPY n8n-nodes-limescape-docs-1.1.20.tgz /home/node/.n8n/nodes/n8n-nodes-limescape-docs-1.1.20.tgz
COPY limescape-docs-processor-1.1.20.tgz /home/node/.n8n/nodes/limescape-docs-processor-1.1.20.tgz
RUN cd /home/node/.n8n/nodes/ && npm install ./n8n-nodes-limescape-docs-1.1.20.tgz --loglevel verbose \
&& npm install n8n-nodes-eml --loglevel verbose \
n8n-nodes-run-node-with-credentials-x --loglevel verbose \
&& chown -R node:node /home/node/.n8n/nodes && \
rm -rf /home/node/.n8n/nodes/*.tgz

# Install OpenTelemetry dependencies required by tracing.js
RUN mkdir -p /opt/opentelemetry
WORKDIR /opt/opentelemetry
COPY ./tracing/package.json package.json
COPY ./tracing/package-lock.json package-lock.json
COPY ./tracing/tracing.js tracing.js
COPY ./tracing/langfuse-type-mapper.js langfuse-type-mapper.js

RUN chown node:node ./*.js
RUN npm install

# Create a symlink to n8n-core in the OpenTelemetry node_modules directory
# tracing.js patches n8n-core to trace workflow executions
RUN mkdir -p /opt/opentelemetry/node_modules/n8n-core
RUN ln -sf /usr/local/lib/node_modules/n8n/node_modules/n8n-core/* /opt/opentelemetry/node_modules/n8n-core/

# Copy entrypoint script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN echo "Setting entrypoint permissions..." && \
    chmod +x /docker-entrypoint.sh && \
    chown node:node /docker-entrypoint.sh

# Switch back to the node homedir and user
WORKDIR /home/node
USER node
COPY ai-ktl.jpg .

ENTRYPOINT ["tini", "--", "/docker-entrypoint.sh"]
