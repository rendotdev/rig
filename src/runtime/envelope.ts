import type { ErrorCode } from "../errors/codes";

export type RigResponseExtensions = {
  rig: {
    ok: boolean;
    tool: string;
    command: string;
    id: string;
    path: [string, string];
    warnings: string[];
    elapsedMs: number;
  };
};

export type RigGraphQLError = {
  message: string;
  path: [string, string];
  extensions: {
    code: ErrorCode | string;
    details?: unknown;
  };
};

export type SuccessEnvelope = {
  data: Record<string, Record<string, unknown>>;
  errors: [];
  extensions: RigResponseExtensions;
};

export type ErrorEnvelope = {
  data: null;
  errors: [RigGraphQLError];
  extensions: RigResponseExtensions;
};

export class EnvelopeFactory {
  static success(params: {
    tool: string;
    command: string;
    id: string;
    data: unknown;
    elapsedMs: number;
    warnings?: string[];
  }): SuccessEnvelope {
    return {
      data: {
        [params.tool]: {
          [params.command]: params.data,
        },
      },
      errors: [],
      extensions: {
        rig: {
          ok: true,
          tool: params.tool,
          command: params.command,
          id: params.id,
          path: [params.tool, params.command],
          warnings: params.warnings ?? [],
          elapsedMs: params.elapsedMs,
        },
      },
    };
  }

  static error(params: {
    tool: string;
    command: string;
    id: string;
    code: ErrorCode | string;
    message: string;
    details?: unknown;
    elapsedMs: number;
    warnings?: string[];
  }): ErrorEnvelope {
    return {
      data: null,
      errors: [
        {
          message: params.message,
          path: [params.tool, params.command],
          extensions: {
            code: params.code,
            details: params.details,
          },
        },
      ],
      extensions: {
        rig: {
          ok: false,
          tool: params.tool,
          command: params.command,
          id: params.id,
          path: [params.tool, params.command],
          warnings: params.warnings ?? [],
          elapsedMs: params.elapsedMs,
        },
      },
    };
  }
}
