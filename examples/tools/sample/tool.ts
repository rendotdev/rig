import { RigTool, z } from "../../../src/tools/sdk";

export default RigTool.define({
  name: "sample",
  description: "A sample tool that demonstrates Rig commands.",
  commands: {
    example: {
      description: "Example command. Replace this with a real command.",
      input: z.object({
        text: z.string().default("example"),
      }),
      output: z.object({
        text: z.string(),
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
      run: async ({ input }: { input: { text: string } }) => ({ text: input.text }),
    },
  },
});
