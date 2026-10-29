import { PgBoss } from "pg-boss";
import type { Logger } from "../logger.ts";
import { Jobs } from "./jobs.ts";

export async function startQueue(connectionString: string, log: Logger): Promise<PgBoss> {
  const boss = new PgBoss(connectionString);
  boss.on("error", (err) => log.error({ err }, "queue error"));
  await boss.start();
  for (const name of Object.values(Jobs)) {
    await boss.createQueue(name);
  }
  return boss;
}
