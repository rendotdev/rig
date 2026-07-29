import { Schema } from "effect";

export type RigDirectoryMigrationResult = Readonly<{
  promptId: string;
  status: "migrated" | "manual";
  legacyDir: string;
  currentDir: string;
  configUpdated: boolean;
  reason?: string;
}>;

const DirectoryMigrationOperation = Schema.Literals(["hasPrompted", "markPrompted", "migrate"]);

export class DirectoryMigrationError extends Schema.TaggedErrorClass<DirectoryMigrationError>()(
  "DirectoryMigrationError",
  { operation: DirectoryMigrationOperation, cause: Schema.Defect() },
) {}
