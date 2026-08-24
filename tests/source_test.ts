import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  parseEventsDocument,
  readJsonResponse,
  SourceDataError,
} from "../src/source.ts";
import { eventFeature, eventsDocument } from "./fixtures/events.ts";

Deno.test("parseEventsDocument normalizes retained event metadata", () => {
  const document = eventsDocument([
    eventFeature(1, "bushy", {
      properties: {
        EventLongName: "Bushy parkrun",
        EventShortName: "Bushy Park",
        LocalisedEventLongName: null,
        EventLocation: "Bushy Park, Teddington",
        countrycode: 97,
        seriesid: 1,
      },
    }),
  ]);

  assertEquals(parseEventsDocument(document, { minimumEventCount: 1 }), [{
    id: 1,
    slug: "bushy",
    name: "Bushy parkrun",
    shortName: "Bushy Park",
    localisedName: null,
    location: "Bushy Park, Teddington",
    latitude: 51.410992,
    longitude: -0.335791,
    countryCode: 97,
    countryUrl: "https://www.parkrun.org.uk",
    seriesId: 1,
  }]);
});

Deno.test("parseEventsDocument accepts an empty source location", () => {
  const document = eventsDocument([
    eventFeature(1, "alpha", {
      properties: { EventLocation: "" },
    }),
  ]);

  assertEquals(
    parseEventsDocument(document, { minimumEventCount: 1 })[0]!.location,
    "",
  );
});

Deno.test("parseEventsDocument rejects duplicate IDs", () => {
  const document = eventsDocument([
    eventFeature(1, "alpha"),
    eventFeature(1, "beta"),
  ]);

  const error = assertThrows(
    () => parseEventsDocument(document, { minimumEventCount: 1 }),
    SourceDataError,
  );
  assertEquals(error.code, "DUPLICATE_EVENT_ID");
});

Deno.test("parseEventsDocument rejects duplicate slugs", () => {
  const document = eventsDocument([
    eventFeature(1, "alpha"),
    eventFeature(2, "alpha"),
  ]);

  const error = assertThrows(
    () => parseEventsDocument(document, { minimumEventCount: 1 }),
    SourceDataError,
  );
  assertEquals(error.code, "DUPLICATE_EVENT_SLUG");
});

Deno.test("parseEventsDocument rejects invalid coordinates", () => {
  const document = eventsDocument([
    eventFeature(1, "alpha", {
      geometry: { type: "Point", coordinates: [181, 51] },
    }),
  ]);

  const error = assertThrows(
    () => parseEventsDocument(document, { minimumEventCount: 1 }),
    SourceDataError,
  );
  assertEquals(error.code, "INVALID_EVENT_COORDINATES");
});

Deno.test("parseEventsDocument rejects a partial bootstrap", () => {
  const document = eventsDocument([eventFeature(1, "alpha")]);

  const error = assertThrows(
    () => parseEventsDocument(document),
    SourceDataError,
  );
  assertEquals(error.code, "TOO_FEW_EVENTS");
});

Deno.test("readJsonResponse enforces the decoded body limit", async () => {
  const response = new Response(JSON.stringify({ value: "x".repeat(100) }), {
    headers: { "content-type": "application/json" },
  });

  const error = await assertRejects(
    () => readJsonResponse(response, 32),
    SourceDataError,
  );
  assertEquals(error.code, "SOURCE_TOO_LARGE");
});
