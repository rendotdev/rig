export type RigIssue = {
  code: string;
  message: string;
  details?: unknown;
};

export type SuccessEnvelope = {
  data: unknown;
  errors: [];
};

export type ErrorEnvelope = {
  data: null;
  errors: [RigIssue];
};

export class EnvelopeFactory {
  static success(params: { data: unknown }): SuccessEnvelope {
    return {
      data: params.data,
      errors: [],
    };
  }

  static error(params: { code: string; message: string; details?: unknown }): ErrorEnvelope {
    return {
      data: null,
      errors: [
        {
          code: params.code,
          message: params.message,
          details: params.details,
        },
      ],
    };
  }
}
