import { createApp } from "./app.ts";
import { utcDateOf } from "./date.ts";
import { IngestionService } from "./ingest.ts";
import { KvArchive } from "./kv_archive.ts";
import { fetchEventsCatalogue } from "./source.ts";

const kvPath = Deno.env.get("KV_PATH");
const kv = await Deno.openKv(kvPath);
const archive = new KvArchive(kv);
const ingestion = new IngestionService(archive, fetchEventsCatalogue);
const ingestionEnabled = Deno.env.get("ENABLE_INGESTION") === "true";

Deno.cron(
  "fetch-parkrun-events",
  "0 3 * * *",
  { backoffSchedule: [60_000, 300_000, 1_800_000] },
  async () => {
    if (!ingestionEnabled) {
      log({ event: "ingestion_skipped", reason: "disabled" });
      return;
    }
    const startedAt = performance.now();
    try {
      const outcome = await ingestion.run(utcDateOf(new Date()));
      log({
        event: "ingestion_finished",
        durationMs: Math.round(performance.now() - startedAt),
        ...outcome,
      });
    } catch (error) {
      log({
        event: "ingestion_failed",
        durationMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  },
);

Deno.serve(createApp(archive));

function log(value: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ timestamp: new Date().toISOString(), ...value }),
  );
}
