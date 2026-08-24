import { assertEquals, assertThrows } from "@std/assert";
import { parseUtcDate, utcDateOf } from "../src/date.ts";

Deno.test("parseUtcDate accepts canonical real dates", () => {
  assertEquals(parseUtcDate("2024-02-29"), "2024-02-29");
  assertThrows(() => parseUtcDate("2023-02-29"));
  assertThrows(() => parseUtcDate("2026-8-1"));
  assertThrows(() => parseUtcDate("2026-08-01T00:00:00Z"));
});

Deno.test("utcDateOf uses UTC rather than local time", () => {
  assertEquals(utcDateOf(new Date("2026-08-24T23:59:59Z")), "2026-08-24");
});
