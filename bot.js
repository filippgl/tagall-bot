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
const distinctChatIdsFromTeamsStmt = db.prepare(`SELECT DISTINCT chat_id FROM chat_teams`);
const insertTeamStmt = db.prepare(`INSERT INTO chat_teams (chat_id, slug) VALUES (?, ?)`);
const getTeamStmt = db.prepare(`SELECT 1 FROM chat_teams WHERE chat_id = ? AND slug = ?`);
const getTeamSlugCaseInsensitiveStmt = db.prepare(`
  SELECT slug FROM chat_teams WHERE chat_id = ? AND LOWER(slug) = LOWER(?) LIMIT 1
`);
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
const updateTeamSlugStmt = db.prepare(`
  UPDATE chat_teams SET slug = ? WHERE chat_id = ? AND slug = ?
`);
const updateTeamMembersSlugStmt = db.prepare(`
  UPDATE chat_team_members SET slug = ? WHERE chat_id = ? AND slug = ?
`);
const deleteTeamAllMembersStmt = db.prepare(`
  DELETE FROM chat_team_members WHERE chat_id = ? AND slug = ?
`);
const deleteTeamStmt = db.prepare(`
  DELETE FROM chat_teams WHERE chat_id = ? AND slug = ?
`);

// Admin menu: state for text input (create team name, rename team)
const adminInputState = new Map(); // userId -> { chatId, step: 'new_team_slug' | 'rename_team', slug? }

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

function normalizeTeamSlugInput(input = "") {
  let s = String(input).trim();
  // принимаем "bar" и "/bar"
  s = s.replace(/^\/+/, "");
  // на всякий случай, если вставили "/bar@MyBot"
  s = s.replace(/@[\w_]+$/i, "");
  return s;
}


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

const TEAM_BUTTON_WITH_USERNAME_MAX = 48;

