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
const MAX_USERS = Math.max(1, parseInt(process.env.TAGALL_MAX_USERS, 10) || 100);
const CHUNK = Math.max(1, parseInt(process.env.TAGALL_CHUNK_SIZE, 10) || 20);
const DELAY_MS = Math.max(0, parseInt(process.env.TAGALL_DELAY_MS, 10) || 1200);
const COOLDOWN_SEC = Math.max(0, parseInt(process.env.TAGALL_COOLDOWN_SEC, 10) || 60);
const MENTION_SEPARATOR = " | ";

const bot = new Telegraf(BOT_TOKEN);

// -------------------- DB --------------------
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

try {
  db.prepare("SELECT 1").get();
} catch (e) {
  console.error("❌ DB unavailable:", e?.message || e);
  process.exit(1);
}

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

  CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id            TEXT NOT NULL PRIMARY KEY,
    tagall_only_admins INTEGER NOT NULL DEFAULT 1
  );
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

const getTagallOnlyAdminsStmt = db.prepare(`
  SELECT tagall_only_admins FROM chat_settings WHERE chat_id = ?
`);
const setTagallOnlyAdminsStmt = db.prepare(`
  INSERT INTO chat_settings (chat_id, tagall_only_admins) VALUES (?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET tagall_only_admins = excluded.tagall_only_admins
`);

function getTagallOnlyAdmins(chatId) {
  const row = getTagallOnlyAdminsStmt.get(String(chatId));
  return row == null ? true : row.tagall_only_admins !== 0;
}

// -------------------- Cooldown --------------------
const tagallLastRun = new Map();

function checkCooldown(chatId) {
  if (COOLDOWN_SEC <= 0) return null;
  const last = tagallLastRun.get(String(chatId));
  if (!last) return null;
  const elapsed = (Date.now() - last) / 1000;
  if (elapsed < COOLDOWN_SEC) return Math.ceil(COOLDOWN_SEC - elapsed);
  return null;
}

function setCooldown(chatId) {
  tagallLastRun.set(String(chatId), Date.now());
}

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
bot.on("message", async (ctx, next) => {
  if (ctx.from && ctx.chat?.id) {
    storeUser(ctx.chat.id, ctx.from);
  }
  return next();
});

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

bot.command("ping", async (ctx) => {
  try {
    db.prepare("SELECT 1").get();
    await ctx.reply("OK");
  } catch (e) {
    await ctx.reply("Ошибка БД");
  }
});

bot.command("admin", async (ctx) => {
  if (!isGroupChat(ctx)) {
    return ctx.reply("Команда только для групп.");
  }
  const ok = await isAdmin(ctx, ctx.from.id);
  if (!ok) {
    return ctx.reply("⛔️ Только админы группы могут менять настройки.");
  }
  const chatId = ctx.chat.id;
  const onlyAdmins = getTagallOnlyAdmins(chatId);
  await ctx.reply("Кто может использовать /tagall?", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: onlyAdmins ? "✓ Только админы" : "Только админы", callback_data: "tagall_who:admins" },
          { text: !onlyAdmins ? "✓ Все участники" : "Все участники", callback_data: "tagall_who:all" }
        ]
      ]
    }
  });
});

bot.action(/^tagall_who:(admins|all)$/, async (ctx) => {
  const who = ctx.match[1];
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery("Ошибка");
  const isAdminUser = await isAdmin(ctx, ctx.from.id);
  if (!isAdminUser) {
    return ctx.answerCbQuery("Только админы могут менять настройки.");
  }
  const onlyAdmins = who === "admins" ? 1 : 0;
  setTagallOnlyAdminsStmt.run(String(chatId), onlyAdmins);
  const onlyAdminsNow = getTagallOnlyAdmins(chatId);
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({
    inline_keyboard: [
      [
        { text: onlyAdminsNow ? "✓ Только админы" : "Только админы", callback_data: "tagall_who:admins" },
        { text: !onlyAdminsNow ? "✓ Все участники" : "Все участники", callback_data: "tagall_who:all" }
      ]
    ]
  }).catch(() => {});
});

bot.command("tagall", async (ctx) => {
  try {
    if (!isGroupChat(ctx)) {
      return ctx.reply("Команда работает только в группах.");
    }

    const replied = ctx.message?.reply_to_message;
    if (!replied) {
      return ctx.reply("Использование: ответь (reply) на важное сообщение и напиши /tagall");
    }

    const chatId = ctx.chat.id;
    const onlyAdmins = getTagallOnlyAdmins(chatId);
    if (onlyAdmins) {
      const ok = await isAdmin(ctx, ctx.from.id);
      if (!ok) {
        return ctx.reply("⛔️ Команда доступна только админам группы.");
      }
    }

    const waitSec = checkCooldown(chatId);
    if (waitSec != null) {
      return ctx.reply(`Подожди ещё ${waitSec} сек. перед следующим /tagall.`);
    }

    const members = selectMembersStmt.all(String(chatId), MAX_USERS);

    if (!members.length) {
      return ctx.reply("Пока некого упоминать: я ещё не собрал базу участников.");
    }

    const chunks = [];
    for (let i = 0; i < members.length; i += CHUNK) {
      chunks.push(members.slice(i, i + CHUNK));
    }

    const targetMessageId = replied.message_id;
    setCooldown(chatId);
    console.log(`tagall chat=${chatId} members=${members.length} chunks=${chunks.length}`);

    for (let i = 0; i < chunks.length; i++) {
      const text = chunks[i].map(mentionHtml).join(MENTION_SEPARATOR);

      try {
        await ctx.telegram.sendMessage(chatId, text, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_to_message_id: targetMessageId,
          allow_sending_without_reply: true
        });
      } catch (e) {
        const retryAfter = e?.parameters?.retry_after;
        if (retryAfter) {
          console.warn(`tagall rate limit chat=${chatId} retry_after=${retryAfter}s`);
          await sleep((retryAfter + 1) * 1000);
          i--;
          continue;
        }
        throw e;
      }

      if (i < chunks.length - 1) {
        await sleep(DELAY_MS);
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

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
