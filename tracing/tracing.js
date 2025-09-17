'use strict'
/**
 * This file is used to instrument the n8n application with OpenTelemetry.
 * It's run by the docker entrypoint.sh script before starting n8n.
 *
 * n8n Workflow and Node execution are instrumented. Subnodes are not yet instrumented.
 *
 * Workflow executions are traced as a span in the OTEL backend.
 * Subnode executions like Open AI Agent, Memory, etc. are not yet traced.
 * Only the parent AI Agent node is traced.
 *
 * TODO: add subnode instrumentation.
 */

// Guard against multiple initializations (n8n might load this module multiple times)
// Use multiple methods for maximum reliability across different Node.js contexts
const ALREADY_INITIALIZED =
  global.__n8nTracingInitialized ||
  process.env.__N8N_TRACING_INITIALIZED === 'true' ||
  process.__n8nOtelSDKStarted;

if (ALREADY_INITIALIZED) {
  console.log(`[Tracing]: Already initialized in this process (PID: ${process.pid}), skipping duplicate initialization`)
  module.exports = {}; // Export empty object and exit
} else {
  // Mark as initialized using multiple methods for different contexts
  global.__n8nTracingInitialized = true;
  process.env.__N8N_TRACING_INITIALIZED = 'true';
  process.__n8nOtelSDKStarted = true;
  console.log(`[Tracing]: First initialization in process (PID: ${process.pid}, PPID: ${process.ppid || 'unknown'})`)

  // Proceed with initialization
  initializeTracing();
}

function initializeTracing() {

const opentelemetry = require('@opentelemetry/sdk-node')
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http')
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http')
const {
  getNodeAutoInstrumentations,
} = require('@opentelemetry/auto-instrumentations-node')
const { registerInstrumentations } = require('@opentelemetry/instrumentation')
const { resourceFromAttributes } = require('@opentelemetry/resources')
const {
  SEMRESATTRS_SERVICE_NAME,
} = require('@opentelemetry/semantic-conventions')
const winston = require('winston')
const {
  trace,
  context,
  SpanStatusCode,
  SpanKind,
} = require('@opentelemetry/api')
const { flatten } = require('flat') // flattens objects into a single level
const { envDetector, hostDetector, processDetector } = require('@opentelemetry/resources')
const { mapNodeToObservationType } = require('./langfuse-type-mapper')

// Helper to parse boolean env vars
function envBool(name, def = false) {
  const v = (process.env[name] ?? '').toString().trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(v)) return true
  if (['false', '0', 'no', 'off'].includes(v)) return false
  return def
}

// Logs are opt-in. Respect OTEL_LOGS_EXPORTER=otlp as spec; otherwise allow a custom toggle.
function shouldEnableOtelLogs() {
  const logsExporter = (process.env.OTEL_LOGS_EXPORTER || '').toLowerCase()
  if (logsExporter === 'otlp' || logsExporter === 'otlp_http' || logsExporter === 'otlp-http') return true
  if (logsExporter === 'none' || logsExporter === '') return envBool('N8N_OTEL_EXPORT_LOGS', false)
  return envBool('N8N_OTEL_EXPORT_LOGS', false)
}

const LOGPREFIX = '[Tracing]'
const LOG_LEVEL = getEnv('TRACING_LOG_LEVEL', 'info')
const DEBUG = LOG_LEVEL === 'debug'
// If true, disable auto-instrumentations and emit ONLY the manual workflow + node spans.
const ONLY_WORKFLOW_SPANS = envBool('TRACING_ONLY_WORKFLOW_SPANS', false)
// Enable adding Langfuse observation type attributes based on node type.
const MAP_LANGFUSE_OBSERVATION_TYPES = envBool(
  'TRACING_MAP_LANGFUSE_OBSERVATION_TYPES',
  true,
)
// If true, incorporate observation type into node span name: n8n.node.<type>.execute
const LANGFUSE_TYPE_IN_NODE_SPAN_NAME = envBool(
  'TRACING_LANGFUSE_TYPE_IN_NODE_SPAN_NAME',
  false,
)
// If true, span name for nodes becomes the actual n8n node name (higher cardinality but more readable)
const USE_NODE_NAME_SPAN = envBool('TRACING_USE_NODE_NAME_SPAN', true)

