import { defineSingleton } from "../../define";

export type ToolSearchField = {
  name: string;
  value: string;
  weight: number;
};

export type ToolSearchDocument = {
  id: string;
  fields: ToolSearchField[];
};

export type ToolSearchFieldMatch = {
  field: string;
  value: string;
  score: number;
};

export type ToolSearchRankedDocument = {
  id: string;
  score: number;
  matches: ToolSearchFieldMatch[];
};

type CompiledToolSearchField = ToolSearchField & {
  normalizedValue: string;
  tokens: string[];
};

type CompiledToolSearchDocument = {
  id: string;
  fields: CompiledToolSearchField[];
  tokens: string[];
};

type ToolSearchTextOps = {
  normalize(params: { value: string }): string;
  tokensFromNormalized(params: { value: string; removeStopWords?: boolean }): string[];
};

function normalizeToolSearchText(params: { value: string }): string {
  return params.value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function roundToolSearchScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function createToolSearchText(): ToolSearchTextOps {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "for",
    "in",
    "my",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
  ]);

  function tokensFromNormalized(params: { value: string; removeStopWords?: boolean }): string[] {
    const tokens = params.value.split(/\s+/).filter(Boolean);
    if (!params.removeStopWords) return [...new Set(tokens)];
    const meaningful = tokens.filter((token) => !stopWords.has(token));
    return [...new Set(meaningful.length > 0 ? meaningful : tokens)];
  }

  return { normalize: normalizeToolSearchText, tokensFromNormalized };
}

type ToolSearchSimilarityParams = {
  query: string;
  candidate: string;
  queryTrigrams: Set<string>;
  candidateTrigrams: Set<string>;
};

function scoreToolSearchSimilarity(params: ToolSearchSimilarityParams): number {
  if (params.query === params.candidate) return 1;
  if (
    Math.min(params.query.length, params.candidate.length) >= 3 &&
    (params.candidate.startsWith(params.query) || params.query.startsWith(params.candidate))
  ) {
    return 0.9;
  }

  const longest = Math.max(params.query.length, params.candidate.length);
  /* v8 ignore next -- empty normalized queries return before similarity scoring */
  if (longest === 0) return 0;
  const minimumDistance = Math.abs(params.query.length - params.candidate.length);

  const editSimilarity = 1 - minimumDistance / longest >= 0.58 ? 1 - distance(params) / longest : 0;
  const trigramSimilarity = trigramDice(params);
  const similarity = Math.max(editSimilarity, trigramSimilarity);
  return similarity >= 0.58 ? similarity * 0.82 : 0;
}

function distance(params: { query: string; candidate: string }): number {
  const columns = params.candidate.length + 1;
  let previousPrevious = new Uint32Array(columns);
  let previous = new Uint32Array(columns);
  let current = new Uint32Array(columns);
  for (let column = 0; column < columns; column++) previous[column] = column;

  for (let row = 1; row <= params.query.length; row++) {
    current[0] = row;
    for (let column = 1; column < columns; column++) {
      const substitution = params.query[row - 1] === params.candidate[column - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + substitution,
      );
      if (
        row > 1 &&
        column > 1 &&
        params.query[row - 1] === params.candidate[column - 2] &&
        params.query[row - 2] === params.candidate[column - 1]
      ) {
        current[column] = Math.min(current[column]!, previousPrevious[column - 2]! + substitution);
      }
    }
    const recycled = previousPrevious;
    previousPrevious = previous;
    previous = current;
    current = recycled;
  }
  return previous[columns - 1]!;
}

function trigramDice(params: ToolSearchSimilarityParams): number {
  if (params.queryTrigrams.size === 0 || params.candidateTrigrams.size === 0) return 0;
  let intersection = 0;
  for (const value of params.queryTrigrams) if (params.candidateTrigrams.has(value)) intersection++;
  return (2 * intersection) / (params.queryTrigrams.size + params.candidateTrigrams.size);
}

type ToolSearchSimilarityMemoOps = {
  score(params: { query: string; candidate: string }): number;
};

function createToolSearchSimilarityMemo(): ToolSearchSimilarityMemoOps {
  const scores = new Map<string, number>();
  const trigramSets = new Map<string, Set<string>>();

  function trigrams(value: string): Set<string> {
    const cached = trigramSets.get(value);
    if (cached) return cached;
    const result =
      value.length < 3
        ? new Set<string>()
        : new Set(
            Array.from({ length: value.length - 2 }, (_, index) => value.slice(index, index + 3)),
          );
    trigramSets.set(value, result);
    return result;
  }

  function score(params: { query: string; candidate: string }): number {
    const key = `${params.query}\0${params.candidate}`;
    const cached = scores.get(key);
    if (cached !== undefined) return cached;
    const result = scoreToolSearchSimilarity({
      ...params,
      queryTrigrams: trigrams(params.query),
      candidateTrigrams: trigrams(params.candidate),
    });
    scores.set(key, result);
    return result;
  }

  return { score };
}

