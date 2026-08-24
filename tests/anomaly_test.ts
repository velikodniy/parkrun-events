import { assertEquals } from "@std/assert";
import {
  anomalyRequiresConfirmation,
  confirmsPendingChanges,
} from "../src/diff.ts";
import type { CatalogueDiff, EventRecord } from "../src/model.ts";

function diff(changed: number): CatalogueDiff {
  return {
    appeared: Array.from({ length: changed }, (_, index) => ({
      id: index + 1,
      afterHash: `hash-${index + 1}`,
    })),
    disappeared: [],
    updated: [],
  };
}

Deno.test("anomaly threshold is strictly over 100 or ten percent", () => {
  assertEquals(anomalyRequiresConfirmation(diff(100), 1_000), false);
  assertEquals(anomalyRequiresConfirmation(diff(101), 2_000), true);
  assertEquals(anomalyRequiresConfirmation(diff(10), 100), false);
  assertEquals(anomalyRequiresConfirmation(diff(11), 100), true);
});

Deno.test("confirmation allows unrelated changes while pending transitions persist", () => {
  const record = (id: number, slug: string): EventRecord => ({
    id,
    slug,
    name: slug,
    shortName: slug,
    localisedName: null,
    location: slug,
    latitude: 0,
    longitude: 0,
    countryCode: 97,
    countryUrl: "https://www.parkrun.org.uk",
    seriesId: 1,
  });

  const pending: CatalogueDiff = {
    appeared: [{ id: 2, afterHash: "two" }],
    disappeared: [{ id: 3, beforeHash: "three" }],
    updated: [{
      id: 1,
      beforeHash: "old-one",
      afterHash: "new-one",
      changedFields: ["SLUG"],
    }],
  };
  const candidate = new Map([
    [1, { event: record(1, "new"), hash: "new-one" }],
    [2, { event: record(2, "two"), hash: "two" }],
    [4, { event: record(4, "unrelated"), hash: "four" }],
  ]);

  assertEquals(confirmsPendingChanges(pending, candidate), true);
  candidate.set(2, { event: record(2, "two-corrected"), hash: "corrected" });
  assertEquals(confirmsPendingChanges(pending, candidate), true);
  candidate.set(3, { event: record(3, "three"), hash: "three" });
  assertEquals(confirmsPendingChanges(pending, candidate), false);
});
