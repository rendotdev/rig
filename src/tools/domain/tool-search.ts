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

  public tokens(params: { value: string; removeStopWords?: boolean }): string[] {
    const tokens = this.normalize(params).split(/\s+/).filter(Boolean);
    if (!params.removeStopWords) return [...new Set(tokens)];
    const meaningful = tokens.filter((token) => !this.stopWords.has(token));
    return [...new Set(meaningful.length > 0 ? meaningful : tokens)];
  }
}

class ToolSearchSimilarityClass {
  public score(params: { query: string; candidate: string }): number {
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
    const editSimilarity = 1 - this.distance(params) / longest;
    const trigramSimilarity = this.trigramDice(params);
    const similarity = Math.max(editSimilarity, trigramSimilarity);
    return similarity >= 0.58 ? similarity * 0.82 : 0;
  }

  private distance(params: { query: string; candidate: string }): number {
    const rows = params.query.length + 1;
    const columns = params.candidate.length + 1;
    const matrix = Array.from({ length: rows }, () => Array<number>(columns).fill(0));
    for (let row = 0; row < rows; row++) matrix[row]![0] = row;
    for (let column = 0; column < columns; column++) matrix[0]![column] = column;

    for (let row = 1; row < rows; row++) {
      for (let column = 1; column < columns; column++) {
        const substitution = params.query[row - 1] === params.candidate[column - 1] ? 0 : 1;
        matrix[row]![column] = Math.min(
          matrix[row - 1]![column]! + 1,
          matrix[row]![column - 1]! + 1,
          matrix[row - 1]![column - 1]! + substitution,
        );
        if (
          row > 1 &&
          column > 1 &&
          params.query[row - 1] === params.candidate[column - 2] &&
          params.query[row - 2] === params.candidate[column - 1]
        ) {
          matrix[row]![column] = Math.min(
            matrix[row]![column]!,
            matrix[row - 2]![column - 2]! + substitution,
          );
        }
      }
    }
    return matrix[rows - 1]![columns - 1]!;
  }

  private trigramDice(params: { query: string; candidate: string }): number {
    const left = this.trigrams(params.query);
    const right = this.trigrams(params.candidate);
    if (left.size === 0 || right.size === 0) return 0;
    let intersection = 0;
    for (const value of left) if (right.has(value)) intersection++;
    return (2 * intersection) / (left.size + right.size);
  }

  private trigrams(value: string): Set<string> {
    if (value.length < 3) return new Set();
    return new Set(
      Array.from({ length: value.length - 2 }, (_, index) => value.slice(index, index + 3)),
    );
  }
}

export class ToolSearchEngineClass {
  private readonly text = new ToolSearchTextClass();
  private readonly similarity = new ToolSearchSimilarityClass();

  public search(params: {
    query: string;
    documents: ToolSearchDocument[];
    limit: number;
  }): ToolSearchRankedDocument[] {
    const normalizedQuery = this.text.normalize({ value: params.query });
    const queryTokens = this.text.tokens({ value: params.query, removeStopWords: true });
    if (!normalizedQuery || queryTokens.length === 0) return [];

    return params.documents
      .map((document) => this.rank({ document, normalizedQuery, queryTokens }))
      .filter((result): result is ToolSearchRankedDocument => result !== undefined)
      .toSorted((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, params.limit);
  }

  private rank(params: {
    document: ToolSearchDocument;
    normalizedQuery: string;
    queryTokens: string[];
  }): ToolSearchRankedDocument | undefined {
    const rawMatches = params.document.fields
      .map((field) =>
        this.matchField({
          field,
          normalizedQuery: params.normalizedQuery,
          queryTokens: params.queryTokens,
        }),
      )
      .filter((match): match is ToolSearchFieldMatch => match !== undefined)
      .toSorted((left, right) => right.score - left.score);
    const matches = [
      ...new Map(rawMatches.map((match) => [match.field, match] as const)).values(),
    ].toSorted((left, right) => right.score - left.score);
    if (matches.length === 0) return undefined;
    const documentTokens = params.document.fields.flatMap((field) =>
      this.text.tokens({ value: field.value }),
    );
    const coveredTokens = params.queryTokens.filter((queryToken) =>
      documentTokens.some(
        (candidate) => this.similarity.score({ query: queryToken, candidate }) > 0,
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
    field: ToolSearchField;
    normalizedQuery: string;
    queryTokens: string[];
  }): ToolSearchFieldMatch | undefined {
    const normalizedField = this.text.normalize({ value: params.field.value });
    if (!normalizedField) return undefined;
    const fieldTokens = this.text.tokens({ value: params.field.value });
    const tokenScores = params.queryTokens.map((queryToken) =>
      Math.max(
        0,
        ...fieldTokens.map((candidate) => this.similarity.score({ query: queryToken, candidate })),
      ),
    );
    const matchedTokens = tokenScores.filter((score) => score > 0);
    const phraseBonus = normalizedField.includes(params.normalizedQuery) ? 0.5 : 0;
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
