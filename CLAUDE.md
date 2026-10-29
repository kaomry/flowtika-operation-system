# Flowtika OS

TypeScript (ESM, Node 22, run with tsx) multi-agent platform. Postgres + pgvector, pg-boss queue, grammY Telegram bot.

- Agents never call a model SDK directly; they go through `ModelBackend` in `src/models`.
- Anything that reaches another person or spends money must go through `ApprovalService.request`. Internal actions run directly but are written to `audit_log`.
- New triggers become a job name in `src/queue/jobs.ts` plus a handler in `src/worker.ts`.
- Schema changes are new numbered files in `migrations/`; never edit an applied migration.
- Before committing: `npm run typecheck` and `npm test` (with `TEST_DATABASE_URL` for the database tests).
