import type { OmniRouteConfig, OmniRouteModel, OmniRouteModelMetadata, OmniRouteModelsResponse } from './types.js';
import {
  OMNIROUTE_DEFAULT_MODELS,
  OMNIROUTE_ENDPOINTS,
  MODEL_CACHE_TTL,
  REQUEST_TIMEOUT,
} from './constants.js';
import { getModelsDevIndex, normalizeModelKey, getSubscriptionFallback, stripVariantSuffix, MODEL_ALIASES } from './models-dev.js';
import type { ModelsDevIndex } from './models-dev.js';
import { enrichComboModels, clearComboCache } from './omniroute-combos.js';
import { warn, debug } from './logger.js';

/**
 * Model cache entry
 */
interface ModelCache {
  models: OmniRouteModel[];
  timestamp: number;
}

/**
 * In-memory model cache keyed by endpoint and API key
 */
const modelCache = new Map<string, ModelCache>();

/**
 * Generate a cache key for a given configuration
 */
function getCacheKey(config: OmniRouteConfig, apiKey: string): string {
  const baseUrl = config.baseUrl || OMNIROUTE_ENDPOINTS.BASE_URL;
  return `${baseUrl}:${apiKey}`;
}

/**
 * Fetch models from OmniRoute /v1/models endpoint
 * This is the CRITICAL FEATURE - dynamically fetches available models
 *
 * @param config - OmniRoute configuration
 * @param apiKey - API key for authentication
 * @returns Array of available models
 */
