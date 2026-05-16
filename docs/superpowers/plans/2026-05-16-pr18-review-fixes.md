# PR #18 Review Issues Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address all 20 review issues from PR #18 (excluding CHANGELOG entry)

**Architecture:** Systematic fixes across 6 source files and 2 test files, organized by severity and file grouping. Medium-priority issues first, then low-priority.

**Tech Stack:** TypeScript ESM, Node.js native test runner, native fetch

---

## File Structure

**Modified files:**
- `src/plugin.ts` — 6 issues (fallback operator, metadata validation, magic constants, as const, tool defaults, array ordering)
- `src/models.ts` — 4 issues (cache key, sensitive logs, DRY violation, candidate explosion)
- `src/models-dev.ts` — 2 issues (metadata tracking, trailing newline)
- `src/omniroute-combos.ts` — 2 issues (log injection, DRY splitModelId)
- `src/types.ts` — 2 issues (provider fields shape, variants type)
- `src/logger.ts` — 1 issue (synchronous I/O)
- `test/models.test.mjs` — 3 test gaps (temperature/reasoning, variant+alias, subscription fallback)
- `test/plugin.test.mjs` — 1 issue (hardcoded ports)

---

## Chunk 1: Critical Fixes (Medium Priority)

### Task 1: Fix API Key Fallback Operator

**Files:**
- Modify: `src/plugin.ts:45`

**Issue:** `||` treats empty string `""` as falsy and falls back to env var unexpectedly.

- [ ] **Step 1: Update fallback operator**

```typescript
// Change from:
const apiKey = auth?.key || process.env.OMNIROUTE_API_KEY;
// To:
const apiKey = auth?.key ?? process.env.OMNIROUTE_API_KEY;
```

- [ ] **Step 2: Verify no other `||` fallback patterns exist**

Run: `grep -n "|| process.env" src/*.ts`
Expected: No matches (or only intentional ones)

- [ ] **Step 3: Commit**

```bash
git add src/plugin.ts
git commit -m "fix: use nullish coalescing for API key fallback"
```

---

### Task 2: Add Runtime Validation for modelMetadata

**Files:**
- Modify: `src/plugin.ts:351-379` (mergeModelMetadata function)
- Modify: `src/types.ts` (if needed for validator types)

**Issue:** `metadata as OmniRouteModelMetadata` casts without validation.

- [ ] **Step 1: Create metadata validation helper**

Add to `src/plugin.ts` after `isRecord` function:

```typescript
function isValidModelMetadata(value: unknown): value is OmniRouteModelMetadata {
  if (!isRecord(value)) return false;
  
  // Only validate boolean fields if present
  const booleanFields = [
    'supportsStreaming', 'supportsVision', 'supportsTools',
    'supportsTemperature', 'supportsReasoning', 'supportsAttachment'
  ];
  
  for (const field of booleanFields) {
    if (field in value && typeof value[field] !== 'boolean') {
      return false;
    }
  }
  
  // Validate numeric fields
  if ('contextWindow' in value && typeof value.contextWindow !== 'number') return false;
  if ('maxTokens' in value && typeof value.maxTokens !== 'number') return false;
  
  return true;
}
```

- [ ] **Step 2: Update mergeModelMetadata to validate**

```typescript
// In mergeModelMetadata, replace:
merged[id] = {
  ...(generated[id] ?? {}),
  ...(metadata as OmniRouteModelMetadata),
};
// With:
if (isValidModelMetadata(metadata)) {
  merged[id] = {
    ...(generated[id] ?? {}),
    ...metadata,
  };
} else {
  warn(`Invalid metadata for model "${id}", skipping`);
}
```

- [ ] **Step 3: Build and test**

