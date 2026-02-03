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

  CREATE TABLE IF NOT EXISTS chat_teams (
    chat_id TEXT NOT NULL,
    slug    TEXT NOT NULL,
    PRIMARY KEY (chat_id, slug)
  );

  CREATE TABLE IF NOT EXISTS chat_team_members (
    chat_id TEXT NOT NULL,
    slug    TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (chat_id, slug, user_id)
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

// Teams
const distinctChatIdsStmt = db.prepare(`SELECT DISTINCT chat_id FROM chat_members`);
const insertTeamStmt = db.prepare(`INSERT INTO chat_teams (chat_id, slug) VALUES (?, ?)`);
const getTeamStmt = db.prepare(`SELECT 1 FROM chat_teams WHERE chat_id = ? AND slug = ?`);
const listTeamsStmt = db.prepare(`SELECT slug FROM chat_teams WHERE chat_id = ? ORDER BY slug`);
const insertTeamMemberStmt = db.prepare(`
  INSERT INTO chat_team_members (chat_id, slug, user_id) VALUES (?, ?, ?)
`);
const deleteTeamMemberStmt = db.prepare(`
  DELETE FROM chat_team_members WHERE chat_id = ? AND slug = ? AND user_id = ?
`);
const teamMemberCountStmt = db.prepare(`
  SELECT COUNT(*) AS n FROM chat_team_members WHERE chat_id = ? AND slug = ?
`);
const selectTeamMembersStmt = db.prepare(`
  SELECT m.user_id, m.first_name, m.last_name, m.username
  FROM chat_team_members t
  JOIN chat_members m ON m.chat_id = t.chat_id AND m.user_id = t.user_id
  WHERE t.chat_id = ? AND t.slug = ?
  ORDER BY m.first_seen ASC
`);
const selectChatMembersNotInTeamStmt = db.prepare(`
  SELECT user_id, first_name, last_name, username
  FROM chat_members
  WHERE chat_id = ? AND is_bot = 0
    AND user_id NOT IN (SELECT user_id FROM chat_team_members WHERE chat_id = ? AND slug = ?)
  ORDER BY first_seen ASC
`);
const selectTeamMembersForRemovalStmt = db.prepare(`
  SELECT m.user_id, m.first_name, m.last_name, m.username
  FROM chat_team_members t
  JOIN chat_members m ON m.chat_id = t.chat_id AND m.user_id = t.user_id
  WHERE t.chat_id = ? AND t.slug = ?
  ORDER BY m.first_seen ASC
`);

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

const SLUG_MAX_LEN = 32;
const SLUG_REGEX = /^[a-zA-Z0-9_]+$/;
const TEAM_BUTTON_NAME_MAX = 28;

function displayName(u) {
  const full =
    [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  if (full) return full;
  if (u.username) return `@${u.username}`;
  return `id:${u.user_id}`;
}

function shortNameForButton(u) {
  const name = displayName(u);
  if (name.length <= TEAM_BUTTON_NAME_MAX) return name;
  return name.slice(0, TEAM_BUTTON_NAME_MAX - 1) + "…";
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

// -------------------- Teams: newteam, manage --------------------
bot.command("newteam", async (ctx) => {
  if (!isGroupChat(ctx)) return ctx.reply("Команда только для групп.");
  const ok = await isAdmin(ctx, ctx.from.id);
  if (!ok) return ctx.reply("⛔️ Только админы могут создавать команды.");
  const slug = ctx.message?.text?.split(/\s+/)[1]?.trim();
  if (!slug || slug.length > SLUG_MAX_LEN || !SLUG_REGEX.test(slug)) {
    return ctx.reply("Использование: /newteam <имя> — только латиница, цифры и _ (до 32 символов).");
  }
  const chatId = String(ctx.chat.id);
  if (getTeamStmt.get(chatId, slug)) {
    return ctx.reply(`Команда /${slug} уже есть.`);
  }
  insertTeamStmt.run(chatId, slug);
  return ctx.reply(`Команда /${slug} создана. Добавь участников: /manage ${slug}`);
});

function getTeamMemberCount(chatId, slug) {
  return teamMemberCountStmt.get(String(chatId), slug)?.n ?? 0;
}

function buildManageMainKeyboard(slug) {
  return {
    inline_keyboard: [
      [
        { text: "Добавить участников", callback_data: `t_add:${slug}:0` },
        { text: "Убрать участников", callback_data: `t_rem:${slug}:0` }
      ],
      [{ text: "Готово", callback_data: `t_done:${slug}` }]
    ]
  };
}

const TEAM_ADD_PAGE_SIZE = 8;
const TEAM_REM_PAGE_SIZE = 8;

bot.command("manage", async (ctx) => {
  if (!isGroupChat(ctx)) return ctx.reply("Команда только для групп.");
  const ok = await isAdmin(ctx, ctx.from.id);
  if (!ok) return ctx.reply("⛔️ Только админы могут настраивать команды.");
  const slug = ctx.message?.text?.split(/\s+/)[1]?.trim();
  if (!slug) return ctx.reply("Использование: /manage <имя команды>");
  const chatId = String(ctx.chat.id);
  if (!getTeamStmt.get(chatId, slug)) {
    return ctx.reply("Команды с таким именем нет.");
  }
  const n = getTeamMemberCount(chatId, slug);
  await ctx.reply(`Команда /${slug}. Участников: ${n}`, buildManageMainKeyboard(slug));
});

async function editToManageMain(ctx, chatId, slug) {
  const n = getTeamMemberCount(chatId, slug);
  await ctx.editMessageText(`Команда /${slug}. Участников: ${n}`, buildManageMainKeyboard(slug)).catch(() => {});
}

bot.action(/^t_done:(.+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const chatId = ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery("Ошибка");
  const isAdminUser = await isAdmin(ctx, ctx.from.id);
  if (!isAdminUser) return ctx.answerCbQuery("Только админы.");
  await ctx.answerCbQuery();
  const n = getTeamMemberCount(String(chatId), slug);
  await ctx.editMessageText(`Готово. /${slug} — ${n} участников`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
});

bot.action(/^t_add:([^:]+):(\d+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const page = parseInt(ctx.match[2], 10) || 0;
  const chatId = ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery("Ошибка");
  const isAdminUser = await isAdmin(ctx, ctx.from.id);
  if (!isAdminUser) return ctx.answerCbQuery("Только админы.");
  const cid = String(chatId);
  const candidates = selectChatMembersNotInTeamStmt.all(cid, cid, slug);
  const totalPages = Math.max(1, Math.ceil(candidates.length / TEAM_ADD_PAGE_SIZE));
  const p = Math.min(page, totalPages - 1);
  const start = p * TEAM_ADD_PAGE_SIZE;
  const pageCandidates = candidates.slice(start, start + TEAM_ADD_PAGE_SIZE);
  const rows = [];
  for (const u of pageCandidates) {
    rows.push([{ text: "+ " + shortNameForButton(u), callback_data: `t_add_one:${slug}:${u.user_id}` }]);
  }
  const nav = [];
  if (totalPages > 1) {
    if (p > 0) nav.push({ text: "◀ Назад", callback_data: `t_add:${slug}:${p - 1}` });
    nav.push({ text: `Стр. ${p + 1}/${totalPages}`, callback_data: `t_add:${slug}:${p}` });
    if (p < totalPages - 1) nav.push({ text: "Вперёд ▶", callback_data: `t_add:${slug}:${p + 1}` });
  }
  rows.push(nav.length ? nav : [{ text: "← К меню", callback_data: `t_back:${slug}` }]);
  if (nav.length) rows.push([{ text: "← К меню", callback_data: `t_back:${slug}` }]);
  const text = candidates.length
    ? `Команда /${slug}. Добавить (стр. ${p + 1}):`
    : `Команда /${slug}. Нет участников чата для добавления.`;
  await ctx.answerCbQuery();
  await ctx.editMessageText(text, { reply_markup: { inline_keyboard: rows } }).catch(() => {});
});

bot.action(/^t_back:([^:]+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const chatId = ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery();
  await editToManageMain(ctx, String(chatId), slug);
});

bot.action(/^t_add_one:([^:]+):(\d+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const userId = parseInt(ctx.match[2], 10);
  const chatId = ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery("Ошибка");
  const isAdminUser = await isAdmin(ctx, ctx.from.id);
  if (!isAdminUser) return ctx.answerCbQuery("Только админы.");
  const cid = String(chatId);
  try {
    insertTeamMemberStmt.run(cid, slug, userId);
  } catch (e) {
    // already in team
  }
  await ctx.answerCbQuery("Добавлен");
  const candidates = selectChatMembersNotInTeamStmt.all(cid, cid, slug);
  const totalPages = Math.max(1, Math.ceil(candidates.length / TEAM_ADD_PAGE_SIZE));
  const p = 0;
  const start = 0;
  const pageCandidates = candidates.slice(start, start + TEAM_ADD_PAGE_SIZE);
  const rows = [];
  for (const u of pageCandidates) {
    rows.push([{ text: "+ " + shortNameForButton(u), callback_data: `t_add_one:${slug}:${u.user_id}` }]);
  }
  const nav = [];
  if (totalPages > 1) {
    nav.push({ text: "Вперёд ▶", callback_data: `t_add:${slug}:1` });
  }
  rows.push([{ text: "← К меню", callback_data: `t_back:${slug}` }]);
  if (nav.length) rows.push(nav);
  const n = getTeamMemberCount(cid, slug);
  const text = candidates.length
    ? `Команда /${slug}. Участников: ${n}. Добавить (стр. 1):`
    : `Команда /${slug}. Участников: ${n}. Нет ещё кого добавить.`;
  await ctx.editMessageText(text, { reply_markup: { inline_keyboard: rows } }).catch(() => {});
});

bot.action(/^t_rem:([^:]+):(\d+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const page = parseInt(ctx.match[2], 10) || 0;
  const chatId = ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery("Ошибка");
  const isAdminUser = await isAdmin(ctx, ctx.from.id);
  if (!isAdminUser) return ctx.answerCbQuery("Только админы.");
  const cid = String(chatId);
  const members = selectTeamMembersForRemovalStmt.all(cid, slug);
  const totalPages = Math.max(1, Math.ceil(members.length / TEAM_REM_PAGE_SIZE));
  const p = Math.min(page, totalPages - 1);
  const start = p * TEAM_REM_PAGE_SIZE;
  const pageMembers = members.slice(start, start + TEAM_REM_PAGE_SIZE);
  const rows = [];
  for (const u of pageMembers) {
    rows.push([{ text: "− " + shortNameForButton(u), callback_data: `t_rem_one:${slug}:${u.user_id}` }]);
  }
  const nav = [];
  if (totalPages > 1) {
    if (p > 0) nav.push({ text: "◀ Назад", callback_data: `t_rem:${slug}:${p - 1}` });
    nav.push({ text: `Стр. ${p + 1}/${totalPages}`, callback_data: `t_rem:${slug}:${p}` });
    if (p < totalPages - 1) nav.push({ text: "Вперёд ▶", callback_data: `t_rem:${slug}:${p + 1}` });
  }
  rows.push(nav.length ? nav : [{ text: "← К меню", callback_data: `t_back:${slug}` }]);
  if (nav.length) rows.push([{ text: "← К меню", callback_data: `t_back:${slug}` }]);
  const text = members.length
    ? `Команда /${slug}. Убрать (стр. ${p + 1}):`
    : `Команда /${slug}. В команде никого.`;
  await ctx.answerCbQuery();
  await ctx.editMessageText(text, { reply_markup: { inline_keyboard: rows } }).catch(() => {});
});

bot.action(/^t_rem_one:([^:]+):(\d+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const userId = parseInt(ctx.match[2], 10);
  const chatId = ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery("Ошибка");
  const isAdminUser = await isAdmin(ctx, ctx.from.id);
  if (!isAdminUser) return ctx.answerCbQuery("Только админы.");
  const cid = String(chatId);
  deleteTeamMemberStmt.run(cid, slug, userId);
  await ctx.answerCbQuery("Убран");
  const members = selectTeamMembersForRemovalStmt.all(cid, slug);
  const totalPages = Math.max(1, Math.ceil(members.length / TEAM_REM_PAGE_SIZE));
  const p = 0;
  const start = 0;
  const pageMembers = members.slice(start, start + TEAM_REM_PAGE_SIZE);
  const rows = [];
  for (const u of pageMembers) {
    rows.push([{ text: "− " + shortNameForButton(u), callback_data: `t_rem_one:${slug}:${u.user_id}` }]);
  }
  const nav = [];
  if (totalPages > 1) {
    nav.push({ text: "Вперёд ▶", callback_data: `t_rem:${slug}:1` });
  }
  rows.push([{ text: "← К меню", callback_data: `t_back:${slug}` }]);
  if (nav.length) rows.push(nav);
  const n = getTeamMemberCount(cid, slug);
  const text = members.length
    ? `Команда /${slug}. Участников: ${n}. Убрать (стр. 1):`
    : `Команда /${slug}. Участников: ${n}.`;
  await ctx.editMessageText(text, { reply_markup: { inline_keyboard: rows } }).catch(() => {});
});

async function sendMentionChunks(ctx, chatId, targetMessageId, members) {
  const chunks = [];
  for (let i = 0; i < members.length; i += CHUNK) {
    chunks.push(members.slice(i, i + CHUNK));
  }
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
        await sleep((retryAfter + 1) * 1000);
        i--;
        continue;
      }
      throw e;
    }
    if (i < chunks.length - 1) await sleep(DELAY_MS);
  }
}

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

    const targetMessageId = replied.message_id;
    setCooldown(chatId);
    console.log(`tagall chat=${chatId} members=${members.length} chunks=${Math.ceil(members.length / CHUNK)}`);
    await sendMentionChunks(ctx, chatId, targetMessageId, members);
  } catch (e) {
    console.error("tagall error:", e?.stack || e);
    return ctx.reply("❌ Ошибка при выполнении /tagall. Посмотри логи бота.");
  }
});

