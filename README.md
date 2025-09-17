# n8n-langfuse

Deep n8n Observability with OpenTelemetry + Langfuse

## ⚠️ IMPORTANT DISCLAIMER ⚠️

**🚨 THIS IS A PROOF OF CONCEPT - NOT FOR PRODUCTION USE! 🚨**

This project is an **experimental demonstration** and **proof of concept** only. It is **NOT intended for production environments** and should only be used for:

- **Development and testing purposes**
- **Educational exploration**
- **Community proof of concept demonstrations**

**DO NOT USE IN PRODUCTION** due to:
- Lack of comprehensive testing across all n8n versions
- Potential performance impact on workflow execution
- Security implications of instrumentation patches
- Experimental nature of the OpenTelemetry integration
- No official support or warranty

**Use at your own risk!** Always test thoroughly in isolated development environments first.

---

## FROM N8N WORKFLOW TO TRACE

### N8N workflow
<img width="3136" height="1659" alt="N8N workflow that will leave traces behind in Langfuse." src="https://github.com/user-attachments/assets/82e65eac-63df-47c6-9f2c-03f065f69b44" />

### Langfuse Trace
<img width="1906" height="992" alt="Langfuse trace of the example N8N workflow!" src="https://github.com/user-attachments/assets/f4e1a8ed-f903-45f4-a35a-13084e768bde" />

## Overview

This project provides a ready-to-use solution for instrumenting your self-hosted n8n instance to send detailed traces directly to Langfuse via OpenTelemetry. This is especially powerful for AI workflows, as it maps n8n nodes to Langfuse observation types (generation, agent, tool, etc.).

Building on foundational OpenTelemetry work from the n8n community, this solution provides:
- **Detailed trace for every workflow run**
- **Each node as a child span with metadata and I/O**
- **Langfuse observation type mapping** for AI-specific insights
- **Ready-to-use Docker setup**

## Prerequisites

Before you begin, make sure you have:

- Docker and Docker Compose installed and running on your machine
- A Langfuse account and project (**self-hosted only**) with your OTLP endpoint URL and API keys (public/secret)
- Basic familiarity with Docker and environment variables

## Quick Start

### Step 1: Clone and Organize Files

Create a project directory with the following structure:

```
.
├── docker-entrypoint.sh
├── Dockerfile
├── docker-compose.yml
├── env_example
├── tracing/
│   ├── package.json
│   ├── package-lock.json
│   ├── langfuse-type-mapper.js
│   └── tracing.js
└── (optional) your-custom-node.tgz
```

### Step 2: Configure Environment Variables

1. Copy `env_example` to `.env`:
   ```bash
   cp env_example .env
   ```

2. Edit `.env` with your Langfuse details:
   ```env
   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://YOUR_LANGFUSE_HOST/api/public/otel/v1/traces
   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic YOUR_BASE64_TOKEN
   ```

   **To generate your Base64 token:**
   ```bash
   echo -n "pk-lf-xxx:sk-lf-xxx" | base64
   ```

### Step 3: Choose Your Deployment Method

#### Option A: Docker Compose (Recommended)

The easiest way to get started with n8n and PostgreSQL:

```bash
# Build and start all services
docker-compose up --build

# Or run in background
docker-compose up --build -d

# View logs
docker-compose logs -f n8n

# Stop services
docker-compose down
```

#### Option B: Manual Docker Commands

If you prefer manual control:

```bash
# Build the custom Docker image
docker build -t n8n-langfuse .

# Run the instrumented container
docker run --rm --env-file .env -p 5678:5678 n8n-langfuse
```

### Step 4: Verify Traces in Langfuse

1. Open n8n at `http://localhost:5678`
2. Create and run any workflow
3. Check your Langfuse project's Traces dashboard
4. You should see traces with nested spans for each node!

## Docker Compose Setup

The included `docker-compose.yml` provides a complete setup with:

- **PostgreSQL database** for n8n data persistence
- **n8n with OpenTelemetry instrumentation** 
- **Health checks** to ensure proper startup order
- **Data persistence** via Docker volumes

### Services

- **postgres-otel-dev**: PostgreSQL 15 database for n8n
- **n8n**: Custom n8n image with Langfuse tracing

