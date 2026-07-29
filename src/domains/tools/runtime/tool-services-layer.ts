import { Layer } from "effect";
import { rigConfigStoreLayer } from "../../settings/service/config-store";
import { atomicFileWriterLayer } from "../../../providers/filesystem/atomic-file-writer";
import { rigPathsConfigLayer, rigPathsLayer } from "../../../providers/paths/rig-paths";
import { runtimeSupportLayer, runtimeSupportRendererLayer } from "./runtime-support";
import { registryLayer } from "../../registry/service/registry";
import { toolDiscoveryLayer } from "../../registry/service/tool-discovery";
import { rigLoggerLayer } from "../../../providers/logging/rig-logger";
import { outputTruncatorLayer } from "../../../providers/output/output-truncator";
import { rigShellLayer } from "../../../providers/process/rig-shell-service";
import { toolIdentifierLayer } from "../service/tool-identifier";
import { schemaRendererLayer } from "../service/schema-renderer";
import { toolSearchLayer } from "../service/tool-search";
import { toolExecutionResourcesLayer } from "./tool-execution-resources";
import { toolRunnerLayer } from "./tool-runner";
import { toolInputParserLayer } from "../service/tool-input-parser";
import { toolDefinitionLayer } from "../service/tool-definition";
import { toolEnvironmentLayer } from "./tool-environment";
import { toolLoaderLayer } from "./tool-loader";
import { toolEnvLayer } from "./tool-env";
import { ToolFilesService } from "./tool-files";
import { toolTypecheckLayer } from "./tool-typecheck";
import { toolApiMigrationLayer } from "./tool-api-migration";
import { toolFindLayer } from "./tool-find";
import { toolHelpLayer } from "./tool-help";
import { ToolInspectorService } from "./tool-inspector";
import { ToolListService, toolMetadataCacheLayer } from "./tool-list";
import { rigToolKitLayer } from "./tool-sdk";

const runtimeRendererLayer = runtimeSupportRendererLayer.pipe(Layer.provide(rigPathsConfigLayer));
const configStoreLayer = rigConfigStoreLayer.pipe(
  Layer.provide(Layer.merge(atomicFileWriterLayer, runtimeRendererLayer)),
);
const registryServiceLayer = registryLayer.pipe(
  Layer.provide(Layer.merge(atomicFileWriterLayer, runtimeRendererLayer)),
);
const discoveryServiceLayer = toolDiscoveryLayer.pipe(
  Layer.provide(Layer.merge(registryServiceLayer, rigPathsLayer)),
);
const toolkitServiceLayer = rigToolKitLayer.pipe(
  Layer.provide(Layer.mergeAll(rigShellLayer, rigPathsConfigLayer, rigPathsLayer)),
);
const loaderServiceLayer = toolLoaderLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      toolEnvironmentLayer,
      discoveryServiceLayer,
      toolDefinitionLayer,
      toolIdentifierLayer,
      toolkitServiceLayer,
    ),
  ),
);
const metadataServiceLayer = toolMetadataCacheLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      rigPathsConfigLayer,
      loaderServiceLayer,
      atomicFileWriterLayer,
      schemaRendererLayer,
      toolIdentifierLayer,
    ),
  ),
);
const listServiceLayer = ToolListService.layer.pipe(
  Layer.provide(Layer.mergeAll(discoveryServiceLayer, metadataServiceLayer, toolIdentifierLayer)),
);
const findServiceLayer = toolFindLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      discoveryServiceLayer,
      metadataServiceLayer,
      toolIdentifierLayer,
      toolSearchLayer,
    ),
  ),
);
const inspectorServiceLayer = ToolInspectorService.layer.pipe(
  Layer.provide(Layer.mergeAll(loaderServiceLayer, toolIdentifierLayer, schemaRendererLayer)),
);
const helpServiceLayer = toolHelpLayer.pipe(
  Layer.provide(Layer.mergeAll(loaderServiceLayer, toolIdentifierLayer, schemaRendererLayer)),
);
const filesServiceLayer = ToolFilesService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      rigPathsLayer,
      configStoreLayer,
      discoveryServiceLayer,
      atomicFileWriterLayer,
      toolDefinitionLayer,
    ),
  ),
);
const environmentServiceLayer = toolEnvLayer.pipe(
  Layer.provide(Layer.mergeAll(loaderServiceLayer, atomicFileWriterLayer, schemaRendererLayer)),
);
const typecheckServiceLayer = toolTypecheckLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      rigPathsConfigLayer,
      configStoreLayer,
      discoveryServiceLayer,
      toolDefinitionLayer,
    ),
  ),
);
const runnerServiceLayer = toolRunnerLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      toolExecutionResourcesLayer,
      loaderServiceLayer,
      toolInputParserLayer,
      toolIdentifierLayer,
      toolkitServiceLayer,
      outputTruncatorLayer,
      rigLoggerLayer,
    ),
  ),
);
const migrationServiceLayer = toolApiMigrationLayer.pipe(Layer.provide(discoveryServiceLayer));

export const toolServicesLayer = Layer.mergeAll(
  listServiceLayer,
  findServiceLayer,
  inspectorServiceLayer,
  helpServiceLayer,
  filesServiceLayer,
  environmentServiceLayer,
  typecheckServiceLayer,
  runnerServiceLayer,
  migrationServiceLayer,
  runtimeSupportLayer,
  toolIdentifierLayer,
);
