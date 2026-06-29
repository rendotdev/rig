import { RigTool, z } from "../../../src/tools/sdk";

export default RigTool.define({
  name: "hello",
  description: "A starter tool that demonstrates Rig commands.",
  commands: {
    greet: {
      description: "Return a friendly greeting.",
      input: z.object({
        name: z.string().default("world"),
      }),
      output: z.object({
        message: z.string(),
      }),
      sideEffects: "read",
      examples: [
        {
          title: "Greet the world",
          text: "Use this to verify Rig can run a local command.",
          input: { name: "world" },
          output: { message: "Hello, world!" },
        },
      ],
      run: async ({ input }: { input: { name: string } }) => ({ message: `Hello, ${input.name}!` }),
    },
  },
});
