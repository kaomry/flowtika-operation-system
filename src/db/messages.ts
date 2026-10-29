import type { Db } from "./pool.ts";

export type Role = "user" | "assistant";

export interface StoredMessage {
  role: Role;
  content: string;
  agent: string | null;
  createdAt: Date;
}

export async function saveMessage(
  db: Db,
  chatId: number,
  role: Role,
  content: string,
  agent?: string,
): Promise<void> {
  await db.query(
    "insert into messages (chat_id, role, content, agent) values ($1, $2, $3, $4)",
    [chatId, role, content, agent ?? null],
  );
}

/** The last `limit` messages of a chat, oldest first. */
export async function recentMessages(db: Db, chatId: number, limit: number): Promise<StoredMessage[]> {
  const { rows } = await db.query<{
    role: Role;
    content: string;
    agent: string | null;
    created_at: Date;
  }>(
    `select role, content, agent, created_at from (
       select id, role, content, agent, created_at from messages
       where chat_id = $1 order by created_at desc, id desc limit $2
     ) recent order by created_at asc, id asc`,
    [chatId, limit],
  );
  return rows.map((r) => ({ role: r.role, content: r.content, agent: r.agent, createdAt: r.created_at }));
}

export async function clearMessages(db: Db, chatId: number): Promise<void> {
  await db.query("delete from messages where chat_id = $1", [chatId]);
}