// Toggle dynamic workflow trace naming (otherwise keep low-cardinality constant name)
const DYNAMIC_WORKFLOW_TRACE_NAME = envBool(
  'TRACING_DYNAMIC_WORKFLOW_TRACE_NAME',
  false,
)
// Optional explicit pattern overrides boolean flag. Supports placeholders:
// {workflowId} {workflowName} {executionId} {sessionId}
const WORKFLOW_SPAN_NAME_PATTERN = process.env.TRACING_WORKFLOW_SPAN_NAME_PATTERN
// Capture workflow & node input/output content for Langfuse enrichment
const CAPTURE_IO = envBool('TRACING_CAPTURE_INPUT_OUTPUT', true)
const MAX_IO_CHARS = parseInt(process.env.TRACING_MAX_IO_CHARS || '12000', 10)

function sanitizeSegment(value, def = 'unknown') {
  if (!value) return def
  return String(value)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 80) || def
}

function buildWorkflowSpanName({
  workflowId,
  workflowName,
  executionId,
  sessionId,
}) {
  // Pattern has highest precedence
  if (WORKFLOW_SPAN_NAME_PATTERN && WORKFLOW_SPAN_NAME_PATTERN.trim()) {
    const name = WORKFLOW_SPAN_NAME_PATTERN
      .replace(/\{workflowId\}/g, sanitizeSegment(workflowId, 'wf'))
      .replace(/\{workflowName\}/g, sanitizeSegment(workflowName, 'workflow'))
      .replace(/\{executionId\}/g, sanitizeSegment(executionId, 'exec'))
      .replace(/\{sessionId\}/g, sanitizeSegment(sessionId, 'sess'))
      .slice(0, 180)
    return name || 'n8n.workflow.execute'
  }
  if (DYNAMIC_WORKFLOW_TRACE_NAME) {
    return `${sanitizeSegment(workflowId, 'wf')}-${sanitizeSegment(
      workflowName,
      'workflow',
    )}-${sanitizeSegment(executionId, 'exec')}`
  }
  // Low-cardinality default
  return 'n8n.workflow.execute'
}

// -------------- IO Helper Utilities --------------
function safeJSONStringify(obj) {
  try {
    return JSON.stringify(obj)
  } catch (e) {
    return JSON.stringify({ _serializationError: String(e) })
  }
}

function truncateIO(str) {
  if (str == null) return ''
  if (typeof str !== 'string') str = String(str)
  if (str.length <= MAX_IO_CHARS) return str
  return (
    str.slice(0, MAX_IO_CHARS) + `...[truncated ${str.length - MAX_IO_CHARS} chars]`
  )
}

function extractNodeInput(node) {
  if (!node || typeof node !== 'object') return undefined
      const params = node.parameters || {}
  const out = {}
  const CANDIDATE_KEYS = [
    'text',
        'prompt',
        'input',
    'query',
    'question',
    'messages',
        'systemMessage',
    'systemPrompt',
    'instructions',
    'url',
      ]
  for (const key of CANDIDATE_KEYS) {
    if (params[key] !== undefined) out[key] = params[key]
    if (params.options && params.options[key] !== undefined) {
      out[`options.${key}`] = params.options[key]
    }
  }
  // fallback: include small primitive params
  if (!Object.keys(out).length) {
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === 'string' && v.length < 400) out[k] = v
      else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    }
  }
  return Object.keys(out).length ? out : undefined
}

function extractNodeOutput(result, runIndex) {
  try {
    const outputData = result?.data?.[runIndex]
    if (!outputData) return undefined
    const jsonArray = outputData.map((item) => item.json)
    if (!jsonArray?.length) return undefined
    const first = jsonArray[0]
    let primary
      if (first && typeof first === 'object') {
      primary =
        first.output ||
        first.completion ||
        first.text ||
        first.result ||
        first.response ||
        undefined
    }
    return { primary, items: jsonArray.slice(0, 10) } // limit items for size
  } catch (e) {
    return { _error: String(e) }
  }
}

