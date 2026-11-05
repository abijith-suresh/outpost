import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class InvocationError extends Schema.TaggedError<InvocationError>()("InvocationError", {
  message: Schema.String,
  reason: Schema.optional(Schema.Literals(["stale-state", "identity-changed"])),
}) {}
export type Invocation = Readonly<{
  home: string;
  cwd: string;
  environment: Readonly<Record<string, string | undefined>>;
  beforeLock?: Effect.Effect<void, InvocationError, FileSystem.FileSystem | Path.Path>;
  beforeMutation?: Effect.Effect<void, InvocationError, FileSystem.FileSystem | Path.Path>;
}>;
export class ApplicationInvocation extends Context.Service<ApplicationInvocation, Invocation>()(
  "outpost/ApplicationInvocation"
) {}
export const invocation = Effect.serviceOption(ApplicationInvocation);
export const invocationEnvironment = Effect.map(invocation, (context) =>
  Option.isSome(context) ? context.value.environment : process.env
);
export const invocationCwd = Effect.map(invocation, (context) =>
  Option.isSome(context) ? context.value.cwd : process.cwd()
);
