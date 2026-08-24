import { parseUtcDate, utcDateOf } from "./date.ts";
import {
  readHistoricalSnapshot,
  readHistoricalSnapshotManifest,
} from "./history_manifest.ts";
import {
  HistoricalSnapshotConflictError,
  HistoricalSnapshotLoader,
  type HistoricalSnapshotLoadReport,
} from "./history_loader.ts";
import { KvArchive } from "./kv_archive.ts";
import { buildRevision } from "./model.ts";

export interface HistoricalLoaderArguments {
  readonly manifestPath: string | null;
  readonly databaseUrl: string | null;
  readonly apply: boolean;
  readonly allowPending: boolean;
  readonly help: boolean;
}

export interface HistoricalLoaderRunOptions {
  readonly today?: string;
  readonly env?: (name: string) => string | undefined;
  readonly writeLine?: (line: string) => void;
}

export function parseHistoricalLoaderArgs(
  args: readonly string[],
): HistoricalLoaderArguments {
  let manifestPath: string | null = null;
  let databaseUrl: string | null = null;
  let apply = false;
  let allowPending = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--apply") {
      if (apply) throw new TypeError("Duplicate --apply argument");
      apply = true;
    } else if (argument === "--allow-pending") {
      if (allowPending) {
        throw new TypeError("Duplicate --allow-pending argument");
      }
      allowPending = true;
    } else if (argument === "--manifest") {
      manifestPath = uniqueOptionValue(
        "--manifest",
        manifestPath,
        args[++index],
      );
    } else if (argument.startsWith("--manifest=")) {
      manifestPath = uniqueOptionValue(
        "--manifest",
        manifestPath,
        argument.slice("--manifest=".length),
      );
    } else if (argument === "--database-url") {
      databaseUrl = uniqueOptionValue(
        "--database-url",
        databaseUrl,
        args[++index],
      );
    } else if (argument.startsWith("--database-url=")) {
      databaseUrl = uniqueOptionValue(
        "--database-url",
        databaseUrl,
        argument.slice("--database-url=".length),
      );
    } else {
      throw new TypeError(`Unknown argument ${argument}`);
    }
  }

  if (!help && manifestPath === null) {
    throw new TypeError("--manifest is required");
  }
  if (allowPending && !apply) {
    throw new TypeError("--allow-pending requires --apply");
  }
  return { manifestPath, databaseUrl, apply, allowPending, help };
}

export function validateProductionDatabaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidDatabaseUrl();
  }
  if (
    url.protocol !== "https:" || url.hostname !== "api.deno.com" ||
    url.port !== "" || url.username !== "" || url.password !== "" ||
    url.search !== "" || url.hash !== "" ||
    !/^\/v2\/databases\/[^/]+\/connect\/?$/u.test(url.pathname)
  ) {
    throw invalidDatabaseUrl();
  }
  return url.href.endsWith("/") ? url.href.slice(0, -1) : url.href;
}

export async function runHistoricalLoader(
  arguments_: HistoricalLoaderArguments,
  options: HistoricalLoaderRunOptions = {},
): Promise<HistoricalSnapshotLoadReport | null> {
  if (arguments_.help) {
    (options.writeLine ?? console.log)(historicalLoaderHelp());
    return null;
  }
  const manifestPath = arguments_.manifestPath!;
  const writeLine = options.writeLine ?? console.log;
  const today = parseUtcDate(options.today ?? utcDateOf(new Date()));
  const manifest = await readHistoricalSnapshotManifest(manifestPath);

  for (const entry of manifest.snapshots) {
    if (entry.date > today) {
      throw new RangeError(
        `Historical snapshot ${entry.date} is in the future`,
      );
    }
    const snapshot = await readHistoricalSnapshot(manifestPath, entry);
    const revision = await buildRevision(snapshot.events);
    writeLine(JSON.stringify({
      event: "snapshot_validated",
      date: entry.date,
      sourceSha256: snapshot.sourceSha256,
      revisionHash: revision.hash,
      eventCount: revision.manifest.eventCount,
    }));
  }

  if (!arguments_.apply) {
    writeLine(JSON.stringify({
      event: "snapshot_validation_finished",
      snapshotCount: manifest.snapshots.length,
    }));
    return null;
  }

  const env = options.env ?? Deno.env.get;
  if (!env("DENO_KV_ACCESS_TOKEN")) {
    throw new TypeError(
      "DENO_KV_ACCESS_TOKEN is required to write production Deno KV",
    );
  }
  const databaseUrl = validateProductionDatabaseUrl(
    arguments_.databaseUrl ?? env("DENO_KV_URL") ?? "",
  );
  const kv = await Deno.openKv(databaseUrl);
  try {
    const loader = new HistoricalSnapshotLoader(new KvArchive(kv));
    const report = await loader.load(
      manifest.snapshots,
      (entry) => readHistoricalSnapshot(manifestPath, entry),
      { today },
    );
    for (const row of report.rows) {
      writeLine(JSON.stringify({
        event: "snapshot_load_finished",
        sourceSha256: row.sourceSha256,
        ...row.outcome,
      }));
    }
    if (report.pendingDate !== null && !arguments_.allowPending) {
      throw new HistoricalSnapshotConflictError(
        `Snapshot ${report.pendingDate} still requires a later confirming snapshot`,
      );
    }
    writeLine(JSON.stringify({
      event: "historical_load_finished",
      snapshotCount: report.rows.length,
      pendingDate: report.pendingDate,
    }));
    return report;
  } finally {
    kv.close();
  }
}

export function historicalLoaderHelp(): string {
  return `Load dated parkrun events.json snapshots into Deno KV.

Validate only (default):
  deno task history:load --manifest <path>

Apply to production after validation succeeds:
  DENO_KV_ACCESS_TOKEN=<token> DENO_KV_URL=<connector-url> \\
    deno task history:load --manifest <path> --apply

Options:
  --manifest <path>       JSON manifest and snapshot base directory
  --database-url <url>    Production Deno KV connector URL; alternatively DENO_KV_URL
  --apply                 Write snapshots after validating every file
  --allow-pending         Permit the last anomaly to remain unpublished
  -h, --help              Show this help

Tokens are accepted only through DENO_KV_ACCESS_TOKEN, never command arguments.`;
}

function uniqueOptionValue(
  name: string,
  current: string | null,
  next: string | undefined,
): string {
  if (current !== null) throw new TypeError(`Duplicate ${name} argument`);
  if (next === undefined || next.length === 0 || next.startsWith("--")) {
    throw new TypeError(`${name} requires a value`);
  }
  return next;
}

function invalidDatabaseUrl(): TypeError {
  return new TypeError(
    "Expected a production Deno KV connector URL at https://api.deno.com/v2/databases/<id>/connect",
  );
}