// Layered classifier for mapping n8n node types -> Langfuse observation types.
// Priority mapping logic is provided by the standalone module `langfuse-type-mapper.js`.
// We intentionally keep only the import above to avoid duplicate definitions that caused
// "Identifier 'mapNodeToObservationType' has already been declared" runtime errors.

// Process all OTEL_* environment variables to strip quotes.
// Fixes issues with quotes in Docker env vars breaking the OTLP exporter.
processOtelEnvironmentVariables()

console.log(`${LOGPREFIX}: Starting n8n OpenTelemetry instrumentation`)

// Configure OpenTelemetry
// Turn off auto-instrumentation for dns, net, tls, fs, pg
let autoInstrumentations
if (!ONLY_WORKFLOW_SPANS) {
  autoInstrumentations = getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-dns': { enabled: false },
    '@opentelemetry/instrumentation-net': { enabled: false },
    '@opentelemetry/instrumentation-tls': { enabled: false },
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-pg': { enabled: false },
  })
  registerInstrumentations({ instrumentations: [autoInstrumentations] })
  console.log(`${LOGPREFIX}: Auto-instrumentations enabled`)
} else {
  console.log(`${LOGPREFIX}: TRACING_ONLY_WORKFLOW_SPANS=true -> auto-instrumentations DISABLED (no HTTP/DB spans)`)
}

// Setup n8n telemetry
console.log(`${LOGPREFIX}: Setting up n8n telemetry`)
setupN8nOpenTelemetry()

// Configure Winston logger to log to console
console.log(`${LOGPREFIX}: Configuring Winston logger with level: ${LOG_LEVEL}`)
setupWinstonLogger(LOG_LEVEL)

// Configure and start the OpenTelemetry SDK
console.log(
  `${LOGPREFIX}: Configuring OpenTelemetry SDK with log level: ${process.env.OTEL_LOG_LEVEL}`,
)
const sdk = setupOpenTelemetryNodeSDK()

sdk.start()
console.log(`${LOGPREFIX}: OpenTelemetry SDK started successfully`)

// Add warning handler for OTLP export timeouts (non-critical)
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning') return; // Ignore experimental warnings
  if (warning.message && warning.message.includes('Request Timeout')) {
    console.warn(`${LOGPREFIX}: OTLP export timeout (non-critical) - telemetry data may be delayed`)
    if (DEBUG) {
      console.warn(`${LOGPREFIX}: OTLP timeout details:`, warning.message)
    }
  }
})

// Helper: derive a session id. For now we treat each execution as its own session.
function deriveSessionId(executionId) {
  return executionId || 'unknown'
}

////////////////////////////////////////////////////////////
// HELPER FUNCTIONS
////////////////////////////////////////////////////////////

/**
 * Get environment variable without surrounding quotes
 */
