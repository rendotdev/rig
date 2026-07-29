import { Layer } from "effect";
import { collectionIndexDatabaseLayer } from "./sqlite-collection-database";
import { collectionIndexQueryReaderLayer } from "./sqlite-collection-query-reader";
import { CollectionIndexRecordReaderService } from "./sqlite-collection-record-reader";
import { CollectionIndexWriterService } from "./sqlite-collection-writer";

export const collectionIndexLayer = Layer.mergeAll(
  collectionIndexDatabaseLayer,
  CollectionIndexWriterService.layer,
  CollectionIndexRecordReaderService.layer,
  collectionIndexQueryReaderLayer,
);
