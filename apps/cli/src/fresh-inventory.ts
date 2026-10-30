import * as Schema from "effect/Schema";
import { CommitSchema, FetchReceiptSchema } from "./base-selection.js";
import { IdentitySchema } from "./borrowed-schema.js";

export const CompletedFreshSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("fresh-receipt-inventory"),
  status: Schema.Literal("completed-retained"),
  id: FetchReceiptSchema.fields.operationId,
  ticket: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  members: Schema.Array(
    Schema.Struct({
      repoId: Schema.String.check(Schema.isPattern(/^local:[0-9a-f-]{36}$/)),
      commonDirectory: Schema.String.check(Schema.isMaxLength(4096)),
      common: IdentitySchema,
      baseCommit: CommitSchema,
      fetchReceipt: FetchReceiptSchema,
    })
  ).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
}).check(
  Schema.makeFilter(
    (entry) =>
      entry.members.every(
        (member, i) =>
          member.common.path.length <= 4096 &&
          member.commonDirectory === member.common.path &&
          member.fetchReceipt.operationId === entry.id &&
          member.fetchReceipt.commit === member.baseCommit &&
          member.fetchReceipt.ref === `refs/outpost/base-fetch/${entry.id}/${i}`
      ) || "Inconsistent receipt inventory"
  )
);
export type CompletedFresh = typeof CompletedFreshSchema.Type;
export function isCompletedFresh(value: unknown) {
  try {
    Schema.decodeUnknownSync(CompletedFreshSchema)(value, { onExcessProperty: "error" });
    return true;
  } catch {
    return false;
  }
}