function getEnv(key, defaultValue = '', required = true) {
  const value = process.env[key] ?? defaultValue
  if (!value && required) {
    throw new Error(`Required environment variable ${key} is not set`)
  }
  return value ? value.replace(/^['"]|['"]$/g, '') : defaultValue
}

/**
 * Process all OTEL_* environment variables to strip quotes
 *
 * This ensures that all OpenTelemetry environment variables are properly
 * formatted without surrounding quotes that might cause configuration issues.
 */
function processOtelEnvironmentVariables() {
  console.log(`${LOGPREFIX}: Processing OTEL environment variables`)
  const envVars = process.env
  for (const key in envVars) {
    if (key.startsWith('OTEL_')) {
      try {
        // Get the value without quotes
        const cleanValue = getEnv(key, undefined, false)
        process.env[key] = cleanValue
        if (DEBUG) {
          console.log(`${LOGPREFIX}: Processed ${key}=${cleanValue}`)
        }
      } catch (error) {
        console.warn(`${LOGPREFIX}: Error processing ${key}: ${error.message}`)
      }
    }
  }

  // Set reasonable defaults for OTLP timeouts if not configured
  if (!process.env.OTEL_EXPORTER_OTLP_TIMEOUT && !process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT) {
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '30000' // 30 seconds instead of default 10
    console.log(`${LOGPREFIX}: Set default OTLP timeout to 30 seconds`)
  }

  // Set batch export timeout if not configured
  if (!process.env.OTEL_BSP_EXPORT_TIMEOUT) {
    process.env.OTEL_BSP_EXPORT_TIMEOUT = '30000' // 30 seconds for batch span processor
    console.log(`${LOGPREFIX}: Set default batch export timeout to 30 seconds`)
  }
}

function awaitAttributes(detector) {
  return {
    async detect(config) {
      const resource = detector.detect(config)
      await resource.waitForAsyncAttributes?.()
      return resource
    },
  }
}

/**
 * Configure and start the OpenTelemetry SDK
 */
function setupOpenTelemetryNodeSDK() {
  const sdkOptions = {
    // Only include logRecordProcessors if we enable logs
    // resourceDetectors and resource unchanged
    resourceDetectors: [
      awaitAttributes(envDetector),
      awaitAttributes(processDetector),
      awaitAttributes(hostDetector),
    ],
    resource: resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]: getEnv('OTEL_SERVICE_NAME', 'n8n'),
    }),
    traceExporter: new OTLPTraceExporter(),
  }

  // Log OTLP configuration for debugging
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || 'default';
  const otlpTimeout = process.env.OTEL_EXPORTER_OTLP_TIMEOUT || process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT || '10000';
  console.log(`${LOGPREFIX}: OTLP Endpoint: ${otlpEndpoint}`)
  console.log(`${LOGPREFIX}: OTLP Timeout: ${otlpTimeout}ms`)
  if (DEBUG) {
    console.log(`${LOGPREFIX}: OTLP Headers configured: ${process.env.OTEL_EXPORTER_OTLP_HEADERS ? 'Yes' : 'No'}`)
  }

  if (shouldEnableOtelLogs()) {
    // Lazy-require to avoid loading the exporter when disabled
    const { SimpleLogRecordProcessor } = opentelemetry.logs
    const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http')
    sdkOptions.logRecordProcessors = [
      new SimpleLogRecordProcessor(new OTLPLogExporter()),
    ]
    console.log('[Tracing]: OTEL logs exporter enabled')
  } else {
    console.log('[Tracing]: OTEL logs exporter disabled')
  }

  return new opentelemetry.NodeSDK(sdkOptions)
}

/**
 * Configure the Winston logger
 *
 * - Logs uncaught exceptions to the console
 * - Logs unhandled promise rejections to the console
 * - Logs errors to the console
 */
function setupWinstonLogger(logLevel = 'info') {
  const logger = winston.createLogger({
    level: logLevel,
    format: winston.format.json(),
    transports: [new winston.transports.Console()],
  })

  process.on('uncaughtException', async (err) => {
    console.error('Uncaught Exception', err) // Log error object to console
    logger.error('Uncaught Exception', { error: err })
    const span = opentelemetry.trace.getActiveSpan()
    if (span) {
      span.recordException(err)
      span.setStatus({ code: 2, message: err.message })
    }
    try {
      await sdk.forceFlush()
    } catch (flushErr) {
      logger.error('Error flushing telemetry data', { error: flushErr })
    }
    process.exit(1)
  })

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Promise Rejection', { error: reason })
  })
}

/**
 * Patches n8n workflow and node execution to wrap the entire run in a workflow-level span.
 *
 * - Span name: "n8n.workflow.execute"
 * - Attributes prefixed with "n8n." to follow semantic conventions.
 */
