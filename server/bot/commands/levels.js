'use strict';

const store = require('../../store');
const { all, run } = require('../../db');

const xpForLevel = (level) => 5 * level * level + 50 * level + 100;

function progressBar(current, total, size = 18) {
  const filled = Math.max(0, Math.min(size, Math.round((current / total) * size)));
  return '█'.repeat(filled) + '░'.repeat(size - filled);
}

const commands = [
  {
    name: 'nivel',
    aliases: ['rank', 'level', 'xp'],
    description: 'Mostra seu nivel e progresso de XP',
    usage: 'nivel [@usuario]',
    guildOnly: true,
    async run(ctx) {
      const target = ctx.argStr ? await store.findMemberByName(ctx.guild.id, ctx.argStr) : ctx.user;
      if (!target) return ctx.reply('Usuario nao encontrado.');
      const m = await store.getMember(ctx.guild.id, target.id);
      if (!m) return ctx.reply('Esse usuario nao e membro do servidor.');

      const needed = xpForLevel(m.level);
      const ranked = await all(
        `SELECT user_id FROM guild_members WHERE guild_id = ?
         ORDER BY level DESC, xp DESC`, ctx.guild.id
      );
      const position = ranked.findIndex((r) => r.user_id === target.id) + 1;

      return ctx.reply('', ctx.embed({
        color: target.avatar_color,
        title: `📈 Nivel de ${target.username}`,
        avatarOf: store.publicUser(target),
        description: `**Nivel ${m.level}** · ${m.xp} / ${needed} XP\n\`${progressBar(m.xp, needed)}\` ${Math.floor((m.xp / needed) * 100)}%`,
        fields: [
          { name: 'Posicao', value: `#${position}`, inline: true },
          { name: 'XP total', value: String(m.xp + Array.from({ length: m.level }, (_, i) => xpForLevel(i)).reduce((a, b) => a + b, 0)), inline: true },
          { name: 'Moedas', value: `${m.coins.toLocaleString('pt-BR')} 🪙`, inline: true }
        ]
      }));
    }
  },
  {
    name: 'top',
    aliases: ['leaderboard', 'lb', 'niveis'],
    description: 'Ranking de niveis do servidor',
    guildOnly: true,
    async run(ctx) {
      const rows = await all(
        `SELECT u.username, m.level, m.xp FROM guild_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.guild_id = ? AND u.is_bot = 0
         ORDER BY m.level DESC, m.xp DESC LIMIT 10`, ctx.guild.id
      );
      const medals = ['🥇', '🥈', '🥉'];
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.gold,
        title: `🏆 Ranking de niveis — ${ctx.guild.name}`,
        description: rows.map((r, i) =>
          `${medals[i] || `**${i + 1}.**`} **${r.username}** — nivel ${r.level} (${r.xp} XP)`).join('\n')
          || 'Ainda nao ha ranking. Converse para ganhar XP!'
      }));
    }
  },
  {
    name: 'darxp',
    aliases: ['givexp', 'setxp'],
    description: 'Adiciona XP a um membro',
    usage: 'darxp @usuario 500',
    guildOnly: true,
    permission: 'admin',
    async run(ctx) {
      const [name, amountRaw] = ctx.args;
      const amount = parseInt(amountRaw, 10);
      const target = await store.findMemberByName(ctx.guild.id, name);
      if (!target || !Number.isFinite(amount)) return ctx.reply('Use: `!darxp @usuario 500`');

      const m = await store.getMember(ctx.guild.id, target.id);
      let xp = Math.max(0, m.xp + amount);
      let level = m.level;
      while (xp >= xpForLevel(level)) { xp -= xpForLevel(level); level += 1; }
      while (level > 0 && xp < 0) { level -= 1; xp += xpForLevel(level); }

      await run('UPDATE guild_members SET xp = ?, level = ? WHERE guild_id = ? AND user_id = ?',
        xp, level, ctx.guild.id, target.id);
      ctx.bot.deliver?.({ __memberUpdated: true, guildId: ctx.guild.id, userId: target.id });
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.ok,
        description: `📈 **${target.username}** agora esta no nivel **${level}** com ${xp} XP.`
      }));
    }
  },
  {
    name: 'resetxp',
    description: 'Zera o XP de um membro',
    usage: 'resetxp @usuario',
    guildOnly: true,
    permission: 'admin',
    async run(ctx) {
      const target = await store.findMemberByName(ctx.guild.id, ctx.argStr);
      if (!target) return ctx.reply('Usuario nao encontrado.');
      await run('UPDATE guild_members SET xp = 0, level = 0 WHERE guild_id = ? AND user_id = ?', ctx.guild.id, target.id);
      ctx.bot.deliver?.({ __memberUpdated: true, guildId: ctx.guild.id, userId: target.id });
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.warn, description: `♻️ XP de **${target.username}** zerado.` }));
    }
  }
];

module.exports = { category: 'Niveis', commands, xpForLevel };
