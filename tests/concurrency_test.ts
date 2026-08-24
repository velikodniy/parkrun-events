import { assertEquals } from "@std/assert";
import { mapWithConcurrency, Semaphore } from "../src/concurrency.ts";

Deno.test("Semaphore bounds independently launched work", async () => {
  const semaphore = new Semaphore(3);
  let active = 0;
  let maximumActive = 0;
  await Promise.all(Array.from({ length: 20 }, () =>
    semaphore.run(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    })));

  assertEquals(maximumActive, 3);
});

Deno.test("mapWithConcurrency preserves order and bounds active work", async () => {
  let active = 0;
  let maximumActive = 0;
  const results = await mapWithConcurrency(
    Array.from({ length: 20 }, (_, index) => index),
    4,
    async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return value * 2;
    },
  );

  assertEquals(results, Array.from({ length: 20 }, (_, index) => index * 2));
  assertEquals(maximumActive, 4);
});