// Custom team commands (e.g. /tagbar) — must run after other commands
bot.on("message", async (ctx, next) => {
  const text = ctx.message?.text;
  if (!text || !text.startsWith("/")) return next();
  const m = text.match(/^\/(\w+)(@\w+)?\s*$/);
  if (!m) return next();
  const cmd = m[1];
  const known = ["tagall", "start", "admin", "ping", "newteam", "manage", "teams"];
  if (known.includes(cmd.toLowerCase())) return next();
  if (!isGroupChat(ctx)) return next();
  const chatId = String(ctx.chat.id);
  if (!getTeamStmt.get(chatId, cmd)) return next();

  try {
    const replied = ctx.message?.reply_to_message;
    if (!replied) {
      await ctx.reply(`Ответь (reply) на сообщение и напиши /${cmd}`);
      return;
    }
    const onlyAdmins = getTagallOnlyAdmins(chatId);
    if (onlyAdmins) {
      const ok = await isAdmin(ctx, ctx.from.id);
      if (!ok) {
        await ctx.reply("⛔️ Команда доступна только админам группы.");
        return;
      }
    }
    const waitSec = checkCooldown(chatId);
    if (waitSec != null) {
      await ctx.reply(`Подожди ещё ${waitSec} сек. перед следующим тегом.`);
      return;
    }
    const members = selectTeamMembersStmt.all(chatId, cmd);
    if (!members.length) {
      await ctx.reply(`В команде /${cmd} пока никого. Добавь участников: /manage ${cmd}`);
      return;
    }
    setCooldown(chatId);
    await sendMentionChunks(ctx, ctx.chat.id, replied.message_id, members);
  } catch (e) {
    console.error(`team tag /${cmd} error:`, e?.stack || e);
    await ctx.reply("❌ Ошибка. Посмотри логи бота.").catch(() => {});
  }
});