### Volumes

- **postgres_otel_data**: Persistent PostgreSQL data
- **n8n_otel_data**: Persistent n8n workflows and settings

### Development Tips

For live debugging, uncomment these volume mounts in `docker-compose.yml`:

```yaml
volumes:
  - n8n_otel_data:/home/node/.n8n
  # Uncomment for live development:
  # - ./tracing/tracing.js:/opt/opentelemetry/tracing.js
  # - ./docker-entrypoint.sh:/docker-entrypoint.sh
```

This allows you to modify tracing code without rebuilding the container.

## How It Works

### Architecture Components

- **`docker-entrypoint.sh`**: Intercepts container startup and loads tracing before n8n starts
- **`tracing.js`**: Core instrumentation that patches n8n's WorkflowExecute class
- **`langfuse-type-mapper.js`**: Maps n8n node types to Langfuse observation types
- **OpenTelemetry SDK**: Handles trace collection and export to Langfuse

### Trace Structure

```
Workflow Execution (Root Span)
├── Node 1 (Child Span) - mapped to Langfuse observation type
├── Node 2 (Child Span) - with input/output capture
└── Node N (Child Span) - with metadata and timing
```

## Configuration Options

### Tracing Behavior

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `TRACING_ONLY_WORKFLOW_SPANS` | `true` | Disable auto-instrumentations (HTTP/DB) |
| `TRACING_DYNAMIC_WORKFLOW_TRACE_NAME` | `true` | Include workflow details in span names |
| `TRACING_USE_NODE_NAME_SPAN` | `true` | Use actual node names as span names |
| `TRACING_CAPTURE_INPUT_OUTPUT` | `true` | Capture node inputs/outputs |
| `TRACING_MAP_LANGFUSE_OBSERVATION_TYPES` | `true` | Map to Langfuse observation types |

### Langfuse Integration

The system automatically maps n8n nodes to Langfuse observation types:

- **Generation**: OpenAI, Anthropic, Google Gemini, etc.
- **Tool**: Utility nodes, HTTP requests, data processing
- **Agent**: AI Agent nodes
- **Retriever**: Vector stores, memory retrieval
- **Chain**: Workflow orchestration, text processing
- **Embedding**: Embedding generation nodes

## File Structure

### Core Files

All required files are included in this repository.

## Security Considerations

⚠️ **Important Security Notes:**

- Your `.env` file contains sensitive API keys - never commit it to version control
- The `TRACING_CAPTURE_INPUT_OUTPUT` option may capture sensitive data
- Rotate your Langfuse API keys regularly
- Use appropriate network security for your Langfuse instance

## Troubleshooting

### Common Issues

1. **No traces appearing in Langfuse**
   - Verify your OTLP endpoint URL includes the full path: `/api/public/otel/v1/traces`
   - Check your Base64 authorization token is correct
   - Ensure your Langfuse instance supports OpenTelemetry ingestion

2. **Container fails to start**
   - Check Docker logs: `docker logs <container_id>`
   - Verify all required files are in the correct directory structure
   - Ensure environment variables are properly formatted

3. **Missing spans for some nodes**
   - Some n8n node types may not be instrumented yet
   - Check the console logs for instrumentation warnings

### Debug Mode

Enable debug logging by setting:
```env
TRACING_LOG_LEVEL=debug
OTEL_LOG_LEVEL=DEBUG
```

## Contributing

Feedback and improvements are welcome! Areas for contribution:

- Additional node type mappings for Langfuse observation types
- Enhanced error handling and logging
- Performance optimizations
- Support for more OpenTelemetry backends

## Inspiration

This project builds on the fantastic foundational work from the n8n community's OpenTelemetry initiatives. The goal is to inspire the n8n development team to integrate native observability features.

**We need this ASAP!** 🚀😎

## License

This project is provided as-is **FOR PROOF OF CONCEPT PURPOSES ONLY** for the n8n community. **DO NOT USE IN PRODUCTION ENVIRONMENTS.** Please ensure compliance with n8n's licensing terms when using this in development environments.

---

Happy building! 🎉

For issues and feature requests, please open an issue in this repository.
