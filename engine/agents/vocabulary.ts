/**
 * Vocabulary routing for agent types.
 *
 * Each agent type gets 15-30 precise domain terms organized in 3-5 clusters.
 * Terms pass the "15-year practitioner test" - a senior engineer would
 * recognize and use every term naturally.
 */

export type VocabularyPayload = {
  agentType: string
  clusters: { name: string; terms: string[] }[]
}

const VOCABULARIES: Record<string, VocabularyPayload> = {
  scout: {
    agentType: 'scout',
    clusters: [
      {
        name: 'graph analysis',
        terms: [
          'call graph',
          'dependency chain',
          'import tree',
          'symbol table',
          'reverse dependency',
        ],
      },
      {
        name: 'code quality',
        terms: [
          'dead code',
          'cyclomatic complexity',
          'coupling',
          'cohesion',
          'code smell',
        ],
      },
      {
        name: 'structure',
        terms: [
          'module boundary',
          'barrel export',
          'circular dependency',
          'namespace',
          'public API surface',
        ],
      },
      {
        name: 'navigation',
        terms: [
          'definition site',
          'usage site',
          'call site',
          'declaration',
          'reference',
        ],
      },
    ],
  },

  oracle: {
    agentType: 'oracle',
    clusters: [
      {
        name: 'versioning',
        terms: [
          'semver',
          'breaking change',
          'deprecation',
          'changelog',
          'release notes',
        ],
      },
      {
        name: 'compatibility',
        terms: [
          'compatibility matrix',
          'peer dependency',
          'polyfill',
          'shim',
          'runtime support',
        ],
      },
      {
        name: 'migration',
        terms: [
          'migration path',
          'upgrade guide',
          'codemod',
          'adapter pattern',
          'feature flag',
        ],
      },
      {
        name: 'API surface',
        terms: [
          'API surface',
          'upstream',
          'downstream',
          'endpoint',
          'schema contract',
        ],
      },
    ],
  },

  kraken: {
    agentType: 'kraken',
    clusters: [
      {
        name: 'test doubles',
        terms: [
          'test fixture',
          'mock',
          'stub',
          'spy',
          'fake',
          'test harness',
        ],
      },
      {
        name: 'assertions',
        terms: [
          'assertion',
          'code coverage',
          'regression',
          'edge case',
          'boundary condition',
        ],
      },
      {
        name: 'type safety',
        terms: [
          'type narrowing',
          'exhaustive check',
          'invariant',
          'type guard',
          'discriminated union',
        ],
      },
      {
        name: 'refactoring',
        terms: [
          'refactor',
          'extract method',
          'inline variable',
          'dead code elimination',
          'encapsulation',
        ],
      },
    ],
  },

  spark: {
    agentType: 'spark',
    clusters: [
      {
        name: 'diagnosis',
        terms: [
          'root cause',
          'minimal reproduction',
          'bisect',
          'stack trace',
          'backtrace',
        ],
      },
      {
        name: 'common bugs',
        terms: [
          'off-by-one',
          'null dereference',
          'race condition',
          'use-after-free',
          'uninitialized variable',
        ],
      },
      {
        name: 'performance',
        terms: [
          'hot path',
          'bottleneck',
          'memory leak',
          'allocation pressure',
          'cache miss',
        ],
      },
      {
        name: 'triage',
        terms: [
          'panic',
          'assertion failure',
          'segfault',
          'deadlock',
          'infinite loop',
        ],
      },
    ],
  },

  architect: {
    agentType: 'architect',
    clusters: [
      {
        name: 'design principles',
        terms: [
          'separation of concerns',
          'dependency inversion',
          'single responsibility',
          'interface boundary',
          'encapsulation',
        ],
      },
      {
        name: 'patterns',
        terms: [
          'event sourcing',
          'circuit breaker',
          'adapter pattern',
          'strategy pattern',
          'observer pattern',
        ],
      },
      {
        name: 'reliability',
        terms: [
          'idempotency',
          'backpressure',
          'graceful degradation',
          'retry budget',
          'timeout cascade',
        ],
      },
      {
        name: 'system boundaries',
        terms: [
          'bounded context',
          'API contract',
          'data ownership',
          'service boundary',
          'integration seam',
        ],
      },
    ],
  },
  researcher: {
    agentType: 'researcher',
    clusters: [
      {
        name: 'source evaluation',
        terms: [
          'primary source',
          'secondary source',
          'peer-reviewed',
          'preprint',
          'citation',
          'credibility',
          'methodology',
          'sample size',
          'replication',
        ],
      },
      {
        name: 'synthesis',
        terms: [
          'corroboration',
          'contradiction',
          'gap',
          'consensus',
          'dissent',
          'meta-analysis',
          'weight of evidence',
          'systematic review',
        ],
      },
      {
        name: 'academic',
        terms: [
          'arXiv',
          'PubMed',
          'DOI',
          'abstract',
          'related work',
          'prior art',
          'state of the art',
          'literature review',
        ],
      },
    ],
  },
}

/**
 * Get the vocabulary payload for a given agent type.
 * Returns undefined if the agent type is not recognized.
 */
export function getVocabulary(agentType: string): VocabularyPayload | undefined {
  return VOCABULARIES[agentType]
}

/**
 * Format a vocabulary payload into a concise prompt section.
 * Returns a string like:
 * "Domain vocabulary: [call graph, dependency chain, import tree, ...]"
 */
export function formatVocabularyPrompt(payload: VocabularyPayload): string {
  const allTerms = payload.clusters.flatMap(c => c.terms)
  return `Domain vocabulary: [${allTerms.join(', ')}]`
}
