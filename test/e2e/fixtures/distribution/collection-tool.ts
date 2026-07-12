const tool: RigToolFactory = (rig) =>
  rig.defineTool({
    name: "documents",
    description: "Exercise collection index recovery.",
    collections: {
      notes: {
        schema: rig.z.object({ title: rig.z.string() }),
        generateId: (data) => String(data.title).toLowerCase().replaceAll(" ", "-"),
      },
    },
    commands: {
      add: rig.defineCommand({
        description: "Add a note.",
        input: rig.z.object({ title: rig.z.string(), body: rig.z.string() }),
        output: rig.z.object({ id: rig.z.string() }),
        run: async (context) => {
          const entry = await context.collections.notes.create({
            data: { title: context.input.title },
            body: context.input.body,
          });
          return { id: entry.id };
        },
      }),
      list: rig.defineCommand({
        description: "List notes.",
        input: rig.z.object({}),
        output: rig.z.object({ ids: rig.z.array(rig.z.string()) }),
        run: async (context) => {
          const result = await context.collections.notes.list();
          return { ids: result.entries.map((entry) => entry.id) };
        },
      }),
    },
  });

export default tool;