export async function fetchModels(
  config: OmniRouteConfig,
  apiKey: string,
  forceRefresh: boolean = false,
): Promise<OmniRouteModel[]> {
  const cacheKey = getCacheKey(config, apiKey);

  // Check cache first if not forcing refresh
  if (!forceRefresh) {
    // Validate TTL is positive to prevent unexpected cache behavior
    const cacheTtl =
      config.modelCacheTtl && config.modelCacheTtl > 0 ? config.modelCacheTtl : MODEL_CACHE_TTL;

    const cached = modelCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < cacheTtl) {
      debug('Using cached models');
      return cached.models;
    }
  } else {
    debug('Forcing model refresh');
  }

  // Use default baseUrl if not provided to prevent undefined URL
  const baseUrl = config.baseUrl || OMNIROUTE_ENDPOINTS.BASE_URL;
  const modelsUrl = `${baseUrl}${OMNIROUTE_ENDPOINTS.MODELS}`;

  debug(`Fetching models from ${modelsUrl}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      // Sanitize error - only log status, not response body
      warn(`Failed to fetch models: ${response.status} ${response.statusText}`);
      throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    }

    // Parse and validate response structure before type casting
    const rawData = await response.json();

    // Runtime validation to ensure API returns expected structure
    if (!rawData || typeof rawData !== 'object' || !Array.isArray(rawData.data)) {
      warn(`Invalid models response structure: ${JSON.stringify(rawData)}`);
      throw new Error('Invalid models response structure: expected { data: Array }');
    }

    const data = rawData as OmniRouteModelsResponse;

    // Transform and validate models - filter out invalid entries
    const rawModels = data.data
      .filter(
        (model): model is OmniRouteModel =>
          model !== null && model !== undefined && typeof model.id === 'string',
      )
      .map((model) => ({
        ...model,
        // Ensure required fields
        id: model.id,
        name: model.name || model.id,
        description: model.description || `OmniRoute model: ${model.id}`,
        // Keep undefined for enrichment to work properly
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        supportsStreaming: model.supportsStreaming,
        supportsVision: model.supportsVision,
        supportsTools: model.supportsTools,
      }));

    // Enrich with models.dev and combo capabilities
    const models = await enrichModelMetadata(rawModels, config);

    // Update cache
    modelCache.set(cacheKey, {
      models,
      timestamp: Date.now(),
    });

    debug(`Successfully fetched ${models.length} models`);
    return models;
  } catch (error) {
    warn(`Error fetching models: ${error}`);

    // Return cached models if available (even if expired)
    const cached = modelCache.get(cacheKey);
    if (cached) {
      debug('Returning expired cached models as fallback');
      return cached.models;
    }

    // Return default models as last resort
    debug('Returning default models as fallback');
    return config.defaultModels || OMNIROUTE_DEFAULT_MODELS;
  } finally {
    // Always clear the timeout to prevent memory leaks
    clearTimeout(timeoutId);
  }
}

/**
 * Clear the model cache
 * @param config - Optional OmniRoute configuration to clear specific cache
 * @param apiKey - Optional API key to clear specific cache
 */
export function clearModelCache(config?: OmniRouteConfig, apiKey?: string): void {
  if (config && apiKey) {
    const cacheKey = getCacheKey(config, apiKey);
    modelCache.delete(cacheKey);
    debug('Model cache cleared for provided configuration');
  } else {
    modelCache.clear();
    debug('All model caches cleared');
  }
  // Also clear combo cache
  clearComboCache();
}

/**
 * Get cached models without fetching
 * @param config - OmniRoute configuration
 * @param apiKey - API key for authentication
 * @returns Cached models or null
 */
export function getCachedModels(config: OmniRouteConfig, apiKey: string): OmniRouteModel[] | null {
  const cacheKey = getCacheKey(config, apiKey);
  return modelCache.get(cacheKey)?.models || null;
}

/**
 * Check if cache is valid
 * @param config - OmniRoute configuration
 * @param apiKey - API key for authentication
 * @returns True if cache is valid
 */
export function isCacheValid(config: OmniRouteConfig, apiKey: string): boolean {
  const cacheKey = getCacheKey(config, apiKey);
  const cached = modelCache.get(cacheKey);
  if (!cached) return false;
  const ttl = config.modelCacheTtl || MODEL_CACHE_TTL;
  return Date.now() - cached.timestamp < ttl;
}

/**
 * Force refresh models from API
 * @param config - OmniRoute configuration
 * @param apiKey - API key for authentication
 * @returns Array of available models
 */
export async function refreshModels(
  config: OmniRouteConfig,
  apiKey: string,
): Promise<OmniRouteModel[]> {
  clearModelCache();
  return fetchModels(config, apiKey, true);
}

/**
 * Enrich model metadata with models.dev data and combo capabilities
 */
async function enrichModelMetadata(
  models: OmniRouteModel[],
  config: OmniRouteConfig,
): Promise<OmniRouteModel[]> {
  const modelsDevIndex = await getModelsDevIndex(config);

  // Apply models.dev metadata enrichment
  const withModelsDev =
    modelsDevIndex === null
      ? models
      : models.map((model) => applyModelsDevMetadata(model, config, modelsDevIndex));

  // Enrich combo models with lowest common capabilities
  const withComboCapabilities = await enrichComboModels(withModelsDev, config, modelsDevIndex);

  return withComboCapabilities;
}

/**
 * Apply models.dev metadata to a model
 */
function applyModelsDevMetadata(
  model: OmniRouteModel,
  config: OmniRouteConfig,
  index: ModelsDevIndex,
): OmniRouteModel {
  const { providerKey, modelKey } = splitOmniRouteModelForLookup(model.id);
  const providerAlias = resolveProviderAlias(providerKey, config);

  // Apply known model name aliases (e.g. kimi-k2.6-thinking → kimi-k2-thinking)
  const resolvedKey = MODEL_ALIASES[modelKey] ?? modelKey;
  const lookupKey = resolvedKey.toLowerCase();
  const normalizedKey = normalizeModelKey(resolvedKey);

  // Try provider-specific exact match first
  let best = providerAlias
    ? index.exactByProvider.get(providerAlias)?.get(lookupKey)
    : undefined;

  // Try provider-specific normalized match
  if (!best && providerAlias) {
    best = index.normalizedByProvider.get(providerAlias)?.get(normalizedKey);
  }

  // Variant suffix stripping: gpt-5.5-xhigh → gpt-5.5
  if (!best) {
    const { base, stripped } = stripVariantSuffix(modelKey);
    if (stripped) {
      const baseKey = base.toLowerCase();
      if (providerAlias) {
        best = index.exactByProvider.get(providerAlias)?.get(baseKey);
      }
      if (!best) {
        const baseGlobalList = index.exactGlobal.get(baseKey);
        best = baseGlobalList?.length === 1 ? baseGlobalList[0] : undefined;
      }
    }
  }

  // Subscription fallback: zai-coding-plan → zai, kimi-for-coding → moonshotai
  if (!best && providerAlias) {
    const fallback = getSubscriptionFallback(providerAlias);
    if (fallback) {
      best = index.exactByProvider.get(fallback)?.get(lookupKey);
      if (!best) {
        best = index.normalizedByProvider.get(fallback)?.get(normalizedKey);
      }
    }
  }

  // Try global exact match (only if single match to avoid ambiguity)
  if (!best) {
    const globalExactList = index.exactGlobal.get(lookupKey);
    best = globalExactList?.length === 1 ? globalExactList[0] : undefined;
  }

  // Try global normalized match (only if single match to avoid ambiguity)
  if (!best) {
    const globalNormList = index.normalizedGlobal.get(normalizedKey);
    best = globalNormList?.length === 1 ? globalNormList[0] : undefined;
  }

  if (!best) return model;

  // Merge capabilities (only fill in missing values)
  return {
    ...model,
    ...(model.contextWindow === undefined && best.limit?.context !== undefined
      ? { contextWindow: best.limit.context }
      : {}),
    ...(model.maxTokens === undefined && best.limit?.output !== undefined
      ? { maxTokens: best.limit.output }
      : {}),
    ...(model.supportsVision === undefined && best.modalities?.input?.includes('image')
      ? { supportsVision: true }
      : {}),
    ...(model.supportsTools === undefined && best.tool_call === true
      ? { supportsTools: true }
      : {}),
    ...(model.supportsStreaming === undefined
      ? { supportsStreaming: true }
      : {}),
    ...(model.supportsTemperature === undefined && best.temperature !== undefined
      ? { supportsTemperature: best.temperature }
      : {}),
    ...(model.supportsReasoning === undefined && best.reasoning !== undefined
      ? { supportsReasoning: best.reasoning }
      : {}),
    ...(model.supportsAttachment === undefined && best.attachment !== undefined
      ? { supportsAttachment: best.attachment }
      : {}),
  };
}

/**
 * Split model ID for models.dev lookup
 */
function splitOmniRouteModelForLookup(
  modelId: string,
): { providerKey: string | null; modelKey: string } {
  const trimmed = modelId.trim();

  // Remove omniroute prefix if present
  const withoutPrefix = trimmed.replace(/^omniroute\//, '');

  // Split by /
  const parts = withoutPrefix.split('/').filter((p) => p.trim() !== '');

  if (parts.length >= 2) {
    return {
      providerKey: parts[0] ?? null,
      modelKey: parts.slice(1).join('/'),
    };
  }

  return { providerKey: null, modelKey: withoutPrefix };
}

/**
 * Resolve provider alias using config
 */
function resolveProviderAlias(
  providerKey: string | null,
  config: OmniRouteConfig,
): string | null {
  if (!providerKey) return null;

  const lower = providerKey.toLowerCase();

  // Default aliases
  const aliases: Record<string, string> = {
    oai: 'openai',
    openai: 'openai',
    cx: 'openai',
    codex: 'openai',
    anthropic: 'anthropic',
    claude: 'anthropic',
    gemini: 'google',
    google: 'google',
    deepseek: 'deepseek',
    mistral: 'mistral',
    xai: 'xai',
    groq: 'groq',
    together: 'together',
    openrouter: 'openrouter',
    perplexity: 'perplexity',
    cohere: 'cohere',
    glmt: 'zai-coding-plan',
    glm: 'zai-coding-plan',
    'kimi-coding': 'moonshotai',
    kmc: 'moonshotai',
    gh: 'google',
    github: 'google',
    ...config.modelsDev?.providerAliases,
  };

  return aliases[lower] ?? lower;
}
