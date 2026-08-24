export type UtcDate = string;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parseUtcDate(value: string): UtcDate {
  if (!DATE_PATTERN.test(value)) {
    throw new TypeError("Date must use YYYY-MM-DD format");
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(instant.getTime()) ||
    instant.toISOString().slice(0, 10) !== value
  ) {
    throw new TypeError(`Invalid UTC date: ${value}`);
  }
  return value;
}

export function utcDateOf(value: Date): UtcDate {
  if (Number.isNaN(value.getTime())) throw new TypeError("Invalid Date object");
  return value.toISOString().slice(0, 10);
}
