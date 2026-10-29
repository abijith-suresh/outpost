import * as Schema from "effect/Schema";
import { semanticIdentifierSchema } from "./path-safety.js";

const IdentitySchema = Schema.Struct({
  path: Schema.String,
  device: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
  inode: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
});
export const BorrowedRecordSchema = Schema.Struct({
  kind: Schema.Literal("borrowed"),
  id: Schema.String.check(Schema.isPattern(/^local:[0-9a-f-]{36}$/)),
  name: semanticIdentifierSchema("repository name"),
  registeredAt: Schema.String,
  anchor: IdentitySchema,
  privateGit: IdentitySchema,
  common: IdentitySchema,
  checkoutKind: Schema.Literals(["main", "linked"]),
});
export const RetainedBorrowedRecordSchema = Schema.Struct({
  ...BorrowedRecordSchema.fields,
  retainedAt: Schema.String,
});
export type BorrowedRecord = typeof BorrowedRecordSchema.Type;
