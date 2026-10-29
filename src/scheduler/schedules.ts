import type { PgBoss } from "pg-boss";
import type { Logger } from "../logger.ts";
import { Jobs } from "../queue/jobs.ts";

export interface ScheduleSpec {
  job: string;
  /** Standard 5-field cron. Empty or undefined turns the schedule off. */
  cron: string | undefined;
}

/** Applies schedules on startup, so editing .env and restarting is enough to change them. */
export async function applySchedules(
  boss: PgBoss,
  specs: ScheduleSpec[],
  timezone: string,
  log: Logger,
): Promise<void> {
  for (const spec of specs) {
    if (spec.cron) {
      await boss.schedule(spec.job, spec.cron, null, { tz: timezone });
      log.info({ job: spec.job, cron: spec.cron, timezone }, "schedule on");
    } else {
      await boss.unschedule(spec.job);
      log.info({ job: spec.job }, "schedule off");
    }
  }
}

export const defaultSchedules = (dailyBriefCron: string | undefined): ScheduleSpec[] => [
  { job: Jobs.dailyBrief, cron: dailyBriefCron },
  // Every minute is cheap (one indexed query) and keeps reminders on time.
  { job: Jobs.taskReminders, cron: "* * * * *" },
];
