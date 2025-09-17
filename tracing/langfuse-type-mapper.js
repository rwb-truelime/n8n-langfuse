'use strict';

/**
 * Langfuse Observation Type Mapper for n8n Nodes
 *
 * Returns a type string from the Langfuse allowed list:
 * [ 'agent', 'tool', 'chain', 'retriever', 'generation', 'embedding', 'evaluator', 'guardrail', 'event', 'span' ]
 *
 * Priority:
 *   - Exact match sets
 *   - Regex heuristics
 *   - Category fallback
 */

// Allowed Langfuse types (for reference)
const OBS_TYPES = Object.freeze([
  'agent',
  'tool',
  'chain',
  'retriever',
  'generation',
  'embedding',
  'evaluator',
  'guardrail',
  'event',
  'span',
]);

// Node type exact match sets
const EXACT_SETS = {
  agent:        new Set(['Agent', 'AgentTool']),
  generation:   new Set(['LmChatOpenAi', 'LmOpenAi', 'OpenAi', 'Anthropic', 'GoogleGemini', 'Groq', 'Perplexity', 'LmChatAnthropic', 'LmChatGoogleGemini', 'LmChatMistralCloud', 'LmChatOpenRouter', 'LmChatXAiGrok', 'OpenAiAssistant']),
  embedding:    new Set(['EmbeddingsAwsBedrock', 'EmbeddingsAzureOpenAi', 'EmbeddingsCohere', 'EmbeddingsGoogleGemini', 'EmbeddingsGoogleVertex', 'EmbeddingsHuggingFaceInference', 'EmbeddingsMistralCloud', 'EmbeddingsOllama', 'EmbeddingsOpenAi']),
  retriever:    new Set(['RetrieverContextualCompression', 'RetrieverMultiQuery', 'RetrieverVectorStore', 'RetrieverWorkflow', 'MemoryChatRetriever',
                         'VectorStoreInMemory','VectorStoreInMemoryInsert','VectorStoreInMemoryLoad','VectorStoreMilvus','VectorStoreMongoDBAtlas','VectorStorePGVector',
                         'VectorStorePinecone','VectorStorePineconeInsert','VectorStorePineconeLoad','VectorStoreQdrant','VectorStoreSupabase','VectorStoreSupabaseInsert','VectorStoreSupabaseLoad',
                         'VectorStoreWeaviate','VectorStoreZep','VectorStoreZepInsert','VectorStoreZepLoad']),
  evaluator:    new Set(['SentimentAnalysis', 'TextClassifier', 'InformationExtractor', 'RerankerCohere', 'OutputParserAutofixing']),
  guardrail:    new Set(['GooglePerspective', 'AwsRekognition']),
  chain:        new Set(['ChainLlm', 'ChainRetrievalQa', 'ChainSummarization', 'ToolWorkflow', 'ToolExecutor', 'ModelSelector', 'OutputParserStructured', 'OutputParserItemList', 'OutputParserAutofixing',
                         'TextSplitterCharacterTextSplitter', 'TextSplitterRecursiveCharacterTextSplitter', 'TextSplitterTokenSplitter', 'ToolThink']),
};

// Regex heuristics
const REGEX_RULES = [
  { type: 'agent',      pattern: /agent/i },
  { type: 'embedding',  pattern: /embedding/i },
  { type: 'retriever',  pattern: /(retriev|vectorstore)/i },
  { type: 'generation', pattern: /(lmchat|^lm[a-z]|chat|openai|anthropic|gemini|mistral|groq|cohere)/i },
  { type: 'tool',       pattern: /tool/ },
  { type: 'chain',      pattern: /(chain|textsplitter|parser|memory|workflow)/i },
  { type: 'evaluator',  pattern: /(rerank|classif|sentiment|extract)/i },
  { type: 'guardrail',  pattern: /(perspective|rekognition|moderation|guardrail)/i },
];

// Internal logic nodes fallback mapping
const INTERNAL_LOGIC = new Set([
  'If',
  'Switch',
  'Set',
  'Move',
  'Rename',
  'Wait',
  'WaitUntil',
  'Function',
  'FunctionItem',
  'Code',
  'NoOp',
  'ExecuteWorkflow',
  'SubworkflowTo',
]);

function categoryFallback(type, category) {
  switch (category) {
    case 'Trigger Nodes':
      return 'event';
    case 'Transform Nodes':
      return 'chain';
    case 'AI/LangChain Nodes':
      return 'chain';
    case 'Core Nodes': {
      if (INTERNAL_LOGIC.has(type)) return 'chain';
      if (type === 'Schedule' || type === 'Cron') return 'event';
      return 'tool';
    }
    default:
      return undefined;
  }
}

/**
 * Main mapping function
 * @param {string} nodeType
 * @param {object} nodeAttributes (optional, can include 'n8n.node.category')
 * @returns {string|undefined} one of OBS_TYPES or undefined
 */
function mapNodeToObservationType(nodeType, nodeAttributes) {
  if (!nodeType || typeof nodeType !== 'string') return undefined;
  const original = nodeType;

  // 1. Exact sets
  for (const [obsType, set] of Object.entries(EXACT_SETS)) {
    if (set.has(original)) return obsType;
  }

  // 2. Regex heuristics
  const lower = original.toLowerCase();
  for (const rule of REGEX_RULES) {
    if (rule.pattern.test(lower)) return rule.type;
  }

  // 3. Category fallback
  const category = nodeAttributes?.['n8n.node.category'] || nodeAttributes?.['n8n.node.category_raw'];
  const fromCategory = categoryFallback(original, category);
  if (fromCategory) return fromCategory;

  // 4. No match => undefined (caller can default to 'span')
  return undefined;
}

module.exports = { mapNodeToObservationType, OBS_TYPES };
