'use strict';

const store = require('../store');
const { all, get, run, newId } = require('../db');
const { askAI } = require('./ai');

const BOT_ID = 'nexy-bot-0001';

const COLORS = {
  brand: '#5865f2',
  ok: '#57f287',
  warn: '#fee75c',
  err: '#ed4245',
  gold: '#f1c40f',
  pink: '#eb459e',
  info: '#00b0f4'
};

/**
 * O bot roda dentro do proprio servidor: ele nao usa nenhuma API externa,
 * apenas escuta o barramento de mensagens e responde pelo mesmo caminho
 * que qualquer usuario. `deliver` e injetado pela camada de realtime.
 */
const bot = {
  id: BOT_ID,
  user: null,
  commands: new Map(),
  aliases: new Map(),
  deliver: null,        // (message) => void  -> broadcast via socket.io
  music: new Map(),     // guildId -> { queue, playing, startedAt, channelId }
  antispam: new Map(),  // `${guildId}:${userId}` -> timestamps[]
  games: new Map(),     // channelId -> estado de jogo ativo (trivia etc.)
  COLORS
};

/* ------------------------------------------------------------- bootstrap */

async function ensureBotUser() {
  let u = await store.getUser(BOT_ID);
  if (!u) {
    u = await store.createUser({ id: BOT_ID, username: 'Nexy', email: null, passwordHash: null, isBot: true });
    await run("UPDATE users SET avatar_color = '#5865f2', status = 'online', bio = ? WHERE id = ?",
      'Bot oficial do PlingChat. Digite !ajuda para ver tudo que eu faco.', BOT_ID);
  } else {
    await run("UPDATE users SET status = 'online' WHERE id = ?", BOT_ID);
  }
  bot.user = await store.getUser(BOT_ID);
  return bot.user;
}

/** Registra um modulo de comandos. */
function registerModule(mod) {
  for (const cmd of mod.commands) {
    bot.commands.set(cmd.name, { ...cmd, category: mod.category });
    for (const alias of cmd.aliases || []) bot.aliases.set(alias, cmd.name);
  }
}

function resolveCommand(name) {
  const key = String(name || '').toLowerCase();
  return bot.commands.get(key) || bot.commands.get(bot.aliases.get(key));
}

/* ---------------------------------------------------------------- envio  */

/** Publica uma mensagem do bot em um canal. */
async function say(channelId, content, embed = null) {
  const message = await store.createMessage({
    channelId,
    authorId: BOT_ID,
    content: typeof content === 'string' ? content : '',
    embed: embed || (typeof content === 'object' ? content : null)
  });
  if (bot.deliver) bot.deliver(message);
  return message;
}

bot.say = say;
bot.embed = (opts) => ({ color: COLORS.brand, ...opts });

/* ------------------------------------------------------------ permissoes */

const RANKS = store.ROLE_RANK;

async function hasRank(ctx, required) {
  if (!ctx.guild) return false;
  return (await store.rank(ctx.guild.id, ctx.user.id)) >= (RANKS[required] ?? 0);
}

/* ------------------------------------------------------------------- xp  */

const xpForLevel = (level) => 5 * level * level + 50 * level + 100;

async function grantXP(guildId, userId, channelId) {
  const settings = await store.getSettings(guildId);
  if (!settings.levels_enabled) return;

  const member = await store.getMember(guildId, userId);
  if (!member) return;

  const nowTs = Date.now();
  if (nowTs - member.last_message < 60_000) return; // 1 minuto de cooldown

  const gained = 15 + Math.floor(Math.random() * 11);
  let xp = member.xp + gained;
  let level = member.level;
  let leveledUp = false;

  while (xp >= xpForLevel(level)) {
    xp -= xpForLevel(level);
    level += 1;
    leveledUp = true;
  }

  await run(
    'UPDATE guild_members SET xp = ?, level = ?, last_message = ?, coins = coins + ? WHERE guild_id = ? AND user_id = ?',
    xp, level, nowTs, leveledUp ? level * 25 : 0, guildId, userId
  );

  if (leveledUp && settings.levelup_message) {
    const user = await store.getUser(userId);
    const guild = await store.getGuild(guildId);
    await say(channelId, '', bot.embed({
      color: COLORS.gold,
      description: settings.levelup_message
        .replace('{user}', `**${user.username}**`)
        .replace('{level}', String(level))
        .replace('{server}', guild.name),
      footer: leveledUp ? `Bonus de ${level * 25} moedas creditado` : null
    }));
  }
}

/* --------------------------------------------------------------- automod */

