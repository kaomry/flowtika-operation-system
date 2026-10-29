# Flowtika OS

A multi-agent platform that runs Flowtika's operations. You talk to a Chief of Staff agent on Telegram; it remembers the conversation, hands work to specialist agents, and holds anything that reaches other people or spends money until you approve it.

Built so far: the Phase 0 foundation (Telegram bot, conversation memory, event queue, scheduler, approval buttons, audit log) and Phase 1 tasks, reminders and voice notes. Still to come in Phase 1: inbox, calendar, call summaries and the knowledge layer.

## How it fits together

```
Telegram ─┐
Schedules ├─> queue (pg-boss on Postgres) ─> agent runtime ─> model backend
(webhooks)┘                                       │             (Claude Code or Claude API)
                                                  └─> approval gate ─> actions
Postgres + pgvector: conversation memory, approvals, audit log (knowledge in Phase 1)
```

| Folder | What's in it |
| --- | --- |
| `src/agents` | Agent definitions and the runtime that gives them memory |
| `src/models` | The swappable model backend: Claude Code CLI or Claude API |
| `src/approvals` | The approval gate: request, decide, execute once |
| `src/queue` | Job names and the pg-boss queue |
| `src/scheduler` | Cron schedules |
| `src/telegram` | The bot, approval cards and message formatting |
| `migrations` | SQL migrations, applied automatically on start |

## Set it up on your Mac

You need [Node.js 22+](https://nodejs.org), [Docker Desktop](https://www.docker.com/products/docker-desktop/) and [Claude Code](https://docs.claude.com/en/docs/claude-code) signed in with your Claude account (run `claude` once and log in).

1. **Create the Telegram bot.** In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token it gives you. Then message [@userinfobot](https://t.me/userinfobot) to get your numeric user id.
2. **Install and configure.**
   ```bash
   git clone https://github.com/kaomry/flowtika-operation-system.git
   cd flowtika-operation-system
   npm install
   cp .env.example .env
   ```
   Open `.env` and fill in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID`.
3. **Start the database.**
   ```bash
   docker compose up -d
   ```
4. **Check the setup.** This sends one message through the database, queue and Claude, without Telegram:
   ```bash
   npm run check
   ```
5. **Run it.**
   ```bash
   npm run dev
   ```
   Message your bot. Try `/help`, a normal question, then a follow-up that relies on memory, then `/demo_approval`.

## Commands in Telegram

| Command | What it does |
| --- | --- |
| `/help` | Lists commands |
| `/tasks` | All open tasks |
| `/today` | Tasks due today or overdue |
| `/done 3` | Marks task #3 done |
| `/pending` | Approvals waiting for you |
| `/reset` | Forgets the conversation |
| `/demo_approval` | Sends an approval card so you can try Approve and Reject |

The bot only answers the Telegram user id in `TELEGRAM_OWNER_ID`. Messages from anyone else are ignored and logged.

## Tasks and reminders

Just say it: "remind me to call Dana tomorrow at 10", "add a task to send the college a quote by Sunday", "the proposal is waiting on the client", "what's on my plate?". The Chief of Staff adds or updates tasks and confirms each change under its reply (✓ Added #1 ...). Tasks have a status (to do, in progress, waiting, done, cancelled), a priority and an optional due time.

When a task comes due you get a reminder with **Done**, **+1 hour** and **Tomorrow 9:00** buttons. Each due time reminds once; moving the due time re-arms it. The morning check-in lists what's overdue or due today.

## Voice notes

Send the bot a voice note in Hebrew or English. It's transcribed on the Mac with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), so it's free and the audio never leaves the machine. The bot first shows what it heard (🎙 ...), then answers it like a typed message, so a misheard name is easy to spot.

Setup: install `ffmpeg` and build whisper.cpp's `whisper-cli`, download a multilingual model (for example `ggml-large-v3-turbo.bin`), then set `WHISPER_MODEL` to the model's path in `.env` (and `WHISPER_BIN` / `FFMPEG_BIN` if they aren't on `PATH`). With `WHISPER_MODEL` empty, voice notes are off and the bot says so.

## Model backend

`MODEL_BACKEND=claude-code` (the default) runs the official Claude Code CLI in print mode, signed in with your own Claude subscription, for your own use. Its built-in tools and MCP servers are turned off; agents get capabilities only from this platform. Subscription usage limits assume ordinary individual use, so when the agents run on heavy schedules or around the clock, switch to `MODEL_BACKEND=api` with an `ANTHROPIC_API_KEY` and a monthly spending limit set in the [Claude Console](https://platform.claude.com/). Nothing else changes.

Agents choose a tier (`fast`, `standard`, `deep`); `MODEL_FAST`, `MODEL_STANDARD` and `MODEL_DEEP` map tiers to models.

## Approvals

Anything that reaches another person or spends money goes through `ApprovalService.request`. You get a Telegram card with the exact action and Approve / Reject buttons. The action runs only after you approve, and at most once even if a button is tapped twice or a job retries. Every request, decision and result is written to `audit_log`.

To add an action type, register an executor:

```ts
approvals.register("email.send", async (payload) => {
  // send the email
  return { messageId };
});
```

## Schedules

`DAILY_BRIEF_CRON` (default `0 8 * * *`, in `TIMEZONE`) sends a morning check-in. Leave it empty to turn it off. Schedules are applied on every start.

## Development

```bash
npm run typecheck
npm test                     # unit tests
TEST_DATABASE_URL=postgres://flowtika:flowtika@localhost:5432/flowtika_test npm test   # plus database tests
```

The database tests wipe the database they're given, so point `TEST_DATABASE_URL` at a throwaway one (`createdb flowtika_test`, or `docker compose exec db createdb -U flowtika flowtika_test`).
