import { assertEquals, assertNotEquals } from "@std/assert";
import {
  buildRevision,
  canonicalEventJson,
  diffRevisions,
} from "../src/model.ts";
import type { EventRecord } from "../src/model.ts";

function event(id: number, slug: string, name = slug): EventRecord {
  return {
    id,
    slug,
    name,
    shortName: name,
    localisedName: null,
    location: `${name} park`,
    latitude: 51,
    longitude: -1,
    countryCode: 97,
    countryUrl: "https://www.parkrun.org.uk",
    seriesId: 1,
  };
}

Deno.test("canonical event encoding is stable and field ordered", () => {
  assertEquals(
    canonicalEventJson(event(1, "alpha")),
    canonicalEventJson({ ...event(1, "alpha") }),
  );
});

Deno.test("buildRevision is independent of source event order", async () => {
  const first = await buildRevision([event(1, "alpha"), event(2, "beta")]);
  const second = await buildRevision([event(2, "beta"), event(1, "alpha")]);

  assertEquals(first.hash, second.hash);
  assertEquals(first.bucketHashes, second.bucketHashes);
});

Deno.test("buildRevision changes when retained metadata changes", async () => {
  const before = await buildRevision([event(1, "alpha")]);
  const after = await buildRevision([event(1, "alpha", "renamed")]);

  assertNotEquals(before.hash, after.hash);
});

Deno.test("diffRevisions classifies by numeric ID and treats slug rename as update", async () => {
  const before = await buildRevision([
    event(1, "old-slug"),
    event(2, "gone"),
  ]);
  const after = await buildRevision([
    event(1, "new-slug"),
    event(3, "new"),
  ]);

  assertEquals(diffRevisions(before, after), {
    appeared: [{ id: 3, afterHash: after.eventsById.get(3)!.hash }],
    disappeared: [{ id: 2, beforeHash: before.eventsById.get(2)!.hash }],
    updated: [{
      id: 1,
      beforeHash: before.eventsById.get(1)!.hash,
      afterHash: after.eventsById.get(1)!.hash,
      changedFields: ["SLUG", "NAME", "SHORT_NAME", "LOCATION"],
    }],
  });
});
