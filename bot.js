// filename: bot.js
import "dotenv/config";
import { Telegraf } from "telegraf";
import Database from "better-sqlite3";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is missing. Put it into .env");
  process.exit(1);
}

const DB_PATH = process.env.DB_PATH || "./members.db";

const bot = new Telegraf(BOT_TOKEN);

// -------------------- DB --------------------
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_members (
    chat_id     TEXT NOT NULL,
    user_id     INTEGER NOT NULL,
    first_name  TEXT,
    last_name   TEXT,
    username    TEXT,
    is_bot      INTEGER NOT NULL DEFAULT 0,
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_chat_members_chat_first_seen
    ON chat_members(chat_id, first_seen);
`);

const upsertMemberStmt = db.prepare(`
  INSERT INTO chat_members (chat_id, user_id, first_name, last_name, username, is_bot, first_seen, last_seen)
  VALUES (@chat_id, @user_id, @first_name, @last_name, @username, @is_bot, @now, @now)
  ON CONFLICT(chat_id, user_id) DO UPDATE SET
    first_name = excluded.first_name,
    last_name  = excluded.last_name,
    username   = excluded.username,
    is_bot     = excluded.is_bot,
    last_seen  = excluded.last_seen
`);

const selectMembersStmt = db.prepare(`
  SELECT user_id, first_name, last_name, username
  FROM chat_members
  WHERE chat_id = ?
    AND is_bot = 0
  ORDER BY first_seen ASC
  LIMIT ?
`);

// -------------------- Helpers --------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function displayName(u) {
  // Приоритет: first_name last_name -> @username -> id
  const full =
    [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  if (full) return full;
  if (u.username) return `@${u.username}`;
  return `id:${u.user_id}`;
}

function mentionHtml(u) {
  const label = escapeHtml(displayName(u));
  return `<a href="tg://user?id=${u.user_id}">${label}</a>`;
}

function isGroupChat(ctx) {
  const t = ctx.chat?.type;
  return t === "group" || t === "supergroup";
}

async function isAdmin(ctx, userId) {
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return member?.status === "administrator" || member?.status === "creator";
  } catch (e) {
    console.error("getChatMember failed:", e?.message || e);
    return false;
  }
}

function storeUser(chatId, user) {
  if (!chatId || !user || !user.id) return;
  upsertMemberStmt.run({
    chat_id: String(chatId),
    user_id: user.id,
    first_name: user.first_name ?? null,
    last_name: user.last_name ?? null,
    username: user.username ?? null,
    is_bot: user.is_bot ? 1 : 0,
    now: Date.now()
  });
}

// -------------------- Collect members --------------------
// Любое сообщение: сохраняем автора (если бота видно).
bot.on("message", async (ctx, next) => {
  if (ctx.from && ctx.chat?.id) {
    storeUser(ctx.chat.id, ctx.from);
  }
  return next();
});

// Событие вступления новых участников (если приходит апдейт)
bot.on("new_chat_members", async (ctx) => {
  const chatId = ctx.chat?.id;
  const members = ctx.message?.new_chat_members || [];
  for (const m of members) {
    storeUser(chatId, m);
  }
});

// -------------------- Commands --------------------
bot.start(async (ctx) => {
  await ctx.reply(
    "Я готов. Используй /tagall ответом (reply) на важное сообщение."
  );
});

bot.command("tagall", async (ctx) => {
  try {
    if (!isGroupChat(ctx)) {
      return ctx.reply("Команда работает только в группах.");
    }

    // Команда должна быть reply на важное сообщение
    const replied = ctx.message?.reply_to_message;
    if (!replied) {
      return ctx.reply("Использование: ответь (reply) на важное сообщение и напиши /tagall");
    }

    // Проверка админа
    const ok = await isAdmin(ctx, ctx.from.id);
    if (!ok) {
      return ctx.reply("⛔️ Команда доступна только админам группы.");
    }

    const chatId = ctx.chat.id;
    const targetMessageId = replied.message_id;

    // Берём максимум 100 "первых по порядку" (first_seen ASC)
    const MAX_USERS = 100;
    const CHUNK = 20;

    const members = selectMembersStmt.all(String(chatId), MAX_USERS);

    if (!members.length) {
      return ctx.reply("Пока некого упоминать: я ещё не собрал базу участников.");
    }

    // Формируем чанки по 20
    const chunks = [];
    for (let i = 0; i < members.length; i += CHUNK) {
      chunks.push(members.slice(i, i + CHUNK));
    }

    // Отправляем: каждый чанк — отдельное сообщение-реплай на важное
    for (let i = 0; i < chunks.length; i++) {
      const text = chunks[i].map(mentionHtml).join("  ");

      try {
        await ctx.telegram.sendMessage(chatId, text, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_to_message_id: targetMessageId,
          allow_sending_without_reply: true
        });
      } catch (e) {
        // Если поймали 429 — подождём retry_after и продолжим
        const retryAfter = e?.parameters?.retry_after;
        if (retryAfter) {
          console.warn(`Rate limit: retry_after=${retryAfter}s`);
          await sleep((retryAfter + 1) * 1000);
          i--; // повторим отправку этого же чанка
          continue;
        }
        throw e;
      }

      // Бережный интервал между сообщениями, чтобы не ловить лимиты
      if (i < chunks.length - 1) {
        await sleep(1200);
      }
    }
  } catch (e) {
    console.error("tagall error:", e?.stack || e);
    return ctx.reply("❌ Ошибка при выполнении /tagall. Посмотри логи бота.");
  }
});

// -------------------- Launch --------------------
bot.launch()
  .then(() => console.log("✅ Bot started"))
  .catch((e) => {
    console.error("❌ Failed to launch bot:", e);
    process.exit(1);
  });

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