export const ToolSearchSingleton = defineSingleton({
  params: {},
  deps: { text: createToolSearchText() },
  compile(document: ToolSearchDocument): CompiledToolSearchDocument {
    const fields = document.fields.map((field) => {
      const normalizedValue = this.deps.text.normalize({ value: field.value });
      return {
        ...field,
        normalizedValue,
        tokens: this.deps.text.tokensFromNormalized({ value: normalizedValue }),
      };
    });
    return {
      id: document.id,
      fields,
      tokens: [...new Set(fields.flatMap((field) => field.tokens))],
    };
  },

  matchField(params: {
    field: CompiledToolSearchField;
    normalizedQuery: string;
    queryTokens: string[];
    similarity: ToolSearchSimilarityMemoOps;
  }): ToolSearchFieldMatch | undefined {
    if (!params.field.normalizedValue) return undefined;
    const tokenScores = params.queryTokens.map((queryToken) =>
      Math.max(
        0,
        ...params.field.tokens.map((candidate) =>
          params.similarity.score({ query: queryToken, candidate }),
        ),
      ),
    );
    const matchedTokens = tokenScores.filter((score) => score > 0);
    const phraseBonus = params.field.normalizedValue.includes(params.normalizedQuery) ? 0.5 : 0;
    if (matchedTokens.length === 0 && phraseBonus === 0) return undefined;
    const coverage = matchedTokens.length / params.queryTokens.length;
    const similarity =
      tokenScores.reduce((total, score) => total + score, 0) / params.queryTokens.length;
    const score = params.field.weight * (similarity + coverage * 0.35 + phraseBonus);
    if (score < 0.5) return undefined;
    return {
      field: params.field.name,
      value: params.field.value,
      score: roundToolSearchScore(score),
    };
  },

  rank(params: {
    document: CompiledToolSearchDocument;
    normalizedQuery: string;
    queryTokens: string[];
    similarity: ToolSearchSimilarityMemoOps;
  }): ToolSearchRankedDocument | undefined {
    const rawMatches = params.document.fields
      .map((field) =>
        ToolSearchSingleton.matchField({
          field,
          normalizedQuery: params.normalizedQuery,
          queryTokens: params.queryTokens,
          similarity: params.similarity,
        }),
      )
      .filter((match): match is ToolSearchFieldMatch => match !== undefined)
      .toSorted((left, right) => right.score - left.score);
    const matches = [
      ...new Map(rawMatches.map((match) => [match.field, match] as const)).values(),
    ].toSorted((left, right) => right.score - left.score);
    if (matches.length === 0) return undefined;
    const coveredTokens = params.queryTokens.filter((queryToken) =>
      params.document.tokens.some(
        (candidate) => params.similarity.score({ query: queryToken, candidate }) > 0,
      ),
    ).length;
    const coverage = coveredTokens / params.queryTokens.length;
    const coverageMultiplier = 0.2 + coverage ** 2 * 0.8;
    return {
      id: params.document.id,
      score: roundToolSearchScore(
        matches.reduce((total, match) => total + match.score, 0) * coverageMultiplier,
      ),
      matches: matches.slice(0, 3),
    };
  },

  search(params: {
    query: string;
    documents: ToolSearchDocument[];
    limit: number;
  }): ToolSearchRankedDocument[] {
    const normalizedQuery = this.deps.text.normalize({ value: params.query });
    const queryTokens = this.deps.text.tokensFromNormalized({
      value: normalizedQuery,
      removeStopWords: true,
    });
    if (!normalizedQuery || queryTokens.length === 0) return [];

    const similarity = createToolSearchSimilarityMemo();
    return params.documents
      .map((document) =>
        ToolSearchSingleton.rank({
          document: ToolSearchSingleton.compile(document),
          normalizedQuery,
          queryTokens,
          similarity,
        }),
      )
      .filter((result): result is ToolSearchRankedDocument => result !== undefined)
      .toSorted((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, params.limit);
  },
});

type ToolSearchEngineConstructor = {
  new (): ToolSearchEngineClass;
  readonly prototype: ToolSearchEngineClass;
};

export type ToolSearchEngineClass = {
  search(params: {
    query: string;
    documents: ToolSearchDocument[];
    limit: number;
  }): ToolSearchRankedDocument[];
};

const ToolSearchEngineClassAdapter = function constructToolSearchEngine(): void {};
Object.defineProperty(ToolSearchEngineClassAdapter, "name", { value: "ToolSearchEngineClass" });
Object.defineProperty(ToolSearchEngineClassAdapter.prototype, "search", {
  configurable: true,
  value: function search(params: {
    query: string;
    documents: ToolSearchDocument[];
    limit: number;
  }): ToolSearchRankedDocument[] {
    return ToolSearchSingleton.search(params);
  },
  writable: true,
});

export const ToolSearchEngineClass =
  ToolSearchEngineClassAdapter as unknown as ToolSearchEngineConstructor;

export const toolSearchEngine = new ToolSearchEngineClass();
