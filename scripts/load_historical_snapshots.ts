import {
  parseHistoricalLoaderArgs,
  runHistoricalLoader,
} from "../src/history_cli.ts";

if (import.meta.main) {
  try {
    await runHistoricalLoader(parseHistoricalLoaderArgs(Deno.args));
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`${name}: ${message}`);
    Deno.exitCode = 1;
  }
}
