import { ChangeReadModel } from "../src/change_views.ts";
import { validateProductionDatabaseUrl } from "../src/history_cli.ts";
import { KvArchive } from "../src/kv_archive.ts";

const apply = parseArguments(Deno.args);
const databaseUrl = validateProductionDatabaseUrl(
  requiredEnvironment("DENO_KV_URL"),
);
requiredEnvironment("DENO_KV_ACCESS_TOKEN");

const kv = await Deno.openKv(databaseUrl);
const heartbeat = setInterval(() => {
  log({ event: "change_view_backfill_active" });
}, 15_000);
try {
  const archive = new KvArchive(kv);
  const views = new ChangeReadModel(kv);
  log({
    event: apply
      ? "change_view_backfill_started"
      : "change_view_validation_started",
  });
  const report = await views.synchronize(archive, {
    apply,
    fromBeginning: !apply,
    onProgress: (progress) =>
      log({
        event: apply
          ? "change_view_date_applied"
          : "change_view_date_validated",
        ...progress,
      }),
  });
  const watermark = await views.getWatermark();
  const finalArchiveDate = (await archive.getArchiveInfo()).latestObservation
    ?.date ?? null;
  if (
    apply &&
    (watermark !== report.throughDate ||
      report.throughDate !== finalArchiveDate)
  ) {
    throw new Error("Archive head changed during change-view backfill");
  }
  log({
    event: apply
      ? "change_view_backfill_finished"
      : "change_view_validation_finished",
    ...report,
    watermark,
    finalArchiveDate,
  });
} finally {
  clearInterval(heartbeat);
  kv.close();
}

function parseArguments(arguments_: readonly string[]): boolean {
  for (const argument of arguments_) {
    if (argument.startsWith("--token") || argument.startsWith("--url")) {
      throw new TypeError(
        "Credentials and database URLs must use environment variables",
      );
    }
    if (argument !== "--apply") {
      throw new TypeError(`Unknown argument ${argument}`);
    }
  }
  return arguments_.includes("--apply");
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function log(value: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ timestamp: new Date().toISOString(), ...value }),
  );
}
