import * as Schema from "effect/Schema";
import { ERROR_REASONS } from "./error-reasons.js";

export * from "./error-reasons.js";

export const ErrorDetailFields = {
  reason: Schema.optional(Schema.Literals(ERROR_REASONS)),
  retryable: Schema.optional(Schema.Boolean),
  action: Schema.optional(Schema.String),
};