async function runAutomod(ctx) {
  const { guild, channel, user, message, settings } = ctx;
  if (!guild) return false;
  if ((await store.rank(guild.id, user.id)) >= RANKS.mod) return false;

  const content = message.content || '';
  const punish = async (reason) => {
    await store.deleteMessage(message.id);
    if (bot.deliver) bot.deliver({ __deleted: true, id: message.id, channelId: channel.id });
    await say(channel.id, '', bot.embed({
      color: COLORS.err,
      description: `🛡️ **${user.username}**, sua mensagem foi removida. Motivo: ${reason}.`
    }));
    await logAction(guild.id, `Automod removeu mensagem de **${user.username}** (${reason})`);
    return true;
  };

  const words = String(settings.automod_words || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (words.length) {
    const lowered = content.toLowerCase();
    if (words.some((w) => lowered.includes(w))) return punish('palavra bloqueada');
  }

  if (settings.automod_links && /(https?:\/\/|www\.)\S+/i.test(content)) {
    return punish('links nao sao permitidos');
  }

  if (settings.automod_caps && content.length >= 12) {
    const letters = content.replace(/[^a-zA-ZÀ-ÿ]/g, '');
    const caps = content.replace(/[^A-ZÀ-Þ]/g, '');
    if (letters.length >= 10 && caps.length / letters.length > 0.75) return punish('excesso de CAPS');
  }

  if (settings.automod_spam) {
    const key = `${guild.id}:${user.id}`;
    const stamps = (bot.antispam.get(key) || []).filter((t) => Date.now() - t < 7000);
    stamps.push(Date.now());
    bot.antispam.set(key, stamps);
    if (stamps.length > 6) {
      bot.antispam.set(key, []);
      await run('UPDATE guild_members SET muted_until = ? WHERE guild_id = ? AND user_id = ?',
        Date.now() + 60_000, guild.id, user.id);
      await say(channel.id, '', bot.embed({
        color: COLORS.err,
        title: '🛡️ Anti-spam',
        description: `**${user.username}** foi silenciado por 1 minuto por flood.`
      }));
      return punish('flood de mensagens');
    }
  }

  return false;
}

async function logAction(guildId, description) {
  const settings = await store.getSettings(guildId);
  if (!settings.log_channel_id) return;
  const ch = await store.getChannel(settings.log_channel_id);
  if (!ch) return;
  await say(ch.id, '', bot.embed({
    color: COLORS.info,
    description,
    footer: new Date().toLocaleString('pt-BR')
  }));
}

bot.logAction = logAction;
bot.hasRank = hasRank;
bot.xpForLevel = xpForLevel;

/* -------------------------------------------------------------- dispatch */

/**
 * Chamado para toda mensagem de usuario. Retorna true se o bot agiu.
 */
async function handleMessage(message) {
  if (!message || message.author?.id === BOT_ID) return false;

  const channel = await store.getChannel(message.channelId);
  if (!channel) return false;

  const guild = channel.guild_id ? await store.getGuild(channel.guild_id) : null;
  // Fora de um servidor onde ele foi adicionado, o bot fica em silencio.
  if (guild && !(await store.getMember(guild.id, BOT_ID))) return false;

  const user = await store.getUser(message.author.id);
  const settings = guild ? await store.getSettings(guild.id) : { prefix: '!' };
  const member = guild ? await store.getMember(guild.id, user.id) : null;

  const ctx = {
    bot, store, message, channel, guild, user, member, settings,
    reply: (content, embed) => say(channel.id, content, embed),
    embed: bot.embed,
    COLORS,
    hasRank: (r) => hasRank(ctx, r)
  };

  if (guild && (await runAutomod(ctx))) return true;

  const prefix = settings.prefix || '!';
  const content = String(message.content || '').trim();

  if (!content.startsWith(prefix)) {
    if (guild) await grantXP(guild.id, user.id, channel.id);

    // Numa DM toda mensagem é "conversa com o bot"; num servidor só quando
    // te chamam pelo nome -- senão o Nexy responderia qualquer papo alheio.
    const mentioned = /\bnexy\b/i.test(content);
    if (!guild || mentioned) {
      // DM tem contexto de conversa de verdade (últimas mensagens trocadas);
      // menção num canal de servidor fica sem histórico -- é um "oi" avulso,
      // não uma DM continuada, e não faz sentido puxar o papo alheio do canal.
      const history = !guild
        ? (await store.listMessages(channel.id, { limit: 13 }))
            .filter((m) => m.id !== message.id)
            .slice(-12)
            .map((m) => ({ content: m.content, mine: m.author.id === BOT_ID }))
        : [];

      const aiAnswer = await askAI({ userId: user.id, username: user.username, content, history });
      if (aiAnswer) { await say(channel.id, aiAnswer); return true; }

      // Sem IA configurada (ou a chamada falhou) -- cai pro script de sempre.
      const { smallTalk } = require('./commands/fun');
      const answer = smallTalk(content, user);
      if (answer) { await say(channel.id, answer); return true; }
    }
    return false;
  }

  const raw = content.slice(prefix.length).trim();
  if (!raw) return false;

  const parts = raw.split(/\s+/);
  const name = parts[0].toLowerCase();
  const args = parts.slice(1);

  ctx.args = args;
  ctx.argStr = raw.slice(parts[0].length).trim();
  ctx.prefix = prefix;

  const command = resolveCommand(name);

  if (!command) {
    if (guild) {
      const custom = await get('SELECT * FROM custom_commands WHERE guild_id = ? AND name = ?', guild.id, name);
      if (custom) {
        await say(channel.id, custom.response.replace(/\{user\}/g, `**${user.username}**`));
        return true;
      }
    }
    return false;
  }

  if (command.guildOnly && !guild) {
    await say(channel.id, '', bot.embed({ color: COLORS.err, description: '❌ Este comando so funciona dentro de um servidor.' }));
    return true;
  }

  if (command.permission && !(await hasRank(ctx, command.permission))) {
    await say(channel.id, '', bot.embed({
      color: COLORS.err,
      description: `❌ Voce precisa do cargo **${command.permission}** ou superior para usar \`${prefix}${command.name}\`.`
    }));
    return true;
  }

  try {
    await command.run(ctx);
  } catch (err) {
    await say(channel.id, '', bot.embed({
      color: COLORS.err,
      title: 'Erro ao executar o comando',
      description: String(err.message || err)
    }));
  }
  return true;
}

/* ------------------------------------------------ eventos de entrada/saida */

async function onMemberJoin(guildId, userId) {
  const settings = await store.getSettings(guildId);
  const guild = await store.getGuild(guildId);
  const user = await store.getUser(userId);
  if (!settings.welcome_channel_id || !settings.welcome_message || !guild || !user) return;
  const ch = await store.getChannel(settings.welcome_channel_id);
  if (!ch) return;
  await say(ch.id, '', bot.embed({
    color: COLORS.ok,
    title: '👋 Novo membro!',
    description: settings.welcome_message
      .replace('{user}', `**${user.username}**`)
      .replace('{server}', guild.name)
      .replace('{count}', String(await store.memberCount(guildId)))
  }));
}

async function onMemberLeave(guildId, userId, username) {
  const settings = await store.getSettings(guildId);
  if (!settings.welcome_channel_id || !settings.goodbye_message) return;
  const ch = await store.getChannel(settings.welcome_channel_id);
  if (!ch) return;
  await say(ch.id, '', bot.embed({
    color: COLORS.err,
    description: settings.goodbye_message
      .replace('{user}', `**${username}**`)
      .replace('{count}', String(await store.memberCount(guildId)))
  }));
}

/* ------------------------------------------------------------ agendador  */

async function tick() {
  const dueReminders = await all('SELECT * FROM reminders WHERE remind_at <= ?', Date.now());
  for (const r of dueReminders) {
    await run('DELETE FROM reminders WHERE id = ?', r.id);
    const user = await store.getUser(r.user_id);
    if (!user || !(await store.getChannel(r.channel_id))) continue;
    await say(r.channel_id, '', bot.embed({
      color: COLORS.info,
      title: '⏰ Lembrete',
      description: `**${user.username}**, voce pediu para lembrar: ${r.text}`
    }));
  }
}

function startScheduler() {
  setInterval(() => { tick().catch((err) => console.warn('bot tick: falha', err.message)); }, 5000).unref?.();
}

/* --------------------------------------------------------------- init    */

async function initBot({ deliver }) {
  bot.deliver = deliver;
  await ensureBotUser();

  registerModule(require('./commands/utility'));
  registerModule(require('./commands/moderation'));
  registerModule(require('./commands/economy'));
  registerModule(require('./commands/levels'));
  registerModule(require('./commands/fun'));
  registerModule(require('./commands/config'));
  registerModule(require('./commands/music'));

  startScheduler();
  return bot;
}

module.exports = {
  bot, BOT_ID, COLORS,
  initBot, handleMessage, say, onMemberJoin, onMemberLeave,
  ensureBotUser, resolveCommand, grantXP, xpForLevel, hasRank, logAction, newId
};
