type HelpTopic = {
  title: string;
  content: string;
};

const TOPICS: Record<string, HelpTopic> = {
  collections: {
    title: "Collections",
    content: `- Document stores: folders of .md files with YAML frontmatter + markdown body
- Defined in tool definition: \`collections: { name: { schema: rig.z.object({...}), generateId: (data) => data.key } }\`
- Schema-less allowed: \`collections: { notes: {} }\`
- Access in commands: \`context.collections.<name>\`
- Backed by auto-managed .index.sqlite (FTS5) for instant search
- Files on disk are source of truth; hand-edits reconcile on next run

API:
- \`.create({ id?, data, body? })\` create entry
- \`.getEntry(id)\` get one or null
- \`.update(id, { data?, body? })\` partial merge
- \`.upsert({ id, data, body? })\` create or update
- \`.remove(id)\` delete
- \`.list({ where?, sort?, limit?, offset? })\` structured query
- \`.search(query, { limit? })\` full-text search
- \`.count(where?)\` count matches
- \`.getCollection(filterFn?)\` get all
- \`.clear()\` remove all`,
  },

  kv: {
    title: "Key-Value State",
    content: `- Lightweight JSON store for small atoms (timestamps, cursors, toggles)
- Stored in kv.sqlite beside the tool file
- Always available, no setup needed

API:
- \`context.kv.set(key, value)\` store JSON-serializable value
- \`context.kv.get<T>(key)\` retrieve (undefined if missing)`,
  },

  cache: {
    title: "Query Cache",
    content: `- Persistent JSON cache for derived data
- Stored in cache.sqlite beside the tool file
- Missing data waits for the query function
- Fresh data returns immediately
- Stale data waits for its query function and returns the refreshed value

API:
- \`context.cache.query({ queryKey, queryFn, staleTime })\`
- \`context.cache.peek(queryKey)\`
- \`context.cache.set(queryKey, value)\`
- \`context.cache.invalidate(queryKey)\`
- \`context.cache.remove(queryKey)\`
- \`context.cache.clear()\``,
  },

  db: {
    title: "SQLite Database",
    content: `- Raw Bun SQLite with migration support
- Stored as index.sqlite beside the tool file
- Define \`setupDb: (db) => { db.migrate(version, name, sql) }\` in tool definition

API:
- \`context.db.query(sql).get(params)\` single row
- \`context.db.query(sql).all(params)\` all rows
- \`context.db.query(sql).run(params)\` execute
- \`context.db.run(sql)\` DDL`,
  },

  env: {
    title: "Environment / Secrets",
    content: `- Schema-validated secrets in .env beside the tool file
- Define \`env: rig.z.object({ KEY: rig.z.string() })\` in tool definition
- Validated before command runs; missing keys throw immediately

Commands:
- \`rig env <tool> KEY=value\` set a value
- \`rig env <tool> remove KEY\` remove a value

Access: \`context.env.KEY\``,
  },

  log: {
    title: "Logging",
    content: `- Structured Pino logger scoped to tool command
- Written to ~/rig/.logs/, rolled by size, kept 7 days
- Does not appear in command output (that's the JSON envelope on stdout)

API:
- \`context.log.info(msg)\`
- \`context.log.info({ count: 5 }, "processed")\`
- \`context.log.error(err, "failed")\`
- \`context.log.child({ requestId })\`
- Levels: trace, debug, info, warn, error, fatal`,
  },

  shell: {
    title: "Shell / Commands",
    content: `- Execute CLI commands from tool code
- Interpolations auto-escaped in tagged templates

API:
- \`await ctx.rig.$\\\`git status\\\`\` tagged template (escaped)
- \`ctx.rig.shell.exec(["git", "status"], opts?)\` array args
- \`ctx.rig.shell.bash("echo hi && ls", opts?)\` bash string
- \`ctx.rig.shell.json(["curl", "-s", url])\` exec + JSON.parse stdout

Options: \`{ cwd?, env?, timeoutMs?, maxOutputBytes? }\`
Result: \`{ stdout, stderr, exitCode, command }\``,
  },

  run: {
    title: "Calling Other Tools",
    content: `- Call rig commands from within a command
- Returns typed output data directly

API:
- \`await ctx.rig.run<T>({ command: "tool.cmd", input: {...} })\`

CLI pipelines:
- \`rig run tool.a key=val --as step1\`
- \`rig run tool.b input=@step1.field --pipe\``,
  },

  tool: {
    title: "Creating Tools",
    content: `- Tools live at rig-tools/<name>/index.rig.ts
- Create with \`rig create <name>\`
- Export default a RigToolFactory: \`(rig) => rig.defineTool({...})\`

Definition keys:
- \`name\` tool name (matches folder)
- \`description\` one-line summary
- \`env?\` Zod schema for secrets
- \`setupDb?\` migration function for raw sqlite
- \`collections?\` document stores
- \`commands\` the command map

Context in run():
- \`ctx.input\` validated input
- \`ctx.env\` validated secrets
- \`ctx.db\` sqlite (if setupDb)
- \`ctx.kv\` key-value store
- \`ctx.collections\` collection handles
- \`ctx.log\` logger
- \`ctx.rig\` toolkit (run, $, args, paths, shell)
- \`ctx.cwd\` working directory
- \`ctx.processEnv\` process env`,
  },

  args: {
    title: "Argument Builder",
    content: `- Fluent API for building argv arrays

API:
- \`ctx.rig.args().raw("git","log").flag("--oneline").value("--author", name).toArray()\`
- \`.raw(...vals)\` literal args
- \`.flag(name, enabled?)\` conditional flag
- \`.value(name, val)\` name+value (skipped if null)
- \`.values(name, arr)\` repeated name+value
- \`.toArray()\` finalize`,
  },

  paths: {
    title: "Path Helpers",
    content: `API:
- \`ctx.rig.paths.home()\` home dir
- \`ctx.rig.paths.resolve(cwd, path)\` resolve ~/relative/absolute
- \`ctx.rig.paths.ensureParent(path)\` mkdir -p parent
- \`ctx.rig.paths.size(path)\` file size (0 if missing)`,
  },
};

export class HelpTopicServiceClass {
  isKnownTopic(name: string): boolean {
    return name in TOPICS;
  }

  listTopics(): string[] {
    return Object.keys(TOPICS);
  }

  render(name: string): string | undefined {
    const topic = TOPICS[name];
    if (!topic) return undefined;
    return `# Help \u2022 ${topic.title}\n\n${topic.content}`;
  }

  renderTopicList(): string {
    const lines = ["# Help Topics", "", "Usage: `rig help <topic>`", ""];
    for (const [name, topic] of Object.entries(TOPICS)) {
      lines.push(`  ${name.padEnd(14)} ${topic.title}`);
    }
    return lines.join("\n");
  }
}

export const helpTopicService = new HelpTopicServiceClass();
