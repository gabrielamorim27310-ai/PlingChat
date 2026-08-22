'use strict';

const store = require('../../store');
const { all, get, run, newId } = require('../../db');

const START = Date.now();

function humanDuration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s % 60}s`);
  return parts.join(' ');
}

function parseDuration(text) {
  const m = /^(\d+)\s*(s|seg|m|min|h|hora|horas|d|dia|dias)$/i.exec(String(text || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith('s')) return n * 1000;
  if (unit.startsWith('m')) return n * 60_000;
  if (unit.startsWith('h')) return n * 3_600_000;
  return n * 86_400_000;
}

const dateBR = (ts) => new Date(ts).toLocaleString('pt-BR');

const commands = [
  {
    name: 'ajuda',
    aliases: ['help', 'comandos', 'commands'],
    description: 'Mostra todos os comandos disponiveis',
    usage: 'ajuda [comando]',
    run(ctx) {
      const { bot, prefix, args } = ctx;

      if (args[0]) {
        const cmd = bot.commands.get(args[0].toLowerCase()) || bot.commands.get(bot.aliases.get(args[0].toLowerCase()));
        if (!cmd) return ctx.reply('', ctx.embed({ color: ctx.COLORS.err, description: `Comando \`${args[0]}\` nao existe.` }));
        return ctx.reply('', ctx.embed({
          title: `${prefix}${cmd.name}`,
          description: cmd.description,
          fields: [
            { name: 'Uso', value: `\`${prefix}${cmd.usage || cmd.name}\``, inline: true },
            { name: 'Categoria', value: cmd.category, inline: true },
            { name: 'Aliases', value: (cmd.aliases || []).map((a) => `\`${a}\``).join(', ') || '—', inline: true },
            ...(cmd.permission ? [{ name: 'Permissao', value: cmd.permission, inline: true }] : [])
          ]
        }));
      }

      const byCategory = new Map();
      for (const cmd of bot.commands.values()) {
        if (!byCategory.has(cmd.category)) byCategory.set(cmd.category, []);
        byCategory.get(cmd.category).push(cmd.name);
      }

      const fields = [...byCategory.entries()].map(([category, names]) => ({
        name: category,
        value: names.sort().map((n) => `\`${prefix}${n}\``).join(' ')
      }));

      return ctx.reply('', ctx.embed({
        title: '🤖 Central de comandos do Nexy',
        description: `Prefixo deste servidor: \`${prefix}\`\nUse \`${prefix}ajuda <comando>\` para detalhes.`,
        fields,
        footer: `${bot.commands.size} comandos disponiveis`
      }));
    }
  },
  {
    name: 'ping',
    description: 'Testa se o bot esta respondendo',
    run(ctx) {
      const latency = Date.now() - ctx.message.createdAt;
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.ok, description: `🏓 Pong! Respondi em **${latency}ms**.` }));
    }
  },
  {
    name: 'uptime',
    aliases: ['online'],
    description: 'Ha quanto tempo o bot esta no ar',
    run(ctx) {
      return ctx.reply('', ctx.embed({ description: `⏱️ Estou online ha **${humanDuration(Date.now() - START)}**.` }));
    }
  },
  {
    name: 'avatar',
    aliases: ['av'],
    description: 'Mostra o avatar de um usuario',
    usage: 'avatar [@usuario]',
    run(ctx) {
      const target = ctx.argStr && ctx.guild ? store.findMemberByName(ctx.guild.id, ctx.argStr) : ctx.user;
      if (!target) return ctx.reply('', ctx.embed({ color: ctx.COLORS.err, description: 'Usuario nao encontrado.' }));
      return ctx.reply('', ctx.embed({
        color: target.avatar_color,
        title: `Avatar de ${target.username}`,
        avatarOf: store.publicUser(target)
      }));
    }
  },
  {
    name: 'userinfo',
    aliases: ['perfil', 'user'],
    description: 'Informacoes sobre um usuario',
    usage: 'userinfo [@usuario]',
    guildOnly: true,
    run(ctx) {
      const target = ctx.argStr ? store.findMemberByName(ctx.guild.id, ctx.argStr) : ctx.user;
      if (!target) return ctx.reply('', ctx.embed({ color: ctx.COLORS.err, description: 'Usuario nao encontrado.' }));
      const member = store.getMember(ctx.guild.id, target.id);
      const warns = get('SELECT COUNT(*) AS n FROM warns WHERE guild_id = ? AND user_id = ?', ctx.guild.id, target.id)?.n ?? 0;
      return ctx.reply('', ctx.embed({
        color: target.avatar_color,
        title: `${target.username}#${target.tag}`,
        avatarOf: store.publicUser(target),
        fields: [
          { name: 'Cargo', value: member?.role ?? 'nao e membro', inline: true },
          { name: 'Nivel', value: String(member?.level ?? 0), inline: true },
          { name: 'Moedas', value: `${(member?.coins ?? 0).toLocaleString('pt-BR')} 🪙`, inline: true },
          { name: 'Entrou em', value: member ? dateBR(member.joined_at) : '—', inline: true },
          { name: 'Conta criada', value: dateBR(target.created_at), inline: true },
          { name: 'Advertencias', value: String(warns), inline: true },
          ...(target.bio ? [{ name: 'Sobre', value: target.bio }] : [])
        ]
      }));
    }
  },
  {
    name: 'serverinfo',
    aliases: ['servidor', 'guild'],
    description: 'Informacoes sobre o servidor',
    guildOnly: true,
    run(ctx) {
      const g = ctx.guild;
      const members = store.listMembers(g.id);
      const channels = store.listChannels(g.id);
      const owner = store.getUser(g.owner_id);
      return ctx.reply('', ctx.embed({
        color: g.icon_color,
        title: g.name,
        fields: [
          { name: 'Dono', value: owner ? `${owner.username}#${owner.tag}` : '—', inline: true },
          { name: 'Membros', value: String(members.length), inline: true },
          { name: 'Online', value: String(members.filter((m) => m.status !== 'offline').length), inline: true },
          { name: 'Canais de texto', value: String(channels.filter((c) => c.type === 'text').length), inline: true },
          { name: 'Canais de voz', value: String(channels.filter((c) => c.type === 'voice').length), inline: true },
          { name: 'Criado em', value: dateBR(g.created_at), inline: true },
          { name: 'Convite', value: `\`${g.invite_code}\`` }
        ]
      }));
    }
  },
  {
    name: 'convite',
    aliases: ['invite'],
    description: 'Mostra o codigo de convite do servidor',
    guildOnly: true,
    run(ctx) {
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.ok,
        title: '🔗 Convite do servidor',
        description: `Compartilhe este codigo: \`${ctx.guild.invite_code}\``
      }));
    }
  },
  {
    name: 'enquete',
    aliases: ['poll'],
    description: 'Cria uma enquete com ate 5 opcoes',
    usage: 'enquete Pergunta? | opcao 1 | opcao 2',
    guildOnly: true,
    run(ctx) {
      const parts = ctx.argStr.split('|').map((p) => p.trim()).filter(Boolean);
      if (parts.length < 3) {
        return ctx.reply('', ctx.embed({
          color: ctx.COLORS.err,
          description: `Use: \`${ctx.prefix}enquete Qual o melhor jogo? | Valorant | CS2\``
        }));
      }
      const question = parts[0];
      const options = parts.slice(1, 6);
      const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

      const msg = ctx.reply('', ctx.embed({
        color: ctx.COLORS.info,
        title: `📊 ${question}`,
        description: options.map((o, i) => `${emojis[i]} ${o}`).join('\n'),
        footer: `Enquete criada por ${ctx.user.username} — reaja para votar`,
        poll: { options, emojis: emojis.slice(0, options.length) }
      }));

      run('INSERT INTO polls (message_id, channel_id, question, options) VALUES (?, ?, ?, ?)',
        msg.id, ctx.channel.id, question, JSON.stringify(options));
      return msg;
    }
  },
  {
    name: 'lembrete',
    aliases: ['remind', 'lembrar'],
    description: 'Cria um lembrete',
    usage: 'lembrete 10m tomar agua',
    run(ctx) {
      const [durationText, ...rest] = ctx.args;
      const ms = parseDuration(durationText);
      const text = rest.join(' ');
      if (!ms || !text) {
        return ctx.reply('', ctx.embed({
          color: ctx.COLORS.err,
          description: `Use: \`${ctx.prefix}lembrete 10m tomar agua\` (s, m, h ou d)`
        }));
      }
      run('INSERT INTO reminders (id, user_id, channel_id, text, remind_at) VALUES (?, ?, ?, ?, ?)',
        newId(), ctx.user.id, ctx.channel.id, text, Date.now() + ms);
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.ok,
        description: `⏰ Combinado! Vou te lembrar em **${humanDuration(ms)}**: ${text}`
      }));
    }
  },
  {
    name: 'calc',
    aliases: ['calcular', 'math'],
    description: 'Calculadora simples',
    usage: 'calc 2 + 2 * 10',
    run(ctx) {
      const expr = ctx.argStr.replace(/[^0-9+\-*/(). %]/g, '');
      if (!expr.trim()) return ctx.reply('Me passe uma conta, ex: `!calc 12 * (3 + 4)`');
      try {
        // eslint-disable-next-line no-new-func
        const result = Function(`"use strict"; return (${expr});`)();
        if (typeof result !== 'number' || !Number.isFinite(result)) throw new Error('resultado invalido');
        return ctx.reply('', ctx.embed({ color: ctx.COLORS.ok, description: `🧮 \`${expr}\` = **${result}**` }));
      } catch {
        return ctx.reply('', ctx.embed({ color: ctx.COLORS.err, description: 'Nao consegui calcular essa expressao.' }));
      }
    }
  },
  {
    name: 'escolher',
    aliases: ['choose', 'pick'],
    description: 'Escolhe uma opcao entre varias',
    usage: 'escolher pizza | hamburguer | sushi',
    run(ctx) {
      const options = ctx.argStr.split('|').map((s) => s.trim()).filter(Boolean);
      if (options.length < 2) return ctx.reply('Me de pelo menos duas opcoes separadas por `|`.');
      const choice = options[Math.floor(Math.random() * options.length)];
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.brand, description: `🤔 Eu escolho: **${choice}**` }));
    }
  },
  {
    name: 'dado',
    aliases: ['roll', 'rolar'],
    description: 'Rola um dado (padrao d6)',
    usage: 'dado [lados]',
    run(ctx) {
      const sides = Math.min(Math.max(parseInt(ctx.args[0], 10) || 6, 2), 1000);
      const value = 1 + Math.floor(Math.random() * sides);
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.brand, description: `🎲 d${sides} → **${value}**` }));
    }
  },
  {
    name: 'sorteio',
    aliases: ['giveaway', 'sortear'],
    description: 'Sorteia um membro do servidor',
    usage: 'sorteio [premio]',
    guildOnly: true,
    run(ctx) {
      const members = store.listMembers(ctx.guild.id).filter((m) => !m.isBot);
      if (!members.length) return ctx.reply('Nao ha membros para sortear.');
      const winner = members[Math.floor(Math.random() * members.length)];
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.gold,
        title: '🎉 Sorteio!',
        description: `Entre **${members.length}** participantes, o vencedor e...\n\n### 🏆 ${winner.displayName}`,
        footer: ctx.argStr ? `Premio: ${ctx.argStr}` : null
      }));
    }
  },
  {
    name: 'membros',
    aliases: ['membercount'],
    description: 'Quantos membros o servidor tem',
    guildOnly: true,
    run(ctx) {
      const members = store.listMembers(ctx.guild.id);
      const online = members.filter((m) => m.status !== 'offline').length;
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.info,
        description: `👥 **${members.length}** membros · 🟢 **${online}** online`
      }));
    }
  },
  {
    name: 'dizer',
    aliases: ['say', 'falar'],
    description: 'Faz o bot repetir uma mensagem',
    usage: 'dizer texto',
    permission: 'mod',
    run(ctx) {
      if (!ctx.argStr) return ctx.reply('O que devo dizer?');
      store.deleteMessage(ctx.message.id);
      if (ctx.bot.deliver) ctx.bot.deliver({ __deleted: true, id: ctx.message.id, channelId: ctx.channel.id });
      return ctx.reply(ctx.argStr);
    }
  },
  {
    name: 'embed',
    description: 'Cria um embed personalizado',
    usage: 'embed Titulo | Descricao',
    permission: 'mod',
    run(ctx) {
      const [title, ...rest] = ctx.argStr.split('|').map((s) => s.trim());
      if (!title) return ctx.reply('Use: `!embed Titulo | Descricao`');
      return ctx.reply('', ctx.embed({ title, description: rest.join(' | ') || null, color: ctx.COLORS.brand }));
    }
  }
];

module.exports = { category: 'Utilidades', commands, humanDuration, parseDuration };