bot.command("teams", async (ctx) => {
  if (!isGroupChat(ctx)) return ctx.reply("Команда только для групп.");
  const chatId = String(ctx.chat.id);
  const teams = listTeamsStmt.all(chatId);
  if (!teams.length) {
    return ctx.reply("В этой группе пока нет команд. Создай: /newteam <имя>");
  }
  const list = teams.map((t) => `/${t.slug}`).join(", ");
  await ctx.reply(`Команды: ${list}\nНастройка: /manage <имя>`);
});

async function syncAdminsForAllChats() {
  const rows = distinctChatIdsStmt.all();
  for (const row of rows) {
    const chatId = row.chat_id;
    try {
      const admins = await bot.telegram.getChatAdministrators(chatId);
      for (const a of admins) {
        if (a.user) storeUser(chatId, a.user);
      }
    } catch (e) {
      // Bot may have been removed from chat
      if (e?.response?.error_code !== 403 && e?.response?.error_code !== 400) {
        console.warn(`syncAdmins chat=${chatId}:`, e?.message || e);
      }
    }
  }
}

// -------------------- Launch --------------------
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

bot.launch()
  .then(async () => {
    console.log("✅ Bot started");
    await syncAdminsForAllChats();
    setInterval(syncAdminsForAllChats, ONE_DAY_MS);
  })
  .catch((e) => {
    console.error("❌ Failed to launch bot:", e);
    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
