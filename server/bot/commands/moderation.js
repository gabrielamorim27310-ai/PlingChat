'use strict';

const store = require('../../store');
const { all, get, run, newId } = require('../../db');
const { parseDuration, humanDuration } = require('./utility');

/** Resolve o alvo do comando e valida a hierarquia de cargos. */
function resolveTarget(ctx, rawName) {
  if (!rawName) {
    ctx.reply('', ctx.embed({ color: ctx.COLORS.err, description: 'Informe o usuario alvo.' }));
    return null;
  }
  const target = store.findMemberByName(ctx.guild.id, rawName);
  if (!target) {
    ctx.reply('', ctx.embed({ color: ctx.COLORS.err, description: `Nao encontrei **${rawName}** neste servidor.` }));
    return null;
  }
  if (target.id === ctx.user.id) {
    ctx.reply('', ctx.embed({ color: ctx.COLORS.err, description: 'Voce nao pode fazer isso consigo mesmo.' }));
    return null;
  }
  if (target.is_bot) {
    ctx.reply('', ctx.embed({ color: ctx.COLORS.err, description: 'Nao mexe comigo. 🙂' }));
    return null;
  }
  if (store.rank(ctx.guild.id, target.id) >= store.rank(ctx.guild.id, ctx.user.id)) {
    ctx.reply('', ctx.embed({ color: ctx.COLORS.err, description: 'Esse membro tem cargo igual ou superior ao seu.' }));
    return null;
  }
  return target;
}

