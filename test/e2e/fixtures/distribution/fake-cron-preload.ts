import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

type CronFunction = {
  (path: string, schedule: string, title: string): Promise<void>;
  parse(schedule: string): Date | null;
  remove(title: string): Promise<void>;
};

class FakeCronLogClass {
  public constructor(private readonly path: string | undefined) {}

  public async append(params: Record<string, string>): Promise<void> {
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(params)}\n`, "utf8");
  }
}

const log = new FakeCronLogClass(process.env.RIG_FAKE_CRON_LOG);
const cron = (async (path: string, schedule: string, title: string) => {
  await log.append({ operation: "register", path, schedule, title });
  if (schedule === process.env.RIG_FAKE_CRON_FAIL_REGISTER_SCHEDULE) {
    throw new Error(`fake register failure: ${schedule}`);
  }
}) as CronFunction;

cron.parse = (schedule: string) => (schedule === "invalid" ? null : new Date(Date.now() + 60_000));
cron.remove = async (title: string) => {
  await log.append({ operation: "remove", title });
  if (title === process.env.RIG_FAKE_CRON_FAIL_REMOVE_TITLE) {
    throw new Error(`fake remove failure: ${title}`);
  }
};

(Bun as unknown as { cron: CronFunction }).cron = cron;

const entrypoint = process.env.RIG_DISTRIBUTION_ENTRY;
if (!entrypoint) throw new Error("RIG_DISTRIBUTION_ENTRY is required.");
const module = (await import(pathToFileURL(entrypoint).href)) as {
  CliApplicationClass: new () => { run(argv: string[]): Promise<void> };
};
await new module.CliApplicationClass().run([
  process.execPath,
  entrypoint,
  ...process.argv.slice(2),
]);
