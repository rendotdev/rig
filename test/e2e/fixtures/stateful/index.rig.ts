type StatefulToolParams = {
  name: string;
};

type StatefulToolDeps = {
  rig: Parameters<RigToolFactory>[0];
};

let definitionEvaluations = 0;

class StatefulToolClass {
  public readonly name: string;
  private readonly rig: Parameters<RigToolFactory>[0];

  constructor(params: StatefulToolParams, deps: StatefulToolDeps) {
    this.name = params.name;
    this.rig = deps.rig;
  }

  public define() {
    const { rig } = this;
    const anyOutput = rig.z.unknown();
    const emptyInput = rig.z.object({});
    const cacheInput = rig.z.object({
      action: rig.z.enum(["query", "peek", "set", "invalidate", "remove", "clear"]),
      key: rig.z.string().default("default"),
      value: rig.z.string().optional(),
      staleTime: rig.z.coerce.number().nonnegative().optional(),
      delayMs: rig.z.coerce.number().nonnegative().default(0),
    });
    const collectionInput = rig.z.object({
      collection: rig.z.enum(["notes", "archive"]).default("notes"),
      action: rig.z.enum([
        "create",
        "get",
        "update",
        "upsert",
        "remove",
        "list",
        "count",
        "search",
        "clear",
      ]),
      id: rig.z.string().optional(),
      title: rig.z.string().optional(),
      status: rig.z.enum(["open", "done"]).optional(),
      priority: rig.z.coerce.number().optional(),
      body: rig.z.string().optional(),
      query: rig.z.string().optional(),
      whereStatus: rig.z.enum(["open", "done"]).optional(),
      sort: rig.z.string().optional(),
    });

    return rig.defineTool({
      name: this.name,
      description: "Exercise stateful Rig capabilities end to end.",
      env: rig.z.object({
        TOKEN: rig.z.string().min(3),
      }),
      setupDb: (db) => {
        db.migrate(
          1,
          "create counters",
          `
          create table counters (
            name text primary key,
            value integer not null
          );
        `,
        );
      },
      collections: {
        notes: {
          schema: rig.z.object({
            title: rig.z.string(),
            status: rig.z.enum(["open", "done"]),
            project: rig.z.object({ priority: rig.z.number() }),
          }),
        },
        archive: {
          schema: rig.z.object({
            title: rig.z.string(),
            status: rig.z.enum(["open", "done"]),
            project: rig.z.object({ priority: rig.z.number() }),
          }),
        },
      },
      commands: {
        env: rig.defineCommand({
          description: "Read tool-local and process environment values.",
          input: emptyInput,
          output: rig.z.object({ token: rig.z.string(), processToken: rig.z.string().optional() }),
          run: (context) => ({
            token: (context.env as { TOKEN: string }).TOKEN,
            processToken: context.processEnv.TOKEN,
          }),
        }),
        db: rig.defineCommand({
          description: "Increment and read a persistent database counter.",
          input: rig.z.object({ name: rig.z.string().default("runs") }),
          output: rig.z.object({ value: rig.z.number() }),
          run: (context) => {
            context.db
              .query(
                `insert into counters (name, value) values ($name, 1)
                 on conflict(name) do update set value = value + 1`,
              )
              .run({ name: context.input.name });
            const row = context.db
              .query("select value from counters where name = ?")
              .get(context.input.name) as { value: number };
            return row;
          },
        }),
        kv: rig.defineCommand({
          description: "Read or write persistent key-value state.",
          input: rig.z.object({
            action: rig.z.enum(["get", "set"]),
            key: rig.z.string(),
            value: rig.z.unknown().optional(),
          }),
          output: anyOutput,
          run: (context) => {
            if (context.input.action === "set") {
              context.kv.set(context.input.key, context.input.value);
            }
            return { value: context.kv.get(context.input.key) };
          },
        }),
        cache: rig.defineCommand({
          description: "Exercise persistent cache state and refresh behavior.",
          input: cacheInput,
          output: anyOutput,
          run: async (context) => {
            const key = ["e2e", context.input.key] as const;
            if (context.input.action === "peek") return { value: context.cache.peek(key) };
            if (context.input.action === "set") {
              context.cache.set(key, context.input.value);
              return { value: context.cache.peek(key) };
            }
            if (context.input.action === "invalidate") context.cache.invalidate(key);
            if (context.input.action === "remove") context.cache.remove(key);
            if (context.input.action === "clear") context.cache.clear();
            if (context.input.action !== "query") return { value: context.cache.peek(key) };

            const startedAt = Date.now();
            const value = await context.cache.query({
              queryKey: key,
              staleTime: context.input.staleTime,
              queryFn: async () => {
                if (context.input.delayMs > 0) {
                  await new Promise((resolve) => setTimeout(resolve, context.input.delayMs));
                }
                return context.input.value ?? "refreshed";
              },
            });
            return { value, elapsedMs: Date.now() - startedAt };
          },
        }),
        collection: rig.defineCommand({
          description: "Exercise Markdown collection operations.",
          input: collectionInput,
          output: anyOutput,
          run: async (context) => {
            const collection = context.collections[context.input.collection];
            const data = {
              title: context.input.title ?? context.input.id ?? "Untitled",
              status: context.input.status ?? "open",
              project: { priority: context.input.priority ?? 0 },
            };
            if (context.input.action === "create") {
              return collection.create({ id: context.input.id, data, body: context.input.body });
            }
            if (context.input.action === "get") return collection.getEntry(context.input.id!);
            if (context.input.action === "update") {
              return collection.update(context.input.id!, { data, body: context.input.body });
            }
            if (context.input.action === "upsert") {
              return collection.upsert({ id: context.input.id!, data, body: context.input.body });
            }
            if (context.input.action === "remove") return collection.remove(context.input.id!);
            if (context.input.action === "list") {
              return collection.list({
                where: context.input.whereStatus
                  ? { status: context.input.whereStatus }
                  : undefined,
                sort: context.input.sort,
              });
            }
            if (context.input.action === "count") {
              return {
                count: await collection.count(
                  context.input.whereStatus ? { status: context.input.whereStatus } : undefined,
                ),
              };
            }
            if (context.input.action === "search") {
              return collection.search(context.input.query ?? "");
            }
            await collection.clear();
            return { count: await collection.count() };
          },
        }),
        shell: rig.defineCommand({
          description: "Exercise exec, JSON, Bash, timeout, and bounded output.",
          input: rig.z.object({
            action: rig.z.enum(["exec", "json", "bash", "timeout", "bounded"]),
          }),
          output: anyOutput,
          run: async (context) => {
            if (context.input.action === "exec") {
              return context.rig.shell.exec(["bun", "-e", "console.log('exec-ok')"]);
            }
            if (context.input.action === "json") {
              return context.rig.shell.json([
                "bun",
                "-e",
                "console.log(JSON.stringify({ok:true}))",
              ]);
            }
            if (context.input.action === "bash") {
              return context.rig.shell.bash("printf bash-ok");
            }
            if (context.input.action === "bounded") {
              return context.rig.shell.exec(
                ["bun", "-e", "process.stdout.write('🙂'.repeat(200))"],
                { maxOutputBytes: 17 },
              );
            }
            return context.rig.shell.exec(["bun", "-e", "setTimeout(() => {}, 10000)"], {
              timeoutMs: 50,
            });
          },
        }),
        child: rig.defineCommand({
          description: "Return a nested-call value or fail.",
          input: rig.z.object({ value: rig.z.number(), fail: rig.z.boolean().default(false) }),
          output: rig.z.object({ value: rig.z.number(), definitionEvaluations: rig.z.number() }),
          run: (context) => {
            if (context.input.fail) throw new Error("nested child failed");
            return { value: context.input.value + 1, definitionEvaluations };
          },
        }),
        nested: rig.defineCommand({
          description: "Run repeated nested commands in one invocation session.",
          input: rig.z.object({
            count: rig.z.coerce.number().int().positive(),
            fail: rig.z.boolean().default(false),
          }),
          output: rig.z.object({
            values: rig.z.array(rig.z.number()),
            definitionEvaluations: rig.z.array(rig.z.number()),
          }),
          run: async (context) => {
            const values: number[] = [];
            const evaluations: number[] = [];
            for (let index = 0; index < context.input.count; index++) {
              // Sequential execution proves every nested call shares the outer invocation session.
              // eslint-disable-next-line no-await-in-loop
              const result = await context.rig.run<{
                value: number;
                definitionEvaluations: number;
              }>({
                command: "stateful.child",
                input: { value: index, fail: context.input.fail && index === 0 },
              });
              values.push(result.value);
              evaluations.push(result.definitionEvaluations);
            }
            return { values, definitionEvaluations: evaluations };
          },
        }),
      },
    });
  }
}

const tool: RigToolFactory = (rig) => {
  definitionEvaluations++;
  return new StatefulToolClass({ name: "stateful" }, { rig }).define();
};

export default tool;