const commands = [
  {
    name: 'kick',
    aliases: ['expulsar'],
    description: 'Expulsa um membro do servidor',
    usage: 'kick @usuario [motivo]',
    guildOnly: true,
    permission: 'mod',
    run(ctx) {
      const [name, ...rest] = ctx.args;
      const target = resolveTarget(ctx, name);
      if (!target) return;
      const reason = rest.join(' ') || 'sem motivo informado';
      store.removeMember(ctx.guild.id, target.id);
      store.logAudit(ctx.guild.id, ctx.user.id, 'kick', target.id, { reason });
      ctx.bot.deliver?.({ __memberRemoved: true, guildId: ctx.guild.id, userId: target.id });
      ctx.bot.logAction(ctx.guild.id, `👢 **${target.username}** foi expulso por **${ctx.user.username}** — ${reason}`);
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.err,
        title: '👢 Membro expulso',
        description: `**${target.username}** foi removido do servidor.`,
        fields: [{ name: 'Motivo', value: reason }, { name: 'Moderador', value: ctx.user.username, inline: true }]
      }));
    }
  },
  {
    name: 'ban',
    aliases: ['banir'],
    description: 'Bane um membro permanentemente',
    usage: 'ban @usuario [motivo]',
    guildOnly: true,
    permission: 'admin',
    run(ctx) {
      const [name, ...rest] = ctx.args;
      const target = resolveTarget(ctx, name);
      if (!target) return;
      const reason = rest.join(' ') || 'sem motivo informado';
      store.banMember(ctx.guild.id, target.id, reason, ctx.user.id);
      store.logAudit(ctx.guild.id, ctx.user.id, 'ban', target.id, { reason });
      ctx.bot.deliver?.({ __memberRemoved: true, guildId: ctx.guild.id, userId: target.id });
      ctx.bot.logAction(ctx.guild.id, `🔨 **${target.username}** foi banido por **${ctx.user.username}** — ${reason}`);
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.err,
        title: '🔨 Membro banido',
        description: `**${target.username}** foi banido do servidor.`,
        fields: [{ name: 'Motivo', value: reason }, { name: 'Moderador', value: ctx.user.username, inline: true }]
      }));
    }
  },
  {
    name: 'unban',
    aliases: ['desbanir'],
    description: 'Remove o banimento de um usuario',
    usage: 'unban usuario#0000',
    guildOnly: true,
    permission: 'admin',
    run(ctx) {
      const banned = store.listBans(ctx.guild.id);
      const query = ctx.argStr.trim().toLowerCase();
      const found = banned.find((b) => b.user && (b.user.handle.toLowerCase() === query || b.user.username.toLowerCase() === query));
      if (!found) return ctx.reply('', ctx.embed({ color: ctx.COLORS.err, description: 'Esse usuario nao esta banido.' }));
      store.unbanMember(ctx.guild.id, found.user.id);
      store.logAudit(ctx.guild.id, ctx.user.id, 'unban', found.user.id);
      ctx.bot.logAction(ctx.guild.id, `♻️ **${found.user.username}** foi desbanido por **${ctx.user.username}**`);
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.ok, description: `♻️ **${found.user.username}** foi desbanido.` }));
    }
  },
  {
    name: 'banidos',
    aliases: ['bans', 'banlist'],
    description: 'Lista os usuarios banidos',
    guildOnly: true,
    permission: 'mod',
    run(ctx) {
      const bans = store.listBans(ctx.guild.id);
      if (!bans.length) return ctx.reply('', ctx.embed({ color: ctx.COLORS.ok, description: 'Nenhum usuario banido. 🎉' }));
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.err,
        title: `🔨 ${bans.length} usuario(s) banido(s)`,
        description: bans.map((b) => `• **${b.user?.handle ?? '???'}** — ${b.reason || 'sem motivo'}`).join('\n')
      }));
    }
  },
  {
    name: 'mute',
    aliases: ['silenciar', 'castigo'],
    description: 'Silencia um membro por um tempo',
    usage: 'mute @usuario 10m [motivo]',
    guildOnly: true,
    permission: 'mod',
    run(ctx) {
      const [name, durationText, ...rest] = ctx.args;
      const target = resolveTarget(ctx, name);
      if (!target) return;
      const ms = parseDuration(durationText) ?? 10 * 60_000;
      const reason = rest.join(' ') || 'sem motivo informado';
      run('UPDATE guild_members SET muted_until = ? WHERE guild_id = ? AND user_id = ?',
        Date.now() + ms, ctx.guild.id, target.id);
      store.logAudit(ctx.guild.id, ctx.user.id, 'mute', target.id, { reason, durationMs: ms });
      ctx.bot.deliver?.({ __memberUpdated: true, guildId: ctx.guild.id, userId: target.id });
      ctx.bot.logAction(ctx.guild.id, `🔇 **${target.username}** silenciado por ${humanDuration(ms)} — ${reason}`);
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.warn,
        title: '🔇 Membro silenciado',
        description: `**${target.username}** ficara mudo por **${humanDuration(ms)}**.`,
        fields: [{ name: 'Motivo', value: reason }]
      }));
    }
  },
  {
    name: 'unmute',
    aliases: ['dessilenciar'],
    description: 'Remove o silenciamento de um membro',
    usage: 'unmute @usuario',
    guildOnly: true,
    permission: 'mod',
    run(ctx) {
      const target = store.findMemberByName(ctx.guild.id, ctx.argStr);
      if (!target) return ctx.reply('', ctx.embed({ color: ctx.COLORS.err, description: 'Usuario nao encontrado.' }));
      run('UPDATE guild_members SET muted_until = 0 WHERE guild_id = ? AND user_id = ?', ctx.guild.id, target.id);
      store.logAudit(ctx.guild.id, ctx.user.id, 'unmute', target.id);
      ctx.bot.deliver?.({ __memberUpdated: true, guildId: ctx.guild.id, userId: target.id });
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.ok, description: `🔊 **${target.username}** pode falar novamente.` }));
    }
  },
  {
    name: 'warn',
    aliases: ['advertir', 'aviso'],
    description: 'Adverte um membro (3 avisos = mute automatico)',
    usage: 'warn @usuario motivo',
    guildOnly: true,
    permission: 'mod',
    run(ctx) {
      const [name, ...rest] = ctx.args;
      const target = resolveTarget(ctx, name);
      if (!target) return;
      const reason = rest.join(' ') || 'sem motivo informado';
      run('INSERT INTO warns (id, guild_id, user_id, moderator, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        newId(), ctx.guild.id, target.id, ctx.user.id, reason, Date.now());

      const total = get('SELECT COUNT(*) AS n FROM warns WHERE guild_id = ? AND user_id = ?', ctx.guild.id, target.id).n;
      let extra = null;
      if (total >= 3) {
        run('UPDATE guild_members SET muted_until = ? WHERE guild_id = ? AND user_id = ?',
          Date.now() + 30 * 60_000, ctx.guild.id, target.id);
        extra = 'Atingiu 3 advertencias: silenciado automaticamente por 30 minutos.';
      }
      store.logAudit(ctx.guild.id, ctx.user.id, 'warn', target.id, { reason, total });
      ctx.bot.logAction(ctx.guild.id, `⚠️ **${target.username}** advertido por **${ctx.user.username}** (${total}/3) — ${reason}`);
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.warn,
        title: '⚠️ Advertencia aplicada',
        description: `**${target.username}** recebeu uma advertencia (**${total}**).`,
        fields: [
          { name: 'Motivo', value: reason },
          ...(extra ? [{ name: 'Punicao automatica', value: extra }] : [])
        ]
      }));
    }
  },
  {
    name: 'warns',
    aliases: ['advertencias'],
    description: 'Lista as advertencias de um membro',
    usage: 'warns @usuario',
    guildOnly: true,
    run(ctx) {
      const target = ctx.argStr ? store.findMemberByName(ctx.guild.id, ctx.argStr) : ctx.user;
      if (!target) return ctx.reply('Usuario nao encontrado.');
      const rows = all('SELECT * FROM warns WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC', ctx.guild.id, target.id);
      if (!rows.length) {
        return ctx.reply('', ctx.embed({ color: ctx.COLORS.ok, description: `**${target.username}** nao tem advertencias. ✨` }));
      }
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.warn,
        title: `⚠️ Advertencias de ${target.username}`,
        description: rows.map((w, i) => {
          const mod = store.getUser(w.moderator);
          return `**${i + 1}.** ${w.reason} — por ${mod?.username ?? '???'} em ${new Date(w.created_at).toLocaleDateString('pt-BR')}`;
        }).join('\n')
      }));
    }
  },
  {
    name: 'limparwarns',
    aliases: ['clearwarns'],
    description: 'Remove todas as advertencias de um membro',
    usage: 'limparwarns @usuario',
    guildOnly: true,
    permission: 'admin',
    run(ctx) {
      const target = store.findMemberByName(ctx.guild.id, ctx.argStr);
      if (!target) return ctx.reply('Usuario nao encontrado.');
      run('DELETE FROM warns WHERE guild_id = ? AND user_id = ?', ctx.guild.id, target.id);
      store.logAudit(ctx.guild.id, ctx.user.id, 'warns_cleared', target.id);
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.ok, description: `🧹 Advertencias de **${target.username}** zeradas.` }));
    }
  },
  {
    name: 'limpar',
    aliases: ['clear', 'purge'],
    description: 'Apaga as ultimas mensagens do canal',
    usage: 'limpar 20',
    guildOnly: true,
    permission: 'mod',
    run(ctx) {
      const count = Math.min(Math.max(parseInt(ctx.args[0], 10) || 10, 1), 100);
      const ids = store.purgeMessages(ctx.channel.id, count + 1);
      for (const id of ids) ctx.bot.deliver?.({ __deleted: true, id, channelId: ctx.channel.id });
      store.logAudit(ctx.guild.id, ctx.user.id, 'messages_purged', null, { count: ids.length, channel: ctx.channel.name });
      ctx.bot.logAction(ctx.guild.id, `🧹 **${ctx.user.username}** limpou ${ids.length} mensagens em #${ctx.channel.name}`);
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.ok,
        description: `🧹 **${ids.length}** mensagens apagadas.`
      }));
    }
  },
  {
    name: 'promover',
    aliases: ['promote'],
    description: 'Promove um membro (mod ou admin)',
    usage: 'promover @usuario mod|admin',
    guildOnly: true,
    permission: 'admin',
    run(ctx) {
      const [name, roleRaw] = ctx.args;
      const role = (roleRaw || 'mod').toLowerCase();
      if (!['mod', 'admin'].includes(role)) return ctx.reply('Cargos validos: `mod`, `admin`.');
      const target = resolveTarget(ctx, name);
      if (!target) return;
      if (store.ROLE_RANK[role] >= store.rank(ctx.guild.id, ctx.user.id)) {
        return ctx.reply('', ctx.embed({ color: ctx.COLORS.err, description: 'Voce nao pode dar um cargo igual ou acima do seu.' }));
      }
      store.setRole(ctx.guild.id, target.id, role);
      store.logAudit(ctx.guild.id, ctx.user.id, 'role_promoted', target.id, { role });
      ctx.bot.deliver?.({ __memberUpdated: true, guildId: ctx.guild.id, userId: target.id });
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.ok,
        description: `⬆️ **${target.username}** agora e **${role}**.`
      }));
    }
  },
  {
    name: 'rebaixar',
    aliases: ['demote'],
    description: 'Rebaixa um membro para membro comum',
    usage: 'rebaixar @usuario',
    guildOnly: true,
    permission: 'admin',
    run(ctx) {
      const target = resolveTarget(ctx, ctx.argStr);
      if (!target) return;
      store.setRole(ctx.guild.id, target.id, 'member');
      store.logAudit(ctx.guild.id, ctx.user.id, 'role_demoted', target.id);
      ctx.bot.deliver?.({ __memberUpdated: true, guildId: ctx.guild.id, userId: target.id });
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.warn, description: `⬇️ **${target.username}** voltou a ser membro.` }));
    }
  },
  {
    name: 'apelido',
    aliases: ['nick'],
    description: 'Define o apelido de um membro no servidor',
    usage: 'apelido @usuario novo apelido',
    guildOnly: true,
    permission: 'mod',
    run(ctx) {
      const [name, ...rest] = ctx.args;
      const target = store.findMemberByName(ctx.guild.id, name);
      if (!target) return ctx.reply('Usuario nao encontrado.');
      const nick = rest.join(' ').slice(0, 32) || null;
      run('UPDATE guild_members SET nickname = ? WHERE guild_id = ? AND user_id = ?', nick, ctx.guild.id, target.id);
      ctx.bot.deliver?.({ __memberUpdated: true, guildId: ctx.guild.id, userId: target.id });
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.ok,
        description: nick ? `✏️ **${target.username}** agora se chama **${nick}**.` : `✏️ Apelido de **${target.username}** removido.`
      }));
    }
  }
];

module.exports = { category: 'Moderacao', commands };
