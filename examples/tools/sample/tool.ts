const tool: RigToolFactory = (rig) =>
  rig.defineTool({
    name: "sample",
    description: "A sample tool that demonstrates Rig commands.",
    commands: {
      example: rig.command({
        description: "Example command. Replace this with a real command.",
        input: rig.input({
          text: rig.z.string().default("example"),
        }),
        output: rig.output({
          text: rig.z.string(),
        }),
        sideEffects: "read",
        examples: [
          {
            title: "Run the example command",
            text: "Use this to verify Rig can run a local command.",
            input: { text: "example" },
            output: { text: "example" },
          },
        ],
        run: async ({ input }) => ({ text: input.text }),
      }),
    },
  });

export default tool;
