import { audit } from "../db/audit.ts";
import type { Db } from "../db/pool.ts";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "executed" | "failed";

export interface Approval {
  id: string;
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
  requestedBy: string;
  status: ApprovalStatus;
  telegramChatId: number | null;
  telegramMessageId: number | null;
  result: Record<string, unknown> | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface ApprovalRequest {
  kind: string;
  /** Exactly what will happen, shown to the owner on the approval card. */
  summary: string;
  payload: Record<string, unknown>;
  requestedBy: string;
}

/** Shows approval cards to the owner (Telegram today) and updates them after a decision. */
export interface ApprovalPresenter {
  present(approval: Approval): Promise<{ chatId: number; messageId: number }>;
  update(approval: Approval): Promise<void>;
}

/** Performs the approved action. Runs only after the owner approves. */
export type ApprovalExecutor = (
  payload: Record<string, unknown>,
  approval: Approval,
) => Promise<Record<string, unknown> | void>;

interface ApprovalRow {
  id: string;
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
  requested_by: string;
  status: ApprovalStatus;
  telegram_chat_id: string | null;
  telegram_message_id: string | null;
  result: Record<string, unknown> | null;
  created_at: Date;
  decided_at: Date | null;
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    requestedBy: row.requested_by,
    status: row.status,
    telegramChatId: row.telegram_chat_id === null ? null : Number(row.telegram_chat_id),
    telegramMessageId: row.telegram_message_id === null ? null : Number(row.telegram_message_id),
    result: row.result,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

/**
 * The approval gate. Anything that reaches another person or spends money goes through
 * `request`, and its executor runs only after the owner taps Approve.
 */
export class ApprovalService {
  private readonly executors = new Map<string, ApprovalExecutor>();
  private presenter?: ApprovalPresenter;

  constructor(private readonly db: Db) {}

  setPresenter(presenter: ApprovalPresenter): void {
    this.presenter = presenter;
  }

  register(kind: string, executor: ApprovalExecutor): void {
    this.executors.set(kind, executor);
  }

  async request(req: ApprovalRequest): Promise<Approval> {
    if (!this.executors.has(req.kind)) throw new Error(`No executor registered for "${req.kind}"`);
    const { rows } = await this.db.query<ApprovalRow>(
      `insert into approvals (kind, summary, payload, requested_by)
       values ($1, $2, $3, $4) returning *`,
      [req.kind, req.summary, JSON.stringify(req.payload), req.requestedBy],
    );
    let approval = toApproval(rows[0]!);
    await audit(this.db, req.requestedBy, "approval.requested", { id: approval.id, kind: req.kind });

    if (this.presenter) {
      const shown = await this.presenter.present(approval);
      const updated = await this.db.query<ApprovalRow>(
        `update approvals set telegram_chat_id = $2, telegram_message_id = $3
         where id = $1 returning *`,
        [approval.id, shown.chatId, shown.messageId],
      );
      approval = toApproval(updated.rows[0]!);
    }
    return approval;
  }

  async get(id: string): Promise<Approval | null> {
    const { rows } = await this.db.query<ApprovalRow>("select * from approvals where id = $1", [id]);
    return rows[0] ? toApproval(rows[0]) : null;
  }

  async listPending(): Promise<Approval[]> {
    const { rows } = await this.db.query<ApprovalRow>(
      "select * from approvals where status = 'pending' order by created_at asc",
    );
    return rows.map(toApproval);
  }

  /**
   * Records the owner's decision. Returns null when the approval was already decided, so a
   * double tap can never run an action twice.
   */
  async decide(id: string, decision: "approved" | "rejected", actor = "owner"): Promise<Approval | null> {
    const { rows } = await this.db.query<ApprovalRow>(
      `update approvals set status = $2, decided_at = now()
       where id = $1 and status = 'pending' returning *`,
      [id, decision],
    );
    if (!rows[0]) return null;
    const approval = toApproval(rows[0]);
    await audit(this.db, actor, `approval.${decision}`, { id, kind: approval.kind });
    await this.presenter?.update(approval);
    return approval;
  }

  /**
   * Runs an approved action at most once. Setting executed_at claims the row, so a retried job
   * or a second worker can't send the same message twice.
   */
  async execute(id: string): Promise<Approval> {
    const { rows } = await this.db.query<ApprovalRow>(
      `update approvals set executed_at = now()
       where id = $1 and status = 'approved' and executed_at is null returning *`,
      [id],
    );
    if (!rows[0]) {
      const current = await this.get(id);
      if (!current) throw new Error(`Approval ${id} not found`);
      return current;
    }
    const approval = toApproval(rows[0]);
    const executor = this.executors.get(approval.kind);
    let status: ApprovalStatus = "executed";
    let result: Record<string, unknown>;
    try {
      if (!executor) throw new Error(`No executor registered for "${approval.kind}"`);
      result = (await executor(approval.payload, approval)) ?? {};
    } catch (err) {
      status = "failed";
      result = { error: (err as Error).message };
    }
    const updated = await this.db.query<ApprovalRow>(
      "update approvals set status = $2, result = $3 where id = $1 returning *",
      [id, status, JSON.stringify(result)],
    );
    const final = toApproval(updated.rows[0]!);
    await audit(this.db, "platform", `approval.${status}`, { id, kind: final.kind, result });
    await this.presenter?.update(final);
    return final;
  }
}
