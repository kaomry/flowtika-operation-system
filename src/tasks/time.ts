/** Offset of `timeZone` from UTC at the instant `date`, in minutes (Asia/Jerusalem in winter: 120). */
export function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Parses a date-time from an agent. One with an offset or Z is taken as is; one without
 * ("2026-10-30T10:00" or "2026-10-30") is read as local time in `timeZone`. A bare date means 09:00.
 */
export function parseDueDate(value: string, timeZone: string): Date {
  const trimmed = value.trim();
  const local = LOCAL.exec(trimmed);
  if (!local) {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) throw new Error(`Not a date: ${value}`);
    return parsed;
  }
  const [, y, mo, d, h = "09", mi = "00", s = "00"] = local;
  const wallClockAsUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  // Two passes settle the offset when the wall-clock time sits near a DST change.
  let guess = wallClockAsUtc - zoneOffsetMinutes(new Date(wallClockAsUtc), timeZone) * 60000;
  guess = wallClockAsUtc - zoneOffsetMinutes(new Date(guess), timeZone) * 60000;
  return new Date(guess);
}

export function formatLocal(date: Date, timeZone: string): string {
  return date.toLocaleString("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The start of the next local day after `now` in `timeZone`. */
export function endOfLocalDay(now: Date, timeZone: string): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
  const next = new Date(`${ymd}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return parseDueDate(next.toISOString().slice(0, 10) + "T00:00", timeZone);
}
