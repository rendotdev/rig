function defineNoopTool(rig: Parameters<RigToolFactory>[0]) {
  return rig.defineTool({
    name: "noop",
    description: "Prove lazy state stores remain unopened.",
    commands: {
      run: rig.defineCommand({
        description: "Return without touching stateful services.",
        input: rig.z.object({}),
        output: rig.z.object({ ok: rig.z.literal(true) }),
        run: () => ({ ok: true as const }),
      }),
    },
  });
}

const tool: RigToolFactory = defineNoopTool;

export default tool;
