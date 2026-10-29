import type { Db } from "./pool.ts";

/** Every action the platform takes is recorded here, whether or not it needed approval. */
export async function audit(
  db: Db,
  actor: string,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.query("insert into audit_log (actor, action, detail) values ($1, $2, $3)", [
    actor,
    action,
    JSON.stringify(detail),
  ]);
}
