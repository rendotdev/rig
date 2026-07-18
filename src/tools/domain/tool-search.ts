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

class ToolSearchTextClass {
  private readonly stopWords = new Set([
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

  public normalize(params: { value: string }): string {
    return params.value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  public tokensFromNormalized(params: { value: string; removeStopWords?: boolean }): string[] {
    const tokens = params.value.split(/\s+/).filter(Boolean);
    if (!params.removeStopWords) return [...new Set(tokens)];
    const meaningful = tokens.filter((token) => !this.stopWords.has(token));
    return [...new Set(meaningful.length > 0 ? meaningful : tokens)];
  }
}

type ToolSearchSimilarityParams = {
  query: string;
  candidate: string;
  queryTrigrams: Set<string>;
  candidateTrigrams: Set<string>;
};

class ToolSearchSimilarityClass {
  public score(params: ToolSearchSimilarityParams): number {
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
    const editSimilarity =
      1 - minimumDistance / longest >= 0.58 ? 1 - this.distance(params) / longest : 0;
    const trigramSimilarity = this.trigramDice(params);
    const similarity = Math.max(editSimilarity, trigramSimilarity);
    return similarity >= 0.58 ? similarity * 0.82 : 0;
  }

  private distance(params: { query: string; candidate: string }): number {
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
          current[column] = Math.min(
            current[column]!,
            previousPrevious[column - 2]! + substitution,
          );
        }
      }
      const recycled = previousPrevious;
      previousPrevious = previous;
      previous = current;
      current = recycled;
    }
    return previous[columns - 1]!;
  }

  private trigramDice(params: ToolSearchSimilarityParams): number {
    if (params.queryTrigrams.size === 0 || params.candidateTrigrams.size === 0) return 0;
    let intersection = 0;
    for (const value of params.queryTrigrams)
      if (params.candidateTrigrams.has(value)) intersection++;
    return (2 * intersection) / (params.queryTrigrams.size + params.candidateTrigrams.size);
  }
}

class ToolSearchSimilarityMemoClass {
  private readonly similarity = new ToolSearchSimilarityClass();
  private readonly scores = new Map<string, number>();
  private readonly trigramSets = new Map<string, Set<string>>();

  public score(params: { query: string; candidate: string }): number {
    const key = `${params.query}\0${params.candidate}`;
    const cached = this.scores.get(key);
    if (cached !== undefined) return cached;
    const score = this.similarity.score({
      ...params,
      queryTrigrams: this.trigrams(params.query),
      candidateTrigrams: this.trigrams(params.candidate),
    });
    this.scores.set(key, score);
    return score;
  }

  private trigrams(value: string): Set<string> {
    const cached = this.trigramSets.get(value);
    if (cached) return cached;
    const trigrams =
      value.length < 3
        ? new Set<string>()
        : new Set(
            Array.from({ length: value.length - 2 }, (_, index) => value.slice(index, index + 3)),
          );
    this.trigramSets.set(value, trigrams);
    return trigrams;
  }
}

export class ToolSearchEngineClass {
  private readonly text = new ToolSearchTextClass();

  public search(params: {
    query: string;
    documents: ToolSearchDocument[];
    limit: number;
  }): ToolSearchRankedDocument[] {
    const normalizedQuery = this.text.normalize({ value: params.query });
    const queryTokens = this.text.tokensFromNormalized({
      value: normalizedQuery,
      removeStopWords: true,
    });
    if (!normalizedQuery || queryTokens.length === 0) return [];

    const similarity = new ToolSearchSimilarityMemoClass();
    return params.documents
      .map((document) =>
        this.rank({
          document: this.compile(document),
          normalizedQuery,
          queryTokens,
          similarity,
        }),
      )
      .filter((result): result is ToolSearchRankedDocument => result !== undefined)
      .toSorted((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, params.limit);
  }

  private compile(document: ToolSearchDocument): CompiledToolSearchDocument {
    const fields = document.fields.map((field) => {
      const normalizedValue = this.text.normalize({ value: field.value });
      return {
        ...field,
        normalizedValue,
        tokens: this.text.tokensFromNormalized({ value: normalizedValue }),
      };
    });
    return {
      id: document.id,
      fields,
      tokens: [...new Set(fields.flatMap((field) => field.tokens))],
    };
  }

  private rank(params: {
    document: CompiledToolSearchDocument;
    normalizedQuery: string;
    queryTokens: string[];
    similarity: ToolSearchSimilarityMemoClass;
  }): ToolSearchRankedDocument | undefined {
    const rawMatches = params.document.fields
      .map((field) =>
        this.matchField({
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
      score: this.round(
        matches.reduce((total, match) => total + match.score, 0) * coverageMultiplier,
      ),
      matches: matches.slice(0, 3),
    };
  }

  private matchField(params: {
    field: CompiledToolSearchField;
    normalizedQuery: string;
    queryTokens: string[];
    similarity: ToolSearchSimilarityMemoClass;
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
      score: this.round(score),
    };
  }

  private round(value: number): number {
    return Math.round(value * 1000) / 1000;
  }
}

export const toolSearchEngine = new ToolSearchEngineClass();