function shortNameWithUsername(u) {
  const name = displayName(u);
  const withUsername = u.username ? `${name} (@${u.username})` : name;
  if (withUsername.length <= TEAM_BUTTON_WITH_USERNAME_MAX) return withUsername;
  return withUsername.slice(0, TEAM_BUTTON_WITH_USERNAME_MAX - 1) + "…";
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

async function isAdminInChat(ctx, chatId, userId) {
  try {
    const member = await ctx.telegram.getChatMember(chatId, userId);
    return member?.status === "administrator" || member?.status === "creator";
  } catch (e) {
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
  const state = adminInputState.get(ctx.from.id);
  if (state && (state.step === "new_team_slug" || state.step === "rename_team") && ctx.message?.text) {
    const raw = ctx.message.text.trim();
const text = normalizeTeamSlugInput(raw);
    const cid = state.chatId;
    const isPrivate = ctx.chat.type === "private";
    if (state.step === "new_team_slug") {
      if (!text || text.length > SLUG_MAX_LEN || !SLUG_REGEX.test(text)) {
        await ctx.reply("Неверный формат. Только латиница, цифры и _ до 32 символов.");
        return;
      }
      if (getTeamStmt.get(cid, text)) {
        await ctx.reply(`Команда /${text} уже есть.`);
        return;
      }
      insertTeamStmt.run(cid, text);
      adminInputState.delete(ctx.from.id);
      if (state.msgChatId != null && state.msgId != null) {
        const kbd = {
          inline_keyboard: [
            [{ text: "Настроить", callback_data: CB.team(isPrivate ? cid : null, text) }],
            [{ text: "← К списку команд", callback_data: isPrivate ? CB.teams(cid) : CB.teams(null) }]
          ]
        };
        await ctx.telegram.editMessageText(state.msgChatId, state.msgId, null, `Команда /${text} создана.`, { reply_markup: kbd }).catch(() => {});
      } else {
        await ctx.reply(`Команда /${text} создана. Настрой через /admin.`);
      }
      return;
    }
    if (state.step === "rename_team") {
      const oldSlug = state.slug;
      if (!text || text.length > SLUG_MAX_LEN || !SLUG_REGEX.test(text)) {
        await ctx.reply("Неверный формат. Только латиница, цифры и _ до 32 символов.");
        return;
      }
      if (text === oldSlug) {
        adminInputState.delete(ctx.from.id);
        if (state.msgChatId != null && state.msgId != null) {
          const n = getTeamMemberCount(cid, oldSlug);
          await ctx.telegram.editMessageText(state.msgChatId, state.msgId, null, `Команда /${oldSlug}. Участников: ${n}`, { reply_markup: buildTeamScreenKeyboard(isPrivate, isPrivate ? cid : null, oldSlug) }).catch(() => {});
        }
        return;
      }
      if (getTeamStmt.get(cid, text)) {
        await ctx.reply(`Команда /${text} уже есть.`);
        return;
      }
      updateTeamSlugStmt.run(text, cid, oldSlug);
      updateTeamMembersSlugStmt.run(text, cid, oldSlug);
      adminInputState.delete(ctx.from.id);
      if (state.msgChatId != null && state.msgId != null) {
        const n = getTeamMemberCount(cid, text);
        await ctx.telegram.editMessageText(state.msgChatId, state.msgId, null, `Команда /${text}. Участников: ${n}`, { reply_markup: buildTeamScreenKeyboard(isPrivate, isPrivate ? cid : null, text) }).catch(() => {});
      } else {
        await ctx.reply(`Переименовано в /${text}.`);
      }
      return;
    }
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

bot.on("message", async (ctx, next) => {
  if (!isGroupChat(ctx)) return next();
  const text = ctx.message?.text || ctx.message?.caption;
  if (!text) return next();
  const chatId = String(ctx.chat.id);
  const commandInfo = parseTagCommand(text, chatId);
  if (!commandInfo) return next();
  const targetMessageId = getTargetMessageId(ctx, commandInfo);
  if (!targetMessageId) {
    await ctx.reply(
      "Ответь (reply) на важное сообщение или добавь текст/фото/видео к команде — бот ответит на нужное сообщение."
    );
    return;
  }
  try {
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
    if (commandInfo.type === "tagall") {
      const members = selectMembersStmt.all(chatId, MAX_USERS);
      if (!members.length) {
        await ctx.reply("Пока некого упоминать: я ещё не собрал базу участников.");
        return;
      }
      setCooldown(chatId);
      console.log(`tagall chat=${chatId} members=${members.length} chunks=${Math.ceil(members.length / CHUNK)}`);
      await sendMentionChunks(ctx, chatId, targetMessageId, members, null);
    } else {
      const slug = commandInfo.slug;
      const members = selectTeamMembersStmt.all(chatId, slug);
      if (!members.length) {
        await ctx.reply(`В команде /${slug} пока никого. Добавь участников через /admin → Подгруппы.`);
        return;
      }
      setCooldown(chatId);
      await sendMentionChunks(ctx, chatId, targetMessageId, members, slug);
    }
  } catch (e) {
    const slug = commandInfo.type === "team" ? commandInfo.slug : "tagall";
    console.error(`tag error /${slug}:`, e?.stack || e);
    await ctx.reply("❌ Ошибка. Посмотри логи бота.").catch(() => {});
  }
});

// -------------------- Commands --------------------
bot.start(async (ctx) => {
  await ctx.reply(
    "Привет! Я бот для массовых упоминаний в группах.\n\n" +
    "Как начать:\n" +
    "1) Добавь меня в нужную группу и дай права администратора.\n" +
    "2) Попроси участников написать в чат хотя бы 1 сообщение — только после этого я смогу их «увидеть» и добавить в базу.\n\n" +
    "Основная команда:\n" +
    "• /tagall — можно ответить (Reply) на сообщение или написать /tagall вместе с текстом/фото/видео. Я отвечу на нужное сообщение и упомяну участников пачками (по 20 в сообщении).\n\n" +
    "Лимиты и защита:\n" +
    "• максимум 100 упоминаний за один запуск\n" +
    "• небольшая задержка между пачками\n" +
    "• кулдаун между запусками, чтобы не спамили\n\n" +
    "Подгруппы (команды):\n" +
    "Админ может создать команду (например /friends) и добавить туда людей. Потом можно тегать только их: Reply на сообщение или текст/фото/видео + /friends.\n\n" +
    "Настройки и управление:\n" +
    "• /admin — меню админа (кто может тегать, подгруппы и т.д.)\n" +
    "• /help — подсказки по командам"
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

// -------------------- Unified /admin menu --------------------
const CB = {
  list: "adm_list",
  grp: (cid) => `adm_grp:${cid}`,
  menu: (cid) => (cid == null ? "adm_menu" : `adm_menu:${cid}`),
  tag: (cid) => (cid == null ? "adm_tag" : `adm_tag:${cid}`),
  teams: (cid) => (cid == null ? "adm_teams" : `adm_teams:${cid}`),
  team: (cid, slug) => (cid == null ? `adm_team:${slug}` : `adm_team:${cid}:${slug}`),
  add: (cid, slug, page) => (cid == null ? `adm_add:${slug}:${page}` : `adm_add:${cid}:${slug}:${page}`),
  rem: (cid, slug, page) => (cid == null ? `adm_rem:${slug}:${page}` : `adm_rem:${cid}:${slug}:${page}`),
  add1: (cid, slug, uid) => (cid == null ? `adm_a1:${slug}:${uid}` : `adm_a1:${cid}:${slug}:${uid}`),
  rem1: (cid, slug, uid) => (cid == null ? `adm_r1:${slug}:${uid}` : `adm_r1:${cid}:${slug}:${uid}`),
  back: (cid, slug) => (cid == null ? `adm_back:${slug}` : `adm_back:${cid}:${slug}`),
  rename: (cid, slug) => (cid == null ? `adm_ren:${slug}` : `adm_ren:${cid}:${slug}`),
  del: (cid, slug) => (cid == null ? `adm_del:${slug}` : `adm_del:${cid}:${slug}`),
  delOk: (cid, slug) => (cid == null ? `adm_delok:${slug}` : `adm_delok:${cid}:${slug}`),
  newteam: (cid) => (cid == null ? "adm_new" : `adm_new:${cid}`),
  who: (cid, w) => (cid == null ? `adm_who:${w}` : `adm_who:${cid}:${w}`),
  cancelNew: (cid) => (cid == null ? "adm_cn" : `adm_cn:${cid}`),
  cancelRen: (cid, slug) => (cid == null ? `adm_cr:${slug}` : `adm_cr:${cid}:${slug}`),
  delNo: (cid, slug) => (cid == null ? `adm_delno:${slug}` : `adm_delno:${cid}:${slug}`)
};

function buildMainMenuKeyboard(isPrivate, chatId) {
  const cid = isPrivate ? String(chatId) : null;
  const rows = [
    [{ text: "Кто может тегать", callback_data: CB.tag(cid) }],
    [{ text: "Подгруппы (команды)", callback_data: CB.teams(cid) }]
  ];
  if (isPrivate) rows.push([{ text: "← К списку групп", callback_data: CB.list }]);
  else rows.push([{ text: "Закрыть", callback_data: "adm_close" }]);
  return { inline_keyboard: rows };
}

function buildWhoKeyboard(isPrivate, chatId) {
  const cid = isPrivate ? String(chatId) : null;
  const onlyAdmins = getTagallOnlyAdmins(chatId);
  return {
    inline_keyboard: [
      [
        { text: onlyAdmins ? "✓ Только админы" : "Только админы", callback_data: CB.who(cid, "admins") },
        { text: !onlyAdmins ? "✓ Все участники" : "Все участники", callback_data: CB.who(cid, "all") }
      ],
      [{ text: "← Назад", callback_data: CB.menu(cid) }]
    ]
  };
}

function buildTeamScreenKeyboard(isPrivate, chatId, slug) {
  const cid = isPrivate ? String(chatId) : null;
  return {
    inline_keyboard: [
      [
        { text: "➕ Добавить", callback_data: CB.add(cid, slug, 0) },
        { text: "➖ Убрать", callback_data: CB.rem(cid, slug, 0) }
      ],
      [
        { text: "✏️ Переименовать", callback_data: CB.rename(cid, slug) },
        { text: "🗑 Удалить", callback_data: CB.del(cid, slug) }
      ],
      [{ text: "← К списку команд", callback_data: CB.teams(cid) }]
    ]
  };
}

async function getChatTitleSafe(ctx, chatId) {
  try {
    const chat = await ctx.telegram.getChat(chatId);
    return chat?.title || `Группа ${chatId}`;
  } catch (e) {
    return `Группа ${chatId}`;
  }
}

bot.command("admin", async (ctx) => {
  if (ctx.chat.type === "private") {
    const fromMembers = distinctChatIdsStmt.all().map((r) => r.chat_id);
    const fromTeams = distinctChatIdsFromTeamsStmt.all().map((r) => r.chat_id);
    const allChatIds = [...new Set([...fromMembers, ...fromTeams])];
    const allowed = [];
    for (const cid of allChatIds) {
      const ok = await isAdminInChat(ctx, cid, ctx.from.id);
      if (ok) allowed.push({ chatId: cid, title: await getChatTitleSafe(ctx, cid) });
    }
    if (!allowed.length) return ctx.reply("Нет групп, где ты админ и добавлен бот.");
    const keyboard = {
      inline_keyboard: allowed.map((g) => [{ text: g.title, callback_data: CB.grp(g.chatId) }])
    };
    return ctx.reply("Выбери группу:", { reply_markup: keyboard });
  }
  if (!isGroupChat(ctx)) return ctx.reply("Команда только для групп.");
  const ok = await isAdmin(ctx, ctx.from.id);
  if (!ok) return ctx.reply("⛔️ Только админы группы могут менять настройки.");
  await ctx.reply("Настройки группы", { reply_markup: buildMainMenuKeyboard(false, null) });
});

bot.action(/^adm_list$/, async (ctx) => {
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  const fromMembers = distinctChatIdsStmt.all().map((r) => r.chat_id);
  const fromTeams = distinctChatIdsFromTeamsStmt.all().map((r) => r.chat_id);
  const allChatIds = [...new Set([...fromMembers, ...fromTeams])];
  const allowed = [];
  for (const cid of allChatIds) {
    const ok = await isAdminInChat(ctx, cid, ctx.from.id);
    if (ok) allowed.push({ chatId: cid, title: await getChatTitleSafe(ctx, cid) });
  }
  const keyboard = {
    inline_keyboard: allowed.map((g) => [{ text: g.title, callback_data: CB.grp(g.chatId) }])
  };
  await ctx.answerCbQuery();
  await ctx.editMessageText("Выбери группу:", { reply_markup: keyboard }).catch(() => {});
});

bot.action(/^adm_grp:(-?\d+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  const ok = await isAdminInChat(ctx, chatId, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Нет прав в этой группе.");
  const title = await getChatTitleSafe(ctx, chatId);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Настройки: ${title}`, { reply_markup: buildMainMenuKeyboard(true, chatId) }).catch(() => {});
});

bot.action(/^adm_menu$/, async (ctx) => {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await ctx.editMessageText("Настройки группы", { reply_markup: buildMainMenuKeyboard(false, null) }).catch(() => {});
});

bot.action(/^adm_menu:(.+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  const ok = await isAdminInChat(ctx, chatId, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Нет прав.");
  const title = await getChatTitleSafe(ctx, chatId);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Настройки: ${title}`, { reply_markup: buildMainMenuKeyboard(true, chatId) }).catch(() => {});
});

bot.action(/^adm_close$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
});

bot.action(/^adm_tag$/, async (ctx) => {
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery("Ошибка");
  const ok = await isAdmin(ctx, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Только админы.");
  await ctx.answerCbQuery();
  await ctx.editMessageText("Кто может использовать /tagall и команды?", { reply_markup: buildWhoKeyboard(false, chatId) }).catch(() => {});
});

bot.action(/^adm_tag:(.+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  const ok = await isAdminInChat(ctx, chatId, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Нет прав.");
  await ctx.answerCbQuery();
  await ctx.editMessageText("Кто может использовать /tagall и команды?", { reply_markup: buildWhoKeyboard(true, chatId) }).catch(() => {});
});

bot.action(/^adm_who:(admins|all)$/, async (ctx) => {
  const who = ctx.match[1];
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery("Ошибка");
  const ok = await isAdmin(ctx, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Только админы.");
  setTagallOnlyAdminsStmt.run(String(chatId), who === "admins" ? 1 : 0);
  await ctx.answerCbQuery();
  await ctx.editMessageText("Настройки группы", { reply_markup: buildMainMenuKeyboard(false, null) }).catch(() => {});
});

bot.action(/^adm_who:(.+):(admins|all)$/, async (ctx) => {
  const chatId = ctx.match[1];
  const who = ctx.match[2];
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  const ok = await isAdminInChat(ctx, chatId, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Нет прав.");
  setTagallOnlyAdminsStmt.run(String(chatId), who === "admins" ? 1 : 0);
  await ctx.answerCbQuery();
  const title = await getChatTitleSafe(ctx, chatId);
  await ctx.editMessageText(`Настройки: ${title}`, { reply_markup: buildMainMenuKeyboard(true, chatId) }).catch(() => {});
});

bot.action(/^adm_teams$/, async (ctx) => {
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery();
  const ok = await isAdmin(ctx, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Только админы.");
  const cid = String(chatId);
  const teams = listTeamsStmt.all(cid);
  const rows = teams.map((t) => {
    const n = getTeamMemberCount(cid, t.slug);
    return [{ text: `/${t.slug} (${n})`, callback_data: CB.team(null, t.slug) }];
  });
  rows.push([{ text: "➕ Создать команду", callback_data: CB.newteam(null) }]);
  rows.push([{ text: "← Назад", callback_data: CB.menu(null) }]);
  await ctx.answerCbQuery();
  await ctx.editMessageText("Подгруппы (команды):", { reply_markup: { inline_keyboard: rows } }).catch(() => {});
});

bot.action(/^adm_teams:(.+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  const ok = await isAdminInChat(ctx, chatId, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Нет прав.");
  const cid = String(chatId);
  const teams = listTeamsStmt.all(cid);
  const rows = teams.map((t) => {
    const n = getTeamMemberCount(cid, t.slug);
    return [{ text: `/${t.slug} (${n})`, callback_data: CB.team(chatId, t.slug) }];
  });
  rows.push([{ text: "➕ Создать команду", callback_data: CB.newteam(chatId) }]);
  rows.push([{ text: "← Назад", callback_data: CB.menu(chatId) }]);
  await ctx.answerCbQuery();
  const title = await getChatTitleSafe(ctx, chatId);
  await ctx.editMessageText(`${title}\nПодгруппы (команды):`, { reply_markup: { inline_keyboard: rows } }).catch(() => {});
});

bot.action(/^adm_team:([^:]+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery();
  const ok = await isAdmin(ctx, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Только админы.");
  const cid = String(chatId);
  if (!getTeamStmt.get(cid, slug)) return ctx.answerCbQuery("Команда не найдена.");
  const n = getTeamMemberCount(cid, slug);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Команда /${slug}. Участников: ${n}`, { reply_markup: buildTeamScreenKeyboard(false, null, slug) }).catch(() => {});
});

bot.action(/^adm_team:(.+):([^:]+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  const slug = ctx.match[2];
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  const ok = await isAdminInChat(ctx, chatId, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Нет прав.");
  const cid = String(chatId);
  if (!getTeamStmt.get(cid, slug)) return ctx.answerCbQuery("Команда не найдена.");
  const n = getTeamMemberCount(cid, slug);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Команда /${slug}. Участников: ${n}`, { reply_markup: buildTeamScreenKeyboard(true, chatId, slug) }).catch(() => {});
});

function buildAddPageKeyboard(cid, slug, page, isPrivate) {
  const candidates = selectChatMembersNotInTeamStmt.all(cid, cid, slug);
  const totalPages = Math.max(1, Math.ceil(candidates.length / TEAM_ADD_PAGE_SIZE));
  const p = Math.min(page, totalPages - 1);
  const start = p * TEAM_ADD_PAGE_SIZE;
  const pageCandidates = candidates.slice(start, start + TEAM_ADD_PAGE_SIZE);
  const rows = pageCandidates.map((u) => [{ text: "+ " + shortNameWithUsername(u), callback_data: CB.add1(isPrivate ? cid : null, slug, u.user_id) }]);
  const nav = [];
  if (totalPages > 1) {
    if (p > 0) nav.push({ text: "◀", callback_data: CB.add(isPrivate ? cid : null, slug, p - 1) });
    nav.push({ text: `${p + 1}/${totalPages}`, callback_data: CB.add(isPrivate ? cid : null, slug, p) });
    if (p < totalPages - 1) nav.push({ text: "▶", callback_data: CB.add(isPrivate ? cid : null, slug, p + 1) });
  }
  rows.push(nav.length ? nav : []);
  rows.push([{ text: "← Назад", callback_data: CB.back(isPrivate ? cid : null, slug) }]);
  return { rows, candidates, p, totalPages };
}

function buildRemPageKeyboard(cid, slug, page, isPrivate) {
  const members = selectTeamMembersForRemovalStmt.all(cid, slug);
  const totalPages = Math.max(1, Math.ceil(members.length / TEAM_REM_PAGE_SIZE));
  const p = Math.min(page, totalPages - 1);
  const start = p * TEAM_REM_PAGE_SIZE;
  const pageMembers = members.slice(start, start + TEAM_REM_PAGE_SIZE);
  const rows = pageMembers.map((u) => [{ text: "− " + shortNameWithUsername(u), callback_data: CB.rem1(isPrivate ? cid : null, slug, u.user_id) }]);
  const nav = [];
  if (totalPages > 1) {
    if (p > 0) nav.push({ text: "◀", callback_data: CB.rem(isPrivate ? cid : null, slug, p - 1) });
    nav.push({ text: `${p + 1}/${totalPages}`, callback_data: CB.rem(isPrivate ? cid : null, slug, p) });
    if (p < totalPages - 1) nav.push({ text: "▶", callback_data: CB.rem(isPrivate ? cid : null, slug, p + 1) });
  }
  rows.push(nav.length ? nav : []);
  rows.push([{ text: "← Назад", callback_data: CB.back(isPrivate ? cid : null, slug) }]);
  return { rows, members, p, totalPages };
}

bot.action(/^adm_add:([^:]+):(\d+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const page = parseInt(ctx.match[2], 10) || 0;
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery();
  const ok = await isAdmin(ctx, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Только админы.");
  const cid = String(chatId);
  const { rows, candidates, p, totalPages } = buildAddPageKeyboard(cid, slug, page, false);
  const text = candidates.length ? `Команда /${slug}. Добавить (стр. ${p + 1}/${totalPages}):` : `Команда /${slug}. Нет кого добавить.`;
  await ctx.answerCbQuery();
  await ctx.editMessageText(text, { reply_markup: { inline_keyboard: rows } }).catch(() => {});
});

bot.action(/^adm_add:(.+):([^:]+):(\d+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  const slug = ctx.match[2];
  const page = parseInt(ctx.match[3], 10) || 0;
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  const ok = await isAdminInChat(ctx, chatId, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Нет прав.");
  const cid = String(chatId);
  const { rows, candidates, p, totalPages } = buildAddPageKeyboard(cid, slug, page, true);
  const text = candidates.length ? `Команда /${slug}. Добавить (стр. ${p + 1}/${totalPages}):` : `Команда /${slug}. Нет кого добавить.`;
  await ctx.answerCbQuery();
  await ctx.editMessageText(text, { reply_markup: { inline_keyboard: rows } }).catch(() => {});
});

bot.action(/^adm_rem:([^:]+):(\d+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const page = parseInt(ctx.match[2], 10) || 0;
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery();
  const ok = await isAdmin(ctx, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Только админы.");
  const cid = String(chatId);
  const { rows, members, p, totalPages } = buildRemPageKeyboard(cid, slug, page, false);
  const text = members.length ? `Команда /${slug}. Убрать (стр. ${p + 1}/${totalPages}):` : `Команда /${slug}. В команде никого.`;
  await ctx.answerCbQuery();
  await ctx.editMessageText(text, { reply_markup: { inline_keyboard: rows } }).catch(() => {});
});

bot.action(/^adm_rem:(.+):([^:]+):(\d+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  const slug = ctx.match[2];
  const page = parseInt(ctx.match[3], 10) || 0;
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  const ok = await isAdminInChat(ctx, chatId, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Нет прав.");
  const cid = String(chatId);
  const { rows, members, p, totalPages } = buildRemPageKeyboard(cid, slug, page, true);
  const text = members.length ? `Команда /${slug}. Убрать (стр. ${p + 1}/${totalPages}):` : `Команда /${slug}. В команде никого.`;
  await ctx.answerCbQuery();
  await ctx.editMessageText(text, { reply_markup: { inline_keyboard: rows } }).catch(() => {});
});

bot.action(/^adm_a1:([^:]+):(\d+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const userId = parseInt(ctx.match[2], 10);
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery();
  const ok = await isAdmin(ctx, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Только админы.");
  const cid = String(chatId);
  try { insertTeamMemberStmt.run(cid, slug, userId); } catch (e) {}
  await ctx.answerCbQuery("Добавлен");
  const n = getTeamMemberCount(cid, slug);
  await ctx.editMessageText(`Команда /${slug}. Участников: ${n}`, { reply_markup: buildTeamScreenKeyboard(false, null, slug) }).catch(() => {});
});

bot.action(/^adm_a1:(.+):([^:]+):(\d+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  const slug = ctx.match[2];
  const userId = parseInt(ctx.match[3], 10);
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  const ok = await isAdminInChat(ctx, chatId, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Нет прав.");
  const cid = String(chatId);
  try { insertTeamMemberStmt.run(cid, slug, userId); } catch (e) {}
  await ctx.answerCbQuery("Добавлен");
  const n = getTeamMemberCount(cid, slug);
  await ctx.editMessageText(`Команда /${slug}. Участников: ${n}`, { reply_markup: buildTeamScreenKeyboard(true, chatId, slug) }).catch(() => {});
});

bot.action(/^adm_r1:([^:]+):(\d+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const userId = parseInt(ctx.match[2], 10);
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery();
  const ok = await isAdmin(ctx, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Только админы.");
  const cid = String(chatId);
  deleteTeamMemberStmt.run(cid, slug, userId);
  await ctx.answerCbQuery("Убран");
  const n = getTeamMemberCount(cid, slug);
  await ctx.editMessageText(`Команда /${slug}. Участников: ${n}`, { reply_markup: buildTeamScreenKeyboard(false, null, slug) }).catch(() => {});
});

bot.action(/^adm_r1:(.+):([^:]+):(\d+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  const slug = ctx.match[2];
  const userId = parseInt(ctx.match[3], 10);
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  const ok = await isAdminInChat(ctx, chatId, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Нет прав.");
  const cid = String(chatId);
  deleteTeamMemberStmt.run(cid, slug, userId);
  await ctx.answerCbQuery("Убран");
  const n = getTeamMemberCount(cid, slug);
  await ctx.editMessageText(`Команда /${slug}. Участников: ${n}`, { reply_markup: buildTeamScreenKeyboard(true, chatId, slug) }).catch(() => {});
});

bot.action(/^adm_back:([^:]+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery();
  const cid = String(chatId);
  const n = getTeamMemberCount(cid, slug);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Команда /${slug}. Участников: ${n}`, { reply_markup: buildTeamScreenKeyboard(false, null, slug) }).catch(() => {});
});

bot.action(/^adm_back:(.+):([^:]+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  const slug = ctx.match[2];
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  const ok = await isAdminInChat(ctx, chatId, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Нет прав.");
  const cid = String(chatId);
  const n = getTeamMemberCount(cid, slug);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Команда /${slug}. Участников: ${n}`, { reply_markup: buildTeamScreenKeyboard(true, chatId, slug) }).catch(() => {});
});

bot.action(/^adm_ren:([^:]+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery();
  const ok = await isAdmin(ctx, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Только админы.");
  const msg = ctx.callbackQuery.message;
  adminInputState.set(ctx.from.id, { chatId: String(chatId), step: "rename_team", slug, msgChatId: msg.chat.id, msgId: msg.message_id });
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Введи новое имя для /${slug} (латиница, цифры, _ до 32 символов):`, {
    reply_markup: { inline_keyboard: [[{ text: "Отмена", callback_data: CB.cancelRen(null, slug) }]] }
  }).catch(() => {});
});

bot.action(/^adm_ren:(.+):([^:]+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  const slug = ctx.match[2];
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  const ok = await isAdminInChat(ctx, chatId, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Нет прав.");
  const msg = ctx.callbackQuery.message;
  adminInputState.set(ctx.from.id, { chatId, step: "rename_team", slug, msgChatId: msg.chat.id, msgId: msg.message_id });
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Введи новое имя для /${slug} (латиница, цифры, _ до 32 символов):`, {
    reply_markup: { inline_keyboard: [[{ text: "Отмена", callback_data: CB.cancelRen(chatId, slug) }]] }
  }).catch(() => {});
});

bot.action(/^adm_del:([^:]+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery();
  const ok = await isAdmin(ctx, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Только админы.");
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Удалить /${slug}? Участники не удалятся из группы.`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Да, удалить", callback_data: CB.delOk(null, slug) }, { text: "Отмена", callback_data: CB.delNo(null, slug) }]
      ]
    }
  }).catch(() => {});
});

bot.action(/^adm_del:(.+):([^:]+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  const slug = ctx.match[2];
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  const ok = await isAdminInChat(ctx, chatId, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Нет прав.");
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Удалить /${slug}? Участники не удалятся из группы.`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Да, удалить", callback_data: CB.delOk(chatId, slug) }, { text: "Отмена", callback_data: CB.delNo(chatId, slug) }]
      ]
    }
  }).catch(() => {});
});

bot.action(/^adm_delok:([^:]+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery();
  const ok = await isAdmin(ctx, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Только админы.");
  const cid = String(chatId);
  deleteTeamAllMembersStmt.run(cid, slug);
  deleteTeamStmt.run(cid, slug);
  await ctx.answerCbQuery();
  const teams = listTeamsStmt.all(cid);
  const rows = teams.map((t) => {
    const n = getTeamMemberCount(cid, t.slug);
    return [{ text: `/${t.slug} (${n})`, callback_data: CB.team(null, t.slug) }];
  });
  rows.push([{ text: "➕ Создать команду", callback_data: CB.newteam(null) }]);
  rows.push([{ text: "← Назад", callback_data: CB.menu(null) }]);
  await ctx.editMessageText("Подгруппы (команды):", { reply_markup: { inline_keyboard: rows } }).catch(() => {});
});

bot.action(/^adm_delok:(.+):([^:]+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  const slug = ctx.match[2];
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  const ok = await isAdminInChat(ctx, chatId, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Нет прав.");
  const cid = String(chatId);
  deleteTeamAllMembersStmt.run(cid, slug);
  deleteTeamStmt.run(cid, slug);
  await ctx.answerCbQuery();
  const teams = listTeamsStmt.all(cid);
  const rows = teams.map((t) => {
    const n = getTeamMemberCount(cid, t.slug);
    return [{ text: `/${t.slug} (${n})`, callback_data: CB.team(chatId, t.slug) }];
  });
  rows.push([{ text: "➕ Создать команду", callback_data: CB.newteam(chatId) }]);
  rows.push([{ text: "← Назад", callback_data: CB.menu(chatId) }]);
  const title = await getChatTitleSafe(ctx, chatId);
  await ctx.editMessageText(`${title}\nПодгруппы (команды):`, { reply_markup: { inline_keyboard: rows } }).catch(() => {});
});

bot.action(/^adm_delno:([^:]+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery();
  const cid = String(chatId);
  const n = getTeamMemberCount(cid, slug);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Команда /${slug}. Участников: ${n}`, { reply_markup: buildTeamScreenKeyboard(false, null, slug) }).catch(() => {});
});

bot.action(/^adm_delno:(.+):([^:]+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  const slug = ctx.match[2];
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  const cid = String(chatId);
  const n = getTeamMemberCount(cid, slug);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Команда /${slug}. Участников: ${n}`, { reply_markup: buildTeamScreenKeyboard(true, chatId, slug) }).catch(() => {});
});

bot.action(/^adm_new$/, async (ctx) => {
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery();
  const ok = await isAdmin(ctx, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Только админы.");
  const msg = ctx.callbackQuery.message;
  adminInputState.set(ctx.from.id, { chatId: String(chatId), step: "new_team_slug", msgChatId: msg.chat.id, msgId: msg.message_id });
  await ctx.answerCbQuery();
  await ctx.editMessageText("Введи имя команды (латиница, цифры, _ до 32 символов). Например: tagbar", {
    reply_markup: { inline_keyboard: [[{ text: "Отмена", callback_data: CB.cancelNew(null) }]] }
  }).catch(() => {});
});

bot.action(/^adm_new:(.+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  const ok = await isAdminInChat(ctx, chatId, ctx.from.id);
  if (!ok) return ctx.answerCbQuery("Нет прав.");
  const msg = ctx.callbackQuery.message;
  adminInputState.set(ctx.from.id, { chatId, step: "new_team_slug", msgChatId: msg.chat.id, msgId: msg.message_id });
  await ctx.answerCbQuery();
  await ctx.editMessageText("Введи имя команды (латиница, цифры, _ до 32 символов). Например: tagbar", {
    reply_markup: { inline_keyboard: [[{ text: "Отмена", callback_data: CB.cancelNew(chatId) }]] }
  }).catch(() => {});
});

bot.action(/^adm_cn$/, async (ctx) => {
  adminInputState.delete(ctx.from.id);
  const chatId = ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return ctx.answerCbQuery();
  const cid = String(chatId);
  const teams = listTeamsStmt.all(cid);
  const rows = teams.map((t) => {
    const n = getTeamMemberCount(cid, t.slug);
    return [{ text: `/${t.slug} (${n})`, callback_data: CB.team(null, t.slug) }];
  });
  rows.push([{ text: "➕ Создать команду", callback_data: CB.newteam(null) }]);
  rows.push([{ text: "← Назад", callback_data: CB.menu(null) }]);
  await ctx.answerCbQuery();
  await ctx.editMessageText("Подгруппы (команды):", { reply_markup: { inline_keyboard: rows } }).catch(() => {});
});

bot.action(/^adm_cn:(.+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  adminInputState.delete(ctx.from.id);
  const cid = String(chatId);
  const teams = listTeamsStmt.all(cid);
  const rows = teams.map((t) => {
    const n = getTeamMemberCount(cid, t.slug);
    return [{ text: `/${t.slug} (${n})`, callback_data: CB.team(chatId, t.slug) }];
  });
  rows.push([{ text: "➕ Создать команду", callback_data: CB.newteam(chatId) }]);
  rows.push([{ text: "← Назад", callback_data: CB.menu(chatId) }]);
  const title = await getChatTitleSafe(ctx, chatId);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`${title}\nПодгруппы (команды):`, { reply_markup: { inline_keyboard: rows } }).catch(() => {});
});

bot.action(/^adm_cr:([^:]+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  adminInputState.delete(ctx.from.id);
  const cid = String(chatId);
  const n = getTeamMemberCount(cid, slug);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Команда /${slug}. Участников: ${n}`, { reply_markup: buildTeamScreenKeyboard(false, null, slug) }).catch(() => {});
});

bot.action(/^adm_cr:(.+):([^:]+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  const slug = ctx.match[2];
  if (ctx.callbackQuery.message.chat.type !== "private") return ctx.answerCbQuery();
  adminInputState.delete(ctx.from.id);
  const cid = String(chatId);
  const n = getTeamMemberCount(cid, slug);
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Команда /${slug}. Участников: ${n}`, { reply_markup: buildTeamScreenKeyboard(true, chatId, slug) }).catch(() => {});
});

function getTeamMemberCount(chatId, slug) {
  return teamMemberCountStmt.get(String(chatId), slug)?.n ?? 0;
}

const TEAM_ADD_PAGE_SIZE = 8;
const TEAM_REM_PAGE_SIZE = 8;

function teamLabelForMessage(slug) {
  if (!slug) return "Все";
  const s = String(slug);
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function parseTagCommand(text, chatId) {
  if (!text || typeof text !== "string") return null;
  const regex = /\/(tagall|[\w]+)(@\w+)?/gi;
  const match = regex.exec(text);
  if (!match) return null;
  const cmd = match[1].toLowerCase();
  if (cmd === "tagall") return { type: "tagall" };
  const teamRow = getTeamSlugCaseInsensitiveStmt.get(String(chatId), cmd);
  if (teamRow) return { type: "team", slug: teamRow.slug };
  return null;
}

function messageHasExtraContent(ctx, commandStr) {
  const msg = ctx.message;
  if (msg.photo || msg.video || msg.document || msg.audio || msg.voice || msg.video_note || msg.sticker)
    return true;
  const text = msg.text || msg.caption || "";
  const escaped = commandStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutCommand = text.replace(new RegExp(`\\/${escaped}(@\\w+)?`, "gi"), "").trim();
  return withoutCommand.length > 0;
}

function getTargetMessageId(ctx, commandInfo) {
  if (ctx.message.reply_to_message) return ctx.message.reply_to_message.message_id;
  const cmd = commandInfo.type === "tagall" ? "tagall" : commandInfo.slug;
  if (messageHasExtraContent(ctx, cmd)) return ctx.message.message_id;
  return null;
}

async function sendMentionChunks(ctx, chatId, targetMessageId, members, teamSlug = null) {
  const label = teamLabelForMessage(teamSlug);
  const suffix = `\n${escapeHtml(label)}, для вас важное сообщение!`;
  const chunks = [];
  for (let i = 0; i < members.length; i += CHUNK) {
    chunks.push(members.slice(i, i + CHUNK));
  }
  for (let i = 0; i < chunks.length; i++) {
    const mentions = chunks[i].map(mentionHtml).join(MENTION_SEPARATOR);
    const text = mentions + suffix;
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
