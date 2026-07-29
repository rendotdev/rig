import { Context, Effect, Layer } from "effect";

type ToolSearchField = {
  name: string;
  value: string;
  weight: number;
};

export type ToolSearchDocument = {
  id: string;
  fields: ToolSearchField[];
};

type ToolSearchFieldMatch = {
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

class ToolSearchTextService extends Context.Service<
  ToolSearchTextService,
  {
    readonly normalize: (value: string) => Effect.Effect<string>;
    readonly tokens: (value: string, removeStopWords?: boolean) => Effect.Effect<string[]>;
  }
>()("@rendotdev/rig/tools/domain/ToolSearchTextService", {
  make: Effect.gen(function* () {
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
    const normalize = Effect.fn("ToolSearchTextService.normalize")(function* (value: string) {
      return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    });
    const tokens = Effect.fn("ToolSearchTextService.tokens")(function* (
      value: string,
      removeStopWords = false,
    ) {
      const values = value.split(/\s+/).filter(Boolean);
      if (!removeStopWords) return [...new Set(values)];
      const meaningful = values.filter((token) => !stopWords.has(token));
      return [...new Set(meaningful.length > 0 ? meaningful : values)];
    });
    return { normalize, tokens } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolSearchTextService, ToolSearchTextService.make);
}

class ToolSearchSimilarityService extends Context.Service<
  ToolSearchSimilarityService,
  { readonly score: (query: string, candidate: string) => Effect.Effect<number> }
>()("@rendotdev/rig/tools/domain/ToolSearchSimilarityService", {
  make: Effect.gen(function* () {
    const distance = (query: string, candidate: string): number => {
      const columns = candidate.length + 1;
      let previousPrevious = new Uint32Array(columns);
      let previous = new Uint32Array(columns);
      let current = new Uint32Array(columns);
      for (let column = 0; column < columns; column++) previous[column] = column;
      for (let row = 1; row <= query.length; row++) {
        current[0] = row;
        for (let column = 1; column < columns; column++) {
          const substitution = query[row - 1] === candidate[column - 1] ? 0 : 1;
          current[column] = Math.min(
            previous[column]! + 1,
            current[column - 1]! + 1,
            previous[column - 1]! + substitution,
          );
          const isTransposition =
            row > 1 &&
            column > 1 &&
            query[row - 1] === candidate[column - 2] &&
            query[row - 2] === candidate[column - 1];
          if (isTransposition) {
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
    };
    const trigrams = (value: string): Set<string> =>
      value.length < 3
        ? new Set<string>()
        : new Set(
            Array.from({ length: value.length - 2 }, (_, index) => value.slice(index, index + 3)),
          );
    const trigramDice = (query: string, candidate: string): number => {
      const queryTrigrams = trigrams(query);
      const candidateTrigrams = trigrams(candidate);
      const hasNoComparableTrigrams = queryTrigrams.size === 0 || candidateTrigrams.size === 0;
      if (hasNoComparableTrigrams) return 0;
      let intersection = 0;
      for (const value of queryTrigrams) if (candidateTrigrams.has(value)) intersection++;
      return (2 * intersection) / (queryTrigrams.size + candidateTrigrams.size);
    };
    const score = Effect.fn("ToolSearchSimilarityService.score")(function* (
      query: string,
      candidate: string,
    ) {
      if (query === candidate) return 1;
      const canUsePrefix = Math.min(query.length, candidate.length) >= 3;
      const isPrefixMatch =
        canUsePrefix && (candidate.startsWith(query) || query.startsWith(candidate));
      if (isPrefixMatch) return 0.9;
      const longest = Math.max(query.length, candidate.length);
      /* v8 ignore next -- empty normalized queries return before similarity scoring */
      if (longest === 0) return 0;
      const minimumDistance = Math.abs(query.length - candidate.length);
      const editSimilarity =
        1 - minimumDistance / longest >= 0.58 ? 1 - distance(query, candidate) / longest : 0;
      const similarity = Math.max(editSimilarity, trigramDice(query, candidate));
      return similarity >= 0.58 ? similarity * 0.82 : 0;
    });
    return { score } as const;
  }),
}) {
  static readonly layer = Layer.effect(
    ToolSearchSimilarityService,
    ToolSearchSimilarityService.make,
  );
}

class ToolSearchCompilerService extends Context.Service<
  ToolSearchCompilerService,
  { readonly compile: (document: ToolSearchDocument) => Effect.Effect<CompiledToolSearchDocument> }
>()("@rendotdev/rig/tools/domain/ToolSearchCompilerService", {
  make: Effect.gen(function* () {
    const text = yield* ToolSearchTextService;
    const compile = Effect.fn("ToolSearchCompilerService.compile")(function* (
      document: ToolSearchDocument,
    ) {
      const fields = yield* Effect.forEach(document.fields, (field) =>
        Effect.gen(function* () {
          const normalizedValue = yield* text.normalize(field.value);
          return { ...field, normalizedValue, tokens: yield* text.tokens(normalizedValue) };
        }),
      );
      return {
        id: document.id,
        fields,
        tokens: [...new Set(fields.flatMap((field) => field.tokens))],
      };
    });
    return { compile } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolSearchCompilerService, ToolSearchCompilerService.make);
}

class ToolSearchRankerService extends Context.Service<
  ToolSearchRankerService,
  {
    readonly rank: (params: {
      document: CompiledToolSearchDocument;
      normalizedQuery: string;
      queryTokens: string[];
    }) => Effect.Effect<ToolSearchRankedDocument | undefined>;
  }
>()("@rendotdev/rig/tools/domain/ToolSearchRankerService", {
  make: Effect.gen(function* () {
    const similarity = yield* ToolSearchSimilarityService;
    const roundScore = (value: number): number => Math.round(value * 1000) / 1000;
    const match = Effect.fn("ToolSearchRankerService.match")(function* (params: {
      field: CompiledToolSearchField;
      normalizedQuery: string;
      queryTokens: string[];
    }) {
      if (!params.field.normalizedValue) return undefined;
      const tokenScores = yield* Effect.forEach(params.queryTokens, (query) =>
        Effect.all(params.field.tokens.map((candidate) => similarity.score(query, candidate))).pipe(
          Effect.map((scores) => Math.max(0, ...scores)),
        ),
      );
      const matchedTokens = tokenScores.filter((score) => score > 0);
      const phraseBonus = params.field.normalizedValue.includes(params.normalizedQuery) ? 0.5 : 0;
      const hasNoMatch = matchedTokens.length === 0 && phraseBonus === 0;
      if (hasNoMatch) return undefined;
      const coverage = matchedTokens.length / params.queryTokens.length;
      const average =
        tokenScores.reduce((total, score) => total + score, 0) / params.queryTokens.length;
      const score = params.field.weight * (average + coverage * 0.35 + phraseBonus);
      if (score < 0.5) return undefined;
      return { field: params.field.name, value: params.field.value, score: roundScore(score) };
    });
    const rank = Effect.fn("ToolSearchRankerService.rank")(function* (params: {
      document: CompiledToolSearchDocument;
      normalizedQuery: string;
      queryTokens: string[];
    }) {
      const rawMatches = (yield* Effect.forEach(params.document.fields, (field) =>
        match({ field, normalizedQuery: params.normalizedQuery, queryTokens: params.queryTokens }),
      ))
        .filter((value): value is ToolSearchFieldMatch => value !== undefined)
        .toSorted((left, right) => right.score - left.score);
      const matches = [
        ...new Map(rawMatches.map((value) => [value.field, value])).values(),
      ].toSorted((left, right) => right.score - left.score);
      if (matches.length === 0) return undefined;
      const covered = yield* Effect.forEach(params.queryTokens, (query) =>
        Effect.forEach(params.document.tokens, (candidate) =>
          similarity.score(query, candidate),
        ).pipe(Effect.map((scores) => scores.some((score) => score > 0))),
      );
      const coverage = covered.filter(Boolean).length / params.queryTokens.length;
      const multiplier = 0.2 + coverage ** 2 * 0.8;
      return {
        id: params.document.id,
        score: roundScore(matches.reduce((total, value) => total + value.score, 0) * multiplier),
        matches: matches.slice(0, 3),
      };
    });
    return { rank } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolSearchRankerService, ToolSearchRankerService.make);
}

export class ToolSearchService extends Context.Service<
  ToolSearchService,
  {
    readonly search: (params: {
      query: string;
      documents: ToolSearchDocument[];
      limit: number;
    }) => Effect.Effect<ToolSearchRankedDocument[]>;
  }
>()("@rendotdev/rig/tools/domain/ToolSearchService", {
  make: Effect.gen(function* () {
    const text = yield* ToolSearchTextService;
    const compiler = yield* ToolSearchCompilerService;
    const ranker = yield* ToolSearchRankerService;
    const search = Effect.fn("ToolSearchService.search")(function* (params: {
      query: string;
      documents: ToolSearchDocument[];
      limit: number;
    }) {
      const normalizedQuery = yield* text.normalize(params.query);
      const queryTokens = yield* text.tokens(normalizedQuery, true);
      const hasNoSearchTerms = !normalizedQuery || queryTokens.length === 0;
      if (hasNoSearchTerms) return [];
      const ranked = yield* Effect.forEach(params.documents, (document) =>
        compiler
          .compile(document)
          .pipe(
            Effect.flatMap((compiled) =>
              ranker.rank({ document: compiled, normalizedQuery, queryTokens }),
            ),
          ),
      );
      return ranked
        .filter((value): value is ToolSearchRankedDocument => value !== undefined)
        .toSorted((left, right) => right.score - left.score || left.id.localeCompare(right.id))
        .slice(0, params.limit);
    });
    return { search } as const;
  }),
}) {
  static readonly layer = Layer.effect(ToolSearchService, ToolSearchService.make);
}

const toolSearchCompilerLayer = ToolSearchCompilerService.layer.pipe(
  Layer.provide(ToolSearchTextService.layer),
);
const toolSearchRankerLayer = ToolSearchRankerService.layer.pipe(
  Layer.provide(ToolSearchSimilarityService.layer),
);
export const toolSearchLayer = ToolSearchService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(ToolSearchTextService.layer, toolSearchCompilerLayer, toolSearchRankerLayer),
  ),
);
