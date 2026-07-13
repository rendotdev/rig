type NoopToolDeps = {
  rig: Parameters<RigToolFactory>[0];
};

class NoopToolClass {
  private readonly rig: Parameters<RigToolFactory>[0];

  constructor(params: Record<string, never>, deps: NoopToolDeps) {
    void params;
    this.rig = deps.rig;
  }

  public define() {
    return this.rig.defineTool({
      name: "noop",
      description: "Prove lazy state stores remain unopened.",
      commands: {
        run: this.rig.defineCommand({
          description: "Return without touching stateful services.",
          input: this.rig.z.object({}),
          output: this.rig.z.object({ ok: this.rig.z.literal(true) }),
          run: () => ({ ok: true as const }),
        }),
      },
    });
  }
}

const tool: RigToolFactory = (rig) => new NoopToolClass({}, { rig }).define();

export default tool;