function setupN8nOpenTelemetry() {
  // Setup n8n workflow execution tracing
  const tracer = trace.getTracer('n8n-instrumentation', '1.0.0')

  try {
    // Import n8n core modules
    const { WorkflowExecute } = require('n8n-core')

    /**
     * Patch the workflow execution
     *
     * Wrap the entire run in a workflow-level span and capture workflow details as attributes.
     *
     * - Span name: "n8n.workflow.execute"
     * - Attributes prefixed with "n8n." to follow semantic conventions.
     */
    const originalProcessRun = WorkflowExecute.prototype.processRunExecutionData
    /** @param {import('n8n-workflow').Workflow} workflow */
    WorkflowExecute.prototype.processRunExecutionData = function (workflow) {
      const wfData = workflow || {}
      const workflowId = wfData?.id ?? ''
      const workflowName = wfData?.name ?? ''

      // Attempt to resolve execution id from several potential locations (varies across n8n versions)
      const executionId =
        this?.executionId ||
        this?.workflowExecuteAdditionalData?.executionId ||
        this?.additionalData?.executionId ||
        'unknown'
      const sessionId = deriveSessionId(executionId)

      const workflowAttributes = {
        'n8n.workflow.id': workflowId,
        'n8n.workflow.name': workflowName,
        'n8n.execution.id': executionId,
        'n8n.session.id': sessionId,
        ...flatten(wfData?.settings ?? {}, {
          delimiter: '.',
          transformKey: (key) => `n8n.workflow.settings.${key}`,
        }),
      }

      // If the active parent span is the auto-instrumented HTTP server span (named GET/POST/etc),
      // rename it so Langfuse trace list shows a workflow-centric name instead of HTTP verb.
      // We detect it heuristically by http.method attribute or name = HTTP verb.
      const activeParent = trace.getSpan(context.active())
      if (activeParent && !ONLY_WORKFLOW_SPANS) {
        const httpMethodAttr =
          activeParent.attributes &&
          (activeParent.attributes['http.method'] ||
            activeParent.attributes['http.request.method'])
        const nameLooksHttpVerb = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(
          activeParent.name || '',
        )
        if (httpMethodAttr || nameLooksHttpVerb) {
          const originalName = activeParent.name
          // Build new trace (root) name
          let newRootName = 'n8n.workflow'
          if (DYNAMIC_WORKFLOW_TRACE_NAME) {
            newRootName = `${sanitizeSegment(workflowId, 'wf')}-${sanitizeSegment(
              workflowName,
              'workflow',
            )}-${sanitizeSegment(executionId, 'exec')}`
          } else {
            // still low cardinality but more explicit
            newRootName = 'n8n.workflow.request'
          }
          try {
            activeParent.updateName(newRootName)
            // Attach workflow attributes also to root span so they are visible in trace list
            for (const [k, v] of Object.entries(workflowAttributes)) {
              if (activeParent.attributes?.[k] === undefined) {
                activeParent.setAttribute(k, v)
              }
            }
            activeParent.setAttribute('n8n.http.original_name', originalName)
            activeParent.setAttribute('n8n.trace.naming', DYNAMIC_WORKFLOW_TRACE_NAME ? 'dynamic' : 'constant')
          } catch (err) {
            if (DEBUG) console.warn('[Tracing] Failed to rename HTTP root span', err)
          }
        }
      }

      // Keep span name constant (low-cardinality) to avoid metrics explosion.
      const workflowSpanName = buildWorkflowSpanName({
        workflowId,
        workflowName,
        executionId,
        sessionId,
      })
      const span = tracer.startSpan(workflowSpanName, {
        attributes: workflowAttributes,
        kind: SpanKind.INTERNAL,
      })

      if (DEBUG) {
        console.debug(`${LOGPREFIX}: starting n8n workflow span`, {
          workflowId,
          executionId,
          sessionId,
          spanName: workflowSpanName,
        })
      }

      const activeContext = trace.setSpan(context.active(), span)
      return context.with(activeContext, () => {
        const cancelable = originalProcessRun.apply(this, arguments)
        cancelable
          .then(
            (result) => {
              if (result?.data?.resultData?.error) {
                const err = result.data.resultData.error
                span.recordException(err)
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: String(err.message || err),
                })
              }
              if (CAPTURE_IO) {
                // Workflow output (trace output)
                try {
                  const runData = result?.data?.resultData?.runData
                  if (runData) {
                    const outputStr = truncateIO(safeJSONStringify(runData))
                    span.setAttribute('langfuse.trace.output', outputStr)
                  }
                } catch (e) {
                  if (DEBUG)
                    console.warn('[Tracing] Failed to capture workflow output', e)
                }
                // If no explicit trace input yet, set minimal context
                if (!span.attributes?.['langfuse.trace.input']) {
                  span.setAttribute(
                    'langfuse.trace.input',
                    safeJSONStringify({ workflowId, workflowName }),
                  )
                }
              }
            },
            (error) => {
              span.recordException(error)
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: String(error.message || error),
              })
            },
          )
          .finally(() => {
            span.end()
          })
        return cancelable
      })
    }

    /**
     * Patch the n8n node execution
     *
     * Wrap each node's run in a child span and capture node details as attributes.
     * - Span name: "n8n.node.execute"
     */
    const originalRunNode = WorkflowExecute.prototype.runNode
    /**
     * @param {import('n8n-workflow').Workflow} workflow
     * @param {import('n8n-workflow').IExecuteData} executionData
     * @param {import('n8n-workflow').IRunExecutionData} runExecutionData
     * @param {number} runIndex
     * @param {import('n8n-workflow').IWorkflowExecuteAdditionalData} additionalData
     * @param {import('n8n-workflow').WorkflowExecuteMode} mode
     * @param {AbortSignal} [abortSignal]
     * @returns {Promise<import('n8n-workflow').IRunNodeResponse>}
     */
    WorkflowExecute.prototype.runNode = async function (
      workflow,
      executionData,
      runExecutionData,
      runIndex,
      additionalData,
      mode,
      abortSignal,
    ) {
      // Safeguard against undefined this context
      if (!this) {
        console.warn('WorkflowExecute context is undefined')
        return originalRunNode.apply(this, arguments)
      }

      const node = executionData?.node ?? 'unknown'

      // TODO: get and log credentials used.
      // See
      // - https://github.com/n8n-io/n8n/blob/master/packages/%40n8n/nodes-langchain/nodes/tools/ToolWorkflow/v2/utils/WorkflowToolService.ts#L214
      // - https://github.com/n8n-io/n8n/blob/master/packages/workflow/src/TelemetryHelpers.ts#L487
      // - https://github.com/n8n-io/n8n/blob/master/packages/workflow/src/Interfaces.ts#L186
      // - https://github.com/n8n-io/n8n/blob/master/packages/core/src/execution-engine/workflow-execute.ts#L1065
      // const credentials = workflow.nodes[node.name]?.credentials ?? "none"
      // console.debug(`${LOGPREFIX}: ???? credentials:`, credentials)
      // Credentials for AI Agent nodes are in the subnode, e.g. "Open AI Agent"
      // Currently runNode does not get called for the subnodes so we don't see
      // the credentials. One solution is to check the data sent in the runNode args
      // to see if the current node has subnodes with credentials?

      // let credInfo = "none"
      // if (node?.credentials && typeof node.credentials === "object") {
      //   const credTypes = Object.keys(node.credentials)
      //   if (credTypes.length) {
      //     credInfo = credTypes
      //       .map((type) => {
      //         const cred = node.credentials?.[type]
      //         return cred && typeof cred === "object"
      //           ? cred.name ?? `${type} (id:${cred?.id ?? "unknown"})`
      //           : type
      //       })
      //       .join(", ")
      //   }
      // }

      const executionId = additionalData?.executionId ?? 'unknown'
      const sessionId = deriveSessionId(executionId)
      const userId = additionalData?.userId ?? 'unknown'
      const nodeAttributes = {
        'n8n.workflow.id': workflow?.id ?? 'unknown',
        'n8n.execution.id': executionId,
        'n8n.session.id': sessionId,
        'n8n.user.id': userId,
        'n8n.node.name': node?.name || 'unknown',
        // "n8n.credentials": credInfo || "none",
      }

      // Flatten the n8n node object into a single level of attributes
      const flattenedNode = flatten(node ?? {}, { delimiter: '.' })
      for (const [key, value] of Object.entries(flattenedNode)) {
        if (typeof value === 'string' || typeof value === 'number') {
          nodeAttributes[`n8n.node.${key}`] = value
        } else {
          nodeAttributes[`n8n.node.${key}`] = JSON.stringify(value)
        }
      }

      // Debug logging, uncomment as needed
      if (DEBUG) {
        console.debug(`${LOGPREFIX} Executing node:`, node.name)
        // console.debug(`${LOGPREFIX}: executing n8n node with attributes:`, nodeAttributes)
        // console.debug(`${LOGPREFIX}: executing n8n node:`, node)
        // console.debug(`${LOGPREFIX}: additionalData:`, additionalData)
        // console.debug(`${LOGPREFIX}: runExecutionData:`, runExecutionData)
        // console.debug(`${LOGPREFIX}: workflow:`, workflow)
        // console.debug(`${LOGPREFIX}: executionData:`, executionData)
        // console.debug(`${LOGPREFIX}: runIndex:`, runIndex)
        // console.debug(`${LOGPREFIX}: mode:`, mode)
        // console.debug(`${LOGPREFIX}: executionData data:`, JSON.stringify(executionData.data))
        // console.debug(`${LOGPREFIX}: executionData source:`, JSON.stringify(executionData.source))
      }

      // Determine Langfuse observation type (attribute + optional span name decoration)
      let observationType
      if (MAP_LANGFUSE_OBSERVATION_TYPES) {
        observationType = mapNodeToObservationType(node?.type, nodeAttributes)
        if (observationType) {
          nodeAttributes['langfuse.observation.type'] = observationType
          nodeAttributes['n8n.langfuse.observation.type'] = observationType
        }
      }

      let nodeSpanName
      if (USE_NODE_NAME_SPAN) {
        // Use raw node name for maximum readability; fall back if missing
        nodeSpanName = node?.name || 'unknown-node'
      } else if (LANGFUSE_TYPE_IN_NODE_SPAN_NAME && observationType) {
        nodeSpanName = `n8n.node.${observationType}.execute`
      } else {
        nodeSpanName = 'n8n.node.execute'
      }

      return tracer.startActiveSpan(
        nodeSpanName,
        { attributes: nodeAttributes, kind: SpanKind.INTERNAL },
        async (nodeSpan) => {
          // Capture node input *before* execution
          if (CAPTURE_IO) {
            try {
              const inputObj = extractNodeInput(node)
              if (inputObj) {
                const inputStr = truncateIO(safeJSONStringify(inputObj))
                nodeSpan.setAttribute('langfuse.observation.input', inputStr)
                // Secondary semantic attribute for GenAI tooling
                nodeSpan.setAttribute('gen_ai.prompt', inputStr)
              }
            } catch (e) {
              if (DEBUG)
                console.warn('[Tracing] Failed to capture node input', e)
            }
          }
          try {
            const result = await originalRunNode.apply(this, [
              workflow,
              executionData,
              runExecutionData,
              runIndex,
              additionalData,
              mode,
              abortSignal,
            ])
            try {
              const outputData = result?.data?.[runIndex]
              const finalJson = outputData?.map((item) => item.json)
              nodeSpan.setAttribute(
                'n8n.node.output_json',
                JSON.stringify(finalJson),
              )
              if (CAPTURE_IO) {
                const extracted = extractNodeOutput(result, runIndex)
                if (extracted) {
                  const outputStr = truncateIO(safeJSONStringify(extracted))
                  nodeSpan.setAttribute(
                    'langfuse.observation.output',
                    outputStr,
                  )
                  nodeSpan.setAttribute('gen_ai.completion', outputStr)
                }
              }
            } catch (error) {
              console.warn('Failed to set node output attributes: ', error)
            }
            return result
          } catch (error) {
            nodeSpan.recordException(error)
            nodeSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: String(error.message || error),
            })
            nodeSpan.setAttribute('n8n.node.status', 'error')
            throw error
          } finally {
            nodeSpan.end()
          }
        },
      )
    }
  } catch (e) {
    console.error('Failed to set up n8n OpenTelemetry instrumentation:', e)
  	}
	}
}