Run: `npm run build`
Expected: No errors

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/plugin.ts
git commit -m "fix: add runtime validation for modelMetadata merge"
```

---

### Task 3: Fix Cache Key to Include modelsDev Config

**Files:**
- Modify: `src/models.ts:36-39` (getCacheKey function)

**Issue:** Different `modelsDev` configs share same cache key.

- [ ] **Step 1: Update getCacheKey to hash config**

```typescript
function getCacheKey(config: OmniRouteConfig, apiKey: string): string {
  const baseUrl = config.baseUrl || OMNIROUTE_ENDPOINTS.BASE_URL;
  
  // Include modelsDev config in cache key
  const modelsDevHash = config.modelsDev 
    ? JSON.stringify({
        enabled: config.modelsDev.enabled,
        url: config.modelsDev.url,
        providerAliases: config.modelsDev.providerAliases,
      })
    : '';
  
  return `${baseUrl}:${apiKey}:${modelsDevHash}`;
}
```

- [ ] **Step 2: Add test for cache key differentiation**

In `test/models.test.mjs`, add:

```javascript
test('fetchModels uses different cache for different modelsDev configs', async () => {
  let calls = 0;
  global.fetch = async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('/v1/models')) {
      calls++;
      return new Response(
        JSON.stringify({ object: 'list', data: [{ id: `model-${calls}`, name: `Model ${calls}` }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };

  const config1 = { ...CONFIG, modelsDev: { enabled: true, providerAliases: { oai: 'openai' } } };
  const config2 = { ...CONFIG, modelsDev: { enabled: true, providerAliases: { oai: 'anthropic' } } };

  await fetchModels(config1, CONFIG.apiKey, false);
  await fetchModels(config2, CONFIG.apiKey, false);

  assert.equal(calls, 2, 'Should fetch twice for different modelsDev configs');
});
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/models.ts test/models.test.mjs
git commit -m "fix: include modelsDev config in cache key"
```

---

### Task 4: Fix DRY Violation - Extract splitModelId

**Files:**
- Modify: `src/omniroute-combos.ts:227-248` — Export the function
- Modify: `src/models.ts:340-359` — Remove duplicate, import and use

**Issue:** `splitModelId` and `splitOmniRouteModelForLookup` are identical.

- [ ] **Step 1: Export splitModelId from omniroute-combos.ts**

Change:
```typescript
function splitModelId(...) { ... }
```
To:
```typescript
export function splitModelId(...) { ... }
```

- [ ] **Step 2: Remove duplicate from models.ts and import**

In `src/models.ts`:
1. Add to imports from `omniroute-combos.ts`:
```typescript
import { splitModelId } from './omniroute-combos.js';
```

2. Remove `splitOmniRouteModelForLookup` function entirely.

3. Replace usage:
```typescript
const { providerKey, modelKey } = splitOmniRouteModelForLookup(model.id);
```
With:
```typescript
const { providerKey, modelKey } = splitModelId(model.id);
```

- [ ] **Step 3: Build and test**

Run: `npm run build`
Expected: No errors

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/models.ts src/omniroute-combos.ts
git commit -m "refactor: extract splitModelId to eliminate DRY violation"
```

---

### Task 5: Fix supportsTools Default Inconsistency

**Files:**
- Modify: `src/plugin.ts:432` (toProviderModel)
- Modify: `src/models-dev.ts:331` (calculateLowestCommonCapabilities)

**Issue:** `toProviderModel` defaults tools to true, combo logic defaults to false.

- [ ] **Step 1: Document and align the defaults**

In `src/plugin.ts`, add comment:
```typescript
// Default to true: if API doesn't explicitly say no tools, assume capability exists
// This aligns with OpenAI-compatible behavior where most models support tools
const supportsTools = model.supportsTools !== false;
```

In `src/models-dev.ts`, update combo logic:
```typescript
// For combos: only advertise tools if ALL underlying models explicitly support them
// This is intentionally stricter than single-model defaults because a combo
// with one tool-less model cannot reliably use tools across all backends
const supportsTools = model.tool_call === true;
```

- [ ] **Step 2: Commit**

```bash
git add src/plugin.ts src/models-dev.ts
git commit -m "docs: document supportsTools default rationale"
```

---

### Task 6: Fix Array Metadata Ordering

**Files:**
- Modify: `src/plugin.ts:351-379` (mergeModelMetadata)

**Issue:** Generated blocks prepended — verify if OpenCode uses first or last match wins.

- [ ] **Step 1: Research OpenCode matching logic**

Check `@opencode-ai/plugin` source or documentation for `modelMetadata` array processing.

- [ ] **Step 2: If last-match-wins, reverse order**

```typescript
// If OpenCode uses last-match-wins, user config should come last
return [...userConfig, ...generatedBlocks];
```

- [ ] **Step 3: Commit**

```bash
git add src/plugin.ts
git commit -m "fix: correct modelMetadata array ordering for OpenCode matching"
```

---

### Task 7: Verify Provider Model Fields Match OpenCode Shape

**Files:**
- Modify: `src/types.ts:111-155`

**Issue:** New fields may not match `@opencode-ai/plugin` expectations.

- [ ] **Step 1: Check OpenCode plugin types**

Run: `npm ls @opencode-ai/plugin` or check node_modules for exact interface.

- [ ] **Step 2: Rename fields if needed**

If `tool_call` should be `toolCall`:
```typescript
// In OmniRouteProviderModel:
toolCall?: boolean; // instead of tool_call
```

Update all references in `src/plugin.ts` accordingly.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts src/plugin.ts
git commit -m "fix: align provider model fields with OpenCode plugin types"
```

---

### Task 8: Tighten Variants Type

**Files:**
- Modify: `src/types.ts:154`

**Issue:** `Record<string, unknown>` is too permissive.

- [ ] **Step 1: Define strict variant types**

```typescript
export interface OmniRouteModelVariant {
  reasoningEffort?: 'low' | 'medium' | 'high';
  // Future variant types can be added here
}

// In OmniRouteProviderModel:
variants: Record<string, OmniRouteModelVariant>;
```

- [ ] **Step 2: Update toProviderModel**

```typescript
variants: supportsReasoning
  ? {
      low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' },
      high: { reasoningEffort: 'high' },
    }
  : {},
```

- [ ] **Step 3: Build and test**

Run: `npm run build`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/plugin.ts
git commit -m "types: tighten variants type to prevent invalid reasoning effort values"
```

---

## Chunk 2: Low Priority Fixes

### Task 9: Fix Sensitive Data in Log

**Files:**
- Modify: `src/models.ts:102`

**Issue:** `JSON.stringify(rawData)` could leak sensitive data.

- [ ] **Step 1: Replace with shape-only logging**

```typescript
// Change from:
warn(`Invalid models response structure: ${JSON.stringify(rawData)}`);
// To:
const dataType = rawData && typeof rawData === 'object' 
  ? (Array.isArray(rawData.data) ? 'array' : typeof rawData.data)
  : typeof rawData;
warn(`Invalid models response structure: expected { data: Array }, got { data: ${dataType} }`);
```

- [ ] **Step 2: Commit**

```bash
git add src/models.ts
git commit -m "fix: avoid logging sensitive response data in models fetch error"
```

---

### Task 10: Fix Log Injection via Model IDs

**Files:**
- Modify: `src/omniroute-combos.ts:55` and other log lines

**Issue:** Model IDs from external API interpolated without sanitization.

- [ ] **Step 1: Add sanitization helper**

```typescript
function sanitizeForLog(value: string): string {
  return value.replace(/[\r\n]/g, '');
}
```

- [ ] **Step 2: Apply to all interpolated model IDs**

Search for `model.id` in log lines and wrap with sanitizeForLog:
```typescript
warn(`Could not resolve ${unresolvedModels.length} underlying models for "${sanitizeForLog(model.id)}": ${unresolvedModels.map(sanitizeForLog).join(', ')}`);
```

- [ ] **Step 3: Commit**

```bash
git add src/omniroute-combos.ts
git commit -m "fix: sanitize model IDs in log messages to prevent injection"
```

---

### Task 11: Fix Synchronous File I/O in Logger

**Files:**
- Modify: `src/logger.ts`

**Issue:** `appendFileSync` blocks event loop.

- [ ] **Step 1: Switch to async logging**

```typescript
// Replace appendFileSync with fire-and-forget appendFile
import { appendFile } from 'fs/promises';

export function warn(message: string): void {
  const logFile = getLogFile();
  if (!logFile) return;
  
  const line = formatLogLine('WARN', message);
  // Fire-and-forget: don't await, don't crash on error
  appendFile(logFile, line).catch(() => {});
}

export function debug(message: string): void {
  if (process.env.OMNIROUTE_DEBUG !== '1') return;
  
  const logFile = getLogFile();
  if (!logFile) return;
  
  const line = formatLogLine('DEBUG', message);
  appendFile(logFile, line).catch(() => {});
}
```

- [ ] **Step 2: Commit**

```bash
git add src/logger.ts
git commit -m "perf: use async file I/O for logger to prevent event loop blocking"
```

---

### Task 12: Optimize Candidate Explosion in Lookup

**Files:**
- Modify: `src/models.ts:290-307`

**Issue:** Up to 8 candidates per model key, ~19k lookups.

- [ ] **Step 1: Add early-exit for aliases that resolve to same key**

```typescript
function getModelLookupCandidates(modelKey: string): string[] {
  const candidates = new Set<string>();
  
  const addCandidate = (key: string): void => {
    const lower = key.toLowerCase();
    const normalized = normalizeModelKey(key);
    const aliasResolved = resolveModelAlias(key);
    
    candidates.add(lower);
    candidates.add(normalized);
    
    // Only add alias variants if they differ from original
    if (aliasResolved !== key) {
      candidates.add(aliasResolved.toLowerCase());
      candidates.add(normalizeModelKey(aliasResolved));
    }
  };

  addCandidate(modelKey);

  const { base, stripped } = stripVariantSuffix(modelKey);
  if (stripped) {
    addCandidate(base);
  }

  return [...candidates];
}
```

- [ ] **Step 2: Commit**

```bash
git add src/models.ts
git commit -m "perf: avoid duplicate lookup candidates when alias resolves to same key"
```

---

### Task 13: Fix Magic Constant 4096

**Files:**
- Modify: `src/plugin.ts:486-487`
- Modify: `src/constants.ts` — Add constants

**Issue:** `4096` used without named constant.

- [ ] **Step 1: Add named constants**

In `src/constants.ts`:
```typescript
export const DEFAULT_CONTEXT_LIMIT = 4096;
export const DEFAULT_OUTPUT_LIMIT = 4096;
```

- [ ] **Step 2: Update plugin.ts to use constants**

```typescript
import { DEFAULT_CONTEXT_LIMIT, DEFAULT_OUTPUT_LIMIT } from './constants.js';

// In toProviderModel:
limit: {
  context: model.contextWindow ?? DEFAULT_CONTEXT_LIMIT,
  output: model.maxTokens ?? DEFAULT_OUTPUT_LIMIT,
},
```

- [ ] **Step 3: Commit**

```bash
git add src/constants.ts src/plugin.ts
git commit -m "refactor: extract magic constant 4096 to named defaults"
```

---

### Task 14: Remove Redundant `as const` Assertions

**Files:**
- Modify: `src/plugin.ts:447-449`

**Issue:** `as const` is redundant given the type definition.

- [ ] **Step 1: Remove assertions**

```typescript
// Change from:
modalities: {
  input: supportsVision ? ['text', 'image'] as const : ['text'] as const,
  output: ['text'] as const,
},

// To:
modalities: {
  input: supportsVision ? ['text', 'image'] : ['text'],
  output: ['text'],
},
```

- [ ] **Step 2: Verify types still compile**

Run: `npx tsc --noEmit src/plugin.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/plugin.ts
git commit -m "style: remove redundant as const assertions"
```

---

### Task 15: Add Test for Single Model Metadata Tracking

**Files:**
- Modify: `test/models.test.mjs`

**Issue:** Early return bypasses metadata tracking logic.

- [ ] **Step 1: Add test verifying consistency**

```javascript
test('calculateLowestCommonCapabilities produces identical output for single model and combo-with-self', () => {
  const single = calculateLowestCommonCapabilities([
    { id: 'test-model', temperature: true, reasoning: true, attachment: true }
  ]);
  
  const combo = calculateLowestCommonCapabilities([
    { id: 'test-model', temperature: true, reasoning: true, attachment: true },
    { id: 'test-model', temperature: true, reasoning: true, attachment: true }
  ]);
  
  assert.deepEqual(single, combo);
});
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add test/models.test.mjs
git commit -m "test: verify single-model and combo-with-self produce identical capabilities"
```

---

### Task 16: Add Trailing Newline to models-dev.ts

**Files:**
- Modify: `src/models-dev.ts:480`

**Issue:** File ends without trailing newline.

- [ ] **Step 1: Add newline**

Simply ensure the file ends with a newline character.

- [ ] **Step 2: Commit**

```bash
git add src/models-dev.ts
git commit -m "style: add trailing newline to models-dev.ts"
```

---

## Chunk 3: Test Coverage Gaps

### Task 17: Add Temperature/Reasoning Combo Tests

**Files:**
- Modify: `test/models.test.mjs`

**Issue:** Missing tests for temperature and reasoning logic.

- [ ] **Step 1: Add temperature tests**

```javascript
test('calculateLowestCommonCapabilities handles temperature with mixed defined/undefined', () => {
  const capabilities = calculateLowestCommonCapabilities([
    { id: 'with-temp', temperature: true },
    { id: 'without-temp' },
  ]);

  assert.equal(capabilities.supportsTemperature, true);
});

test('calculateLowestCommonCapabilities respects explicit temperature false', () => {
  const capabilities = calculateLowestCommonCapabilities([
    { id: 'with-temp', temperature: true },
    { id: 'no-temp', temperature: false },
  ]);

  assert.equal(capabilities.supportsTemperature, false);
});

test('calculateLowestCommonCapabilities handles all three capabilities together', () => {
  const capabilities = calculateLowestCommonCapabilities([
    { id: 'full', temperature: true, reasoning: true, attachment: true },
    { id: 'limited', temperature: false, reasoning: false, attachment: false },
  ]);

  assert.equal(capabilities.supportsTemperature, false);
  assert.equal(capabilities.supportsReasoning, false);
  assert.equal(capabilities.supportsAttachment, false);
});

test('calculateLowestCommonCapabilities handles single model with undefined temperature', () => {
  const capabilities = calculateLowestCommonCapabilities([
    { id: 'no-meta' },
  ]);

  assert.equal(capabilities.supportsTemperature, undefined);
});
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add test/models.test.mjs
git commit -m "test: add temperature and reasoning combo capability tests"
```

---

### Task 18: Add Variant+Alias Integration Tests

**Files:**
- Modify: `test/models.test.mjs`

**Issue:** No test for variant suffix stripping + alias resolution.

- [ ] **Step 1: Add integration test**

```javascript
test('variant suffix stripping with alias resolution works end-to-end', async () => {
  global.fetch = async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('/v1/models')) {
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'moonshotai/kimi-k2.6-thinking-high', name: 'Kimi K2.6 Thinking High' }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('models.dev')) {
      return new Response(
        JSON.stringify({
          moonshotai: {
            models: {
              'kimi-k2-thinking': {
                id: 'kimi-k2-thinking',
                name: 'Kimi K2 Thinking',
                temperature: true,
                reasoning: true,
              }
            }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };

  const models = await fetchModels(CONFIG, CONFIG.apiKey, true);
  const model = models.find(m => m.id === 'moonshotai/kimi-k2.6-thinking-high');
  
  assert.ok(model, 'Model should be found');
  assert.equal(model.supportsReasoning, true, 'Should resolve alias and enrich capabilities');
});
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add test/models.test.mjs
git commit -m "test: add variant suffix and alias resolution integration test"
```

---

### Task 19: Add Subscription Fallback Tests

**Files:**
- Modify: `test/models.test.mjs`

**Issue:** No test for subscription provider fallback.

- [ ] **Step 1: Add subscription fallback test**

```javascript
test('subscription fallback enriches from public provider', async () => {
  global.fetch = async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('/v1/models')) {
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'zai-coding-plan/gpt-4o', name: 'GPT-4o via ZAI' }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('models.dev')) {
      return new Response(
        JSON.stringify({
          zai: {
            models: {
              'gpt-4o': {
                id: 'gpt-4o',
                name: 'GPT-4o',
                temperature: true,
                tool_call: true,
              }
            }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };

  const models = await fetchModels(CONFIG, CONFIG.apiKey, true);
  const model = models.find(m => m.id === 'zai-coding-plan/gpt-4o');
  
  assert.ok(model, 'Model should be found');
  assert.equal(model.supportsTemperature, true, 'Should fallback to zai provider');
  assert.equal(model.supportsTools, true, 'Should inherit tools from fallback');
});
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add test/models.test.mjs
git commit -m "test: add subscription fallback provider test"
```

---

### Task 20: Fix Hardcoded Ports in Tests

**Files:**
- Modify: `test/plugin.test.mjs`

**Issue:** Hardcoded ports like `20129`, `20130`, `20131`.

- [ ] **Step 1: Add test helper for dummy URLs**

At top of test file:
```javascript
function getDummyBaseUrl(port = 20128) {
  return `http://localhost:${port}/v1`;
}
```

- [ ] **Step 2: Replace hardcoded ports with helper**

Search for `http://localhost:20` and replace with `getDummyBaseUrl()` calls.

- [ ] **Step 3: Commit**

```bash
git add test/plugin.test.mjs
git commit -m "test: replace hardcoded ports with helper function"
```

---

## Chunk 4: Final Verification

### Task 21: Full Build and Test

- [ ] **Step 1: Clean build**

Run: `npm run clean && npm run build`
Expected: Success

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: All tests pass (target: 40+ tests)

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Lint check**

Run: `npm run lint` (if available)
Expected: No errors

- [ ] **Step 5: Final commit summary**

```bash
git log --oneline -20
```

---

## Summary

**Total tasks:** 21 (20 fixes + 1 verification)
**Estimated commits:** 20
**Estimated time:** 2-3 hours

### Priority Order:
1. **Medium priority first** (Tasks 1-8): Core functionality and type safety
2. **Low priority fixes** (Tasks 9-16): Logging, performance, style
3. **Test coverage** (Tasks 17-20): Fill testing gaps
4. **Verification** (Task 21): Ensure everything works

### Key Decisions:
- Use `??` instead of `||` for API key fallback
- Keep `supportsTools` defaults as-is but document rationale
- Export `splitModelId` from `omniroute-combos.ts`
- Include `modelsDev` config in cache key hash
- Tighten `variants` type to `OmniRouteModelVariant`
- Add comprehensive test coverage for temperature/reasoning combos
