import { describe, expect, it } from "vitest";
import { endOfLocalDay, parseDueDate, zoneOffsetMinutes } from "../src/tasks/time.ts";

const TZ = "Asia/Jerusalem";

describe("time helpers", () => {
  it("knows Israel's offset in winter and summer", () => {
    expect(zoneOffsetMinutes(new Date("2026-12-01T12:00:00Z"), TZ)).toBe(120);
    expect(zoneOffsetMinutes(new Date("2026-07-01T12:00:00Z"), TZ)).toBe(180);
  });

  it("reads a local date-time in the given zone", () => {
    expect(parseDueDate("2026-12-01T10:00", TZ).toISOString()).toBe("2026-12-01T08:00:00.000Z");
    expect(parseDueDate("2026-07-01T10:00", TZ).toISOString()).toBe("2026-07-01T07:00:00.000Z");
  });

  it("treats a bare date as 09:00 local", () => {
    expect(parseDueDate("2026-12-01", TZ).toISOString()).toBe("2026-12-01T07:00:00.000Z");
  });

  it("keeps an explicit offset", () => {
    expect(parseDueDate("2026-12-01T10:00:00+00:00", TZ).toISOString()).toBe("2026-12-01T10:00:00.000Z");
  });

  it("rejects nonsense", () => {
    expect(() => parseDueDate("next tuesday", TZ)).toThrow();
  });

  it("finds the end of the local day", () => {
    // 23:30 in Israel on Dec 1 is 21:30 UTC; the day ends at 22:00 UTC.
    expect(endOfLocalDay(new Date("2026-12-01T21:30:00Z"), TZ).toISOString()).toBe("2026-12-01T22:00:00.000Z");
    // 00:30 in Israel on Dec 2 is 22:30 UTC on Dec 1; that day ends at 22:00 UTC on Dec 2.
    expect(endOfLocalDay(new Date("2026-12-01T22:30:00Z"), TZ).toISOString()).toBe("2026-12-02T22:00:00.000Z");
  });
});
