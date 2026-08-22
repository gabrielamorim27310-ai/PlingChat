'use strict';

const store = require('../store');
const { all, get, run, newId } = require('../db');

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

function ensureBotUser() {
  let u = store.getUser(BOT_ID);
  if (!u) {
    u = store.createUser({ id: BOT_ID, username: 'Nexy', email: null, passwordHash: null, isBot: true });
    run("UPDATE users SET avatar_color = '#5865f2', status = 'online', bio = ? WHERE id = ?",
      'Bot oficial do PlingChat. Digite !ajuda para ver tudo que eu faco.', BOT_ID);
  } else {
    run("UPDATE users SET status = 'online' WHERE id = ?", BOT_ID);
  }
  bot.user = store.getUser(BOT_ID);
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
function say(channelId, content, embed = null) {
  const message = store.createMessage({
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

function hasRank(ctx, required) {
  if (!ctx.guild) return false;
  return store.rank(ctx.guild.id, ctx.user.id) >= (RANKS[required] ?? 0);
}

/* ------------------------------------------------------------------- xp  */

const xpForLevel = (level) => 5 * level * level + 50 * level + 100;

function grantXP(guildId, userId, channelId) {
  const settings = store.getSettings(guildId);
  if (!settings.levels_enabled) return;

  const member = store.getMember(guildId, userId);
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

  run(
    'UPDATE guild_members SET xp = ?, level = ?, last_message = ?, coins = coins + ? WHERE guild_id = ? AND user_id = ?',
    xp, level, nowTs, leveledUp ? level * 25 : 0, guildId, userId
  );

  if (leveledUp && settings.levelup_message) {
    const user = store.getUser(userId);
    say(channelId, '', bot.embed({
      color: COLORS.gold,
      description: settings.levelup_message
        .replace('{user}', `**${user.username}**`)
        .replace('{level}', String(level))
        .replace('{server}', store.getGuild(guildId).name),
      footer: leveledUp ? `Bonus de ${level * 25} moedas creditado` : null
    }));
  }
}

/* --------------------------------------------------------------- automod */

function runAutomod(ctx) {
  const { guild, channel, user, message, settings } = ctx;
  if (!guild) return false;
  if (store.rank(guild.id, user.id) >= RANKS.mod) return false;

  const content = message.content || '';
  const punish = (reason) => {
    store.deleteMessage(message.id);
    if (bot.deliver) bot.deliver({ __deleted: true, id: message.id, channelId: channel.id });
    say(channel.id, '', bot.embed({
      color: COLORS.err,
      description: `🛡️ **${user.username}**, sua mensagem foi removida. Motivo: ${reason}.`
    }));
    logAction(guild.id, `Automod removeu mensagem de **${user.username}** (${reason})`);
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
      run('UPDATE guild_members SET muted_until = ? WHERE guild_id = ? AND user_id = ?',
        Date.now() + 60_000, guild.id, user.id);
      say(channel.id, '', bot.embed({
        color: COLORS.err,
        title: '🛡️ Anti-spam',
        description: `**${user.username}** foi silenciado por 1 minuto por flood.`
      }));
      return punish('flood de mensagens');
    }
  }

  return false;
}

function logAction(guildId, description) {
  const settings = store.getSettings(guildId);
  if (!settings.log_channel_id) return;
  const ch = store.getChannel(settings.log_channel_id);
  if (!ch) return;
  say(ch.id, '', bot.embed({
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

  const channel = store.getChannel(message.channelId);
  if (!channel) return false;

  const guild = channel.guild_id ? store.getGuild(channel.guild_id) : null;
  // Fora de um servidor onde ele foi adicionado, o bot fica em silencio.
  if (guild && !store.getMember(guild.id, BOT_ID)) return false;

  const user = store.getUser(message.author.id);
  const settings = guild ? store.getSettings(guild.id) : { prefix: '!' };
  const member = guild ? store.getMember(guild.id, user.id) : null;

  const ctx = {
    bot, store, message, channel, guild, user, member, settings,
    reply: (content, embed) => say(channel.id, content, embed),
    embed: bot.embed,
    COLORS,
    hasRank: (r) => hasRank(ctx, r)
  };

  if (guild && runAutomod(ctx)) return true;

  const prefix = settings.prefix || '!';
  const content = String(message.content || '').trim();

  if (!content.startsWith(prefix)) {
    if (guild) grantXP(guild.id, user.id, channel.id);
    // Menção direta ao bot vira conversa
    if (/\bnexy\b/i.test(content)) {
      const { smallTalk } = require('./commands/fun');
      const answer = smallTalk(content, user);
      if (answer) say(channel.id, answer);
      return true;
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
      const custom = get('SELECT * FROM custom_commands WHERE guild_id = ? AND name = ?', guild.id, name);
      if (custom) {
        say(channel.id, custom.response.replace(/\{user\}/g, `**${user.username}**`));
        return true;
      }
    }
    return false;
  }

  if (command.guildOnly && !guild) {
    say(channel.id, '', bot.embed({ color: COLORS.err, description: '❌ Este comando so funciona dentro de um servidor.' }));
    return true;
  }

  if (command.permission && !hasRank(ctx, command.permission)) {
    say(channel.id, '', bot.embed({
      color: COLORS.err,
      description: `❌ Voce precisa do cargo **${command.permission}** ou superior para usar \`${prefix}${command.name}\`.`
    }));
    return true;
  }

  try {
    await command.run(ctx);
  } catch (err) {
    say(channel.id, '', bot.embed({
      color: COLORS.err,
      title: 'Erro ao executar o comando',
      description: String(err.message || err)
    }));
  }
  return true;
}

/* ------------------------------------------------ eventos de entrada/saida */

function onMemberJoin(guildId, userId) {
  const settings = store.getSettings(guildId);
  const guild = store.getGuild(guildId);
  const user = store.getUser(userId);
  if (!settings.welcome_channel_id || !settings.welcome_message || !guild || !user) return;
  const ch = store.getChannel(settings.welcome_channel_id);
  if (!ch) return;
  say(ch.id, '', bot.embed({
    color: COLORS.ok,
    title: '👋 Novo membro!',
    description: settings.welcome_message
      .replace('{user}', `**${user.username}**`)
      .replace('{server}', guild.name)
      .replace('{count}', String(store.memberCount(guildId)))
  }));
}

function onMemberLeave(guildId, userId, username) {
  const settings = store.getSettings(guildId);
  if (!settings.welcome_channel_id || !settings.goodbye_message) return;
  const ch = store.getChannel(settings.welcome_channel_id);
  if (!ch) return;
  say(ch.id, '', bot.embed({
    color: COLORS.err,
    description: settings.goodbye_message
      .replace('{user}', `**${username}**`)
      .replace('{count}', String(store.memberCount(guildId)))
  }));
}

/* ------------------------------------------------------------ agendador  */

function tick() {
  const dueReminders = all('SELECT * FROM reminders WHERE remind_at <= ?', Date.now());
  for (const r of dueReminders) {
    run('DELETE FROM reminders WHERE id = ?', r.id);
    const user = store.getUser(r.user_id);
    if (!user || !store.getChannel(r.channel_id)) continue;
    say(r.channel_id, '', bot.embed({
      color: COLORS.info,
      title: '⏰ Lembrete',
      description: `**${user.username}**, voce pediu para lembrar: ${r.text}`
    }));
  }
}

function startScheduler() {
  setInterval(tick, 5000).unref?.();
}

/* --------------------------------------------------------------- init    */

function initBot({ deliver }) {
  bot.deliver = deliver;
  ensureBotUser();

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
