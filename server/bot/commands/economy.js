'use strict';

const store = require('../../store');
const { all, get, run } = require('../../db');

const DAY = 86_400_000;
const HOUR = 3_600_000;

const SHOP = [
  { id: 'cafe', name: '☕ Café', price: 50, description: 'Restaura o animo depois de uma call longa' },
  { id: 'pizza', name: '🍕 Pizza', price: 150, description: 'Compartilhe com o servidor' },
  { id: 'headset', name: '🎧 Headset gamer', price: 1200, description: 'Audio nitido nas calls' },
  { id: 'webcam', name: '📷 Webcam 4K', price: 2500, description: 'Sua camera em alta definicao' },
  { id: 'coroa', name: '👑 Coroa', price: 10000, description: 'Status maximo no servidor' },
  { id: 'foguete', name: '🚀 Foguete', price: 50000, description: 'Para quem quebrou a economia' }
];

const fmt = (n) => Number(n).toLocaleString('pt-BR');

async function member(ctx, userId = ctx.user.id) {
  const m = await store.getMember(ctx.guild.id, userId);
  if (!m) throw new Error('Membro nao encontrado neste servidor.');
  return m;
}

async function addCoins(guildId, userId, amount) {
  await run('UPDATE guild_members SET coins = MAX(0, coins + ?) WHERE guild_id = ? AND user_id = ?', amount, guildId, userId);
}

function cooldownLeft(last, span) {
  const left = last + span - Date.now();
  return left > 0 ? left : 0;
}

function humanLeft(ms) {
  const h = Math.floor(ms / HOUR);
  const m = Math.floor((ms % HOUR) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

const WORK_JOBS = [
  'moderou um servidor caotico', 'consertou o microfone de um amigo', 'editou uma live',
  'fez suporte tecnico pro tio', 'programou um bot', 'entregou pizza de bike',
  'ganhou um campeonato interno', 'desenhou o banner do servidor'
];

const CRIMES = [
  'invadiu o cofre de moedas', 'roubou o headset do streamer', 'vendeu emoji pirata',
  'clonou convites premium', 'desviou moedas do sorteio'
];

const commands = [
  {
    name: 'saldo',
    aliases: ['balance', 'bal', 'carteira', 'atm'],
    description: 'Mostra suas moedas',
    usage: 'saldo [@usuario]',
    guildOnly: true,
    async run(ctx) {
      const target = ctx.argStr ? await store.findMemberByName(ctx.guild.id, ctx.argStr) : ctx.user;
      if (!target) return ctx.reply('Usuario nao encontrado.');
      const m = await member(ctx, target.id);
      const rank = (await get(
        'SELECT COUNT(*) + 1 AS pos FROM guild_members WHERE guild_id = ? AND (coins + bank) > ?',
        ctx.guild.id, m.coins + m.bank
      )).pos;
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.gold,
        title: `💰 Carteira de ${target.username}`,
        fields: [
          { name: 'Na mao', value: `${fmt(m.coins)} 🪙`, inline: true },
          { name: 'No banco', value: `${fmt(m.bank)} 🏦`, inline: true },
          { name: 'Total', value: `${fmt(m.coins + m.bank)}`, inline: true }
        ],
        footer: `Posicao #${rank} no ranking do servidor`
      }));
    }
  },
  {
    name: 'daily',
    aliases: ['diario'],
    description: 'Recompensa diaria de moedas',
    guildOnly: true,
    async run(ctx) {
      const m = await member(ctx);
      const left = cooldownLeft(m.last_daily, DAY);
      if (left) {
        return ctx.reply('', ctx.embed({
          color: ctx.COLORS.warn,
          description: `⏳ Voce ja pegou o diario. Volte em **${humanLeft(left)}**.`
        }));
      }
      const amount = 500 + Math.floor(Math.random() * 500) + m.level * 20;
      await run('UPDATE guild_members SET coins = coins + ?, last_daily = ? WHERE guild_id = ? AND user_id = ?',
        amount, Date.now(), ctx.guild.id, ctx.user.id);
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.ok,
        title: '🎁 Recompensa diaria',
        description: `Voce recebeu **${fmt(amount)}** moedas!`,
        footer: 'Volte em 24 horas'
      }));
    }
  },
  {
    name: 'trabalhar',
    aliases: ['work'],
    description: 'Trabalha para ganhar moedas (1h de cooldown)',
    guildOnly: true,
    async run(ctx) {
      const m = await member(ctx);
      const left = cooldownLeft(m.last_work, HOUR);
      if (left) {
        return ctx.reply('', ctx.embed({ color: ctx.COLORS.warn, description: `😴 Descanse um pouco. Volte em **${humanLeft(left)}**.` }));
      }
      const amount = 120 + Math.floor(Math.random() * 380);
      await run('UPDATE guild_members SET coins = coins + ?, last_work = ? WHERE guild_id = ? AND user_id = ?',
        amount, Date.now(), ctx.guild.id, ctx.user.id);
      const job = WORK_JOBS[Math.floor(Math.random() * WORK_JOBS.length)];
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.ok,
        description: `💼 Voce ${job} e ganhou **${fmt(amount)}** moedas.`
      }));
    }
  },
  {
    name: 'crime',
    description: 'Arrisca tudo por moedas (pode dar errado)',
    guildOnly: true,
    async run(ctx) {
      const m = await member(ctx);
      const left = cooldownLeft(m.last_crime, 2 * HOUR);
      if (left) {
        return ctx.reply('', ctx.embed({ color: ctx.COLORS.warn, description: `🚔 A policia ainda te procura. Volte em **${humanLeft(left)}**.` }));
      }
      await run('UPDATE guild_members SET last_crime = ? WHERE guild_id = ? AND user_id = ?', Date.now(), ctx.guild.id, ctx.user.id);
      const crime = CRIMES[Math.floor(Math.random() * CRIMES.length)];
      const success = Math.random() < 0.55;
      if (success) {
        const amount = 400 + Math.floor(Math.random() * 1600);
        await addCoins(ctx.guild.id, ctx.user.id, amount);
        return ctx.reply('', ctx.embed({
          color: ctx.COLORS.ok,
          title: '🕵️ Crime bem-sucedido',
          description: `Voce ${crime} e levou **${fmt(amount)}** moedas.`
        }));
      }
      const fine = Math.min(m.coins, 200 + Math.floor(Math.random() * 800));
      await addCoins(ctx.guild.id, ctx.user.id, -fine);
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.err,
        title: '🚨 Voce foi pego!',
        description: `Tentou ${crime} e pagou **${fmt(fine)}** moedas de multa.`
      }));
    }
  },
  {
    name: 'pagar',
    aliases: ['pay', 'transferir'],
    description: 'Transfere moedas para outro membro',
    usage: 'pagar @usuario 500',
    guildOnly: true,
    async run(ctx) {
      const [name, amountRaw] = ctx.args;
      const amount = parseInt(amountRaw, 10);
      const target = await store.findMemberByName(ctx.guild.id, name);
      if (!target) return ctx.reply('Usuario nao encontrado.');
      if (target.id === ctx.user.id) return ctx.reply('Transferir para si mesmo nao vale. 🙂');
      if (!Number.isFinite(amount) || amount <= 0) return ctx.reply('Informe um valor valido: `!pagar @user 500`');
      const m = await member(ctx);
      if (m.coins < amount) return ctx.reply('', ctx.embed({ color: ctx.COLORS.err, description: `Voce so tem **${fmt(m.coins)}** moedas na mao.` }));
      await addCoins(ctx.guild.id, ctx.user.id, -amount);
      await addCoins(ctx.guild.id, target.id, amount);
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.ok,
        description: `💸 **${ctx.user.username}** transferiu **${fmt(amount)}** moedas para **${target.username}**.`
      }));
    }
  },
  {
    name: 'depositar',
    aliases: ['dep', 'deposit'],
    description: 'Guarda moedas no banco (protege de roubos)',
    usage: 'depositar 1000 | depositar tudo',
    guildOnly: true,
    async run(ctx) {
      const m = await member(ctx);
      const raw = ctx.args[0];
      const amount = /^(tudo|all)$/i.test(raw || '') ? m.coins : parseInt(raw, 10);
      if (!Number.isFinite(amount) || amount <= 0 || amount > m.coins) return ctx.reply('Valor invalido.');
      await run('UPDATE guild_members SET coins = coins - ?, bank = bank + ? WHERE guild_id = ? AND user_id = ?',
        amount, amount, ctx.guild.id, ctx.user.id);
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.ok, description: `🏦 **${fmt(amount)}** moedas depositadas.` }));
    }
  },
  {
    name: 'sacar',
    aliases: ['withdraw', 'saque'],
    description: 'Retira moedas do banco',
    usage: 'sacar 1000 | sacar tudo',
    guildOnly: true,
    async run(ctx) {
      const m = await member(ctx);
      const raw = ctx.args[0];
      const amount = /^(tudo|all)$/i.test(raw || '') ? m.bank : parseInt(raw, 10);
      if (!Number.isFinite(amount) || amount <= 0 || amount > m.bank) return ctx.reply('Valor invalido.');
      await run('UPDATE guild_members SET coins = coins + ?, bank = bank - ? WHERE guild_id = ? AND user_id = ?',
        amount, amount, ctx.guild.id, ctx.user.id);
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.ok, description: `💵 **${fmt(amount)}** moedas sacadas.` }));
    }
  },
  {
    name: 'roubar',
    aliases: ['rob'],
    description: 'Tenta roubar moedas de outro membro',
    usage: 'roubar @usuario',
    guildOnly: true,
    async run(ctx) {
      const target = await store.findMemberByName(ctx.guild.id, ctx.argStr);
      if (!target || target.id === ctx.user.id) return ctx.reply('Escolha outro membro para roubar.');
      const victim = await store.getMember(ctx.guild.id, target.id);
      const me = await member(ctx);
      if (victim.coins < 100) return ctx.reply('Essa pessoa nao tem moedas na mao. Tente outra vitima.');
      if (me.coins < 100) return ctx.reply('Voce precisa de pelo menos 100 moedas para arriscar um roubo.');

      if (Math.random() < 0.45) {
        const stolen = Math.floor(victim.coins * (0.1 + Math.random() * 0.3));
        await addCoins(ctx.guild.id, target.id, -stolen);
        await addCoins(ctx.guild.id, ctx.user.id, stolen);
        return ctx.reply('', ctx.embed({
          color: ctx.COLORS.ok,
          title: '🥷 Roubo bem-sucedido',
          description: `Voce levou **${fmt(stolen)}** moedas de **${target.username}**.`
        }));
      }
      const fine = Math.floor(me.coins * 0.15);
      await addCoins(ctx.guild.id, ctx.user.id, -fine);
      await addCoins(ctx.guild.id, target.id, fine);
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.err,
        title: '🚨 Roubo fracassado',
        description: `**${target.username}** te pegou e ficou com **${fmt(fine)}** das suas moedas.`
      }));
    }
  },
  {
    name: 'loja',
    aliases: ['shop'],
    description: 'Mostra os itens a venda',
    guildOnly: true,
    run(ctx) {
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.gold,
        title: '🛒 Loja do PlingChat',
        description: SHOP.map((i) => `**${i.name}** — ${fmt(i.price)} 🪙\n\`${i.id}\` · ${i.description}`).join('\n\n'),
        footer: `Compre com ${ctx.prefix}comprar <id>`
      }));
    }
  },
  {
    name: 'comprar',
    aliases: ['buy'],
    description: 'Compra um item da loja',
    usage: 'comprar cafe',
    guildOnly: true,
    async run(ctx) {
      const item = SHOP.find((i) => i.id === ctx.argStr.trim().toLowerCase());
      if (!item) return ctx.reply(`Item nao encontrado. Veja \`${ctx.prefix}loja\`.`);
      const m = await member(ctx);
      if (m.coins < item.price) {
        return ctx.reply('', ctx.embed({
          color: ctx.COLORS.err,
          description: `Faltam **${fmt(item.price - m.coins)}** moedas para comprar ${item.name}.`
        }));
      }
      await addCoins(ctx.guild.id, ctx.user.id, -item.price);
      await run(
        `INSERT INTO inventory (guild_id, user_id, item_id, qty) VALUES (?, ?, ?, 1)
         ON CONFLICT(guild_id, user_id, item_id) DO UPDATE SET qty = qty + 1`,
        ctx.guild.id, ctx.user.id, item.id
      );
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.ok,
        title: '🛍️ Compra concluida',
        description: `Voce comprou **${item.name}** por ${fmt(item.price)} moedas.`
      }));
    }
  },
  {
    name: 'inventario',
    aliases: ['inv', 'mochila'],
    description: 'Mostra seus itens',
    guildOnly: true,
    async run(ctx) {
      const rows = await all('SELECT * FROM inventory WHERE guild_id = ? AND user_id = ? AND qty > 0', ctx.guild.id, ctx.user.id);
      if (!rows.length) return ctx.reply('', ctx.embed({ description: '🎒 Sua mochila esta vazia.' }));
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.brand,
        title: `🎒 Inventario de ${ctx.user.username}`,
        description: rows.map((r) => {
          const item = SHOP.find((i) => i.id === r.item_id);
          return `${item ? item.name : r.item_id} × **${r.qty}**`;
        }).join('\n')
      }));
    }
  },
  {
    name: 'ranking',
    aliases: ['rich', 'top-moedas', 'ricos'],
    description: 'Ranking de moedas do servidor',
    guildOnly: true,
    async run(ctx) {
      const rows = await all(
        `SELECT u.username, m.coins + m.bank AS total FROM guild_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.guild_id = ? AND u.is_bot = 0
         ORDER BY total DESC LIMIT 10`, ctx.guild.id
      );
      const medals = ['🥇', '🥈', '🥉'];
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.gold,
        title: '💰 Ranking de riqueza',
        description: rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} ${r.username} — ${fmt(r.total)} 🪙`).join('\n') || 'Ninguem tem moedas ainda.'
      }));
    }
  },
  {
    name: 'apostar',
    aliases: ['bet', 'caracoroa'],
    description: 'Aposta moedas no cara ou coroa',
    usage: 'apostar 500 cara',
    guildOnly: true,
    async run(ctx) {
      const amount = parseInt(ctx.args[0], 10);
      const side = (ctx.args[1] || 'cara').toLowerCase();
      if (!Number.isFinite(amount) || amount <= 0) return ctx.reply('Use: `!apostar 500 cara`');
      if (!['cara', 'coroa'].includes(side)) return ctx.reply('Escolha `cara` ou `coroa`.');
      const m = await member(ctx);
      if (m.coins < amount) return ctx.reply(`Voce so tem **${fmt(m.coins)}** moedas.`);
      const result = Math.random() < 0.5 ? 'cara' : 'coroa';
      const won = result === side;
      await addCoins(ctx.guild.id, ctx.user.id, won ? amount : -amount);
      return ctx.reply('', ctx.embed({
        color: won ? ctx.COLORS.ok : ctx.COLORS.err,
        title: won ? '🪙 Voce ganhou!' : '🪙 Voce perdeu...',
        description: `Deu **${result}**. ${won ? `+${fmt(amount)}` : `-${fmt(amount)}`} moedas.`
      }));
    }
  },
  {
    name: 'slots',
    aliases: ['caca-niquel'],
    description: 'Joga no caca-niquel',
    usage: 'slots 100',
    guildOnly: true,
    async run(ctx) {
      const amount = parseInt(ctx.args[0], 10) || 100;
      const m = await member(ctx);
      if (m.coins < amount) return ctx.reply(`Voce so tem **${fmt(m.coins)}** moedas.`);
      const symbols = ['🍒', '🍋', '🍇', '🔔', '⭐', '7️⃣'];
      const roll = [0, 0, 0].map(() => symbols[Math.floor(Math.random() * symbols.length)]);
      let multiplier = 0;
      if (roll[0] === roll[1] && roll[1] === roll[2]) multiplier = roll[0] === '7️⃣' ? 10 : 5;
      else if (roll[0] === roll[1] || roll[1] === roll[2] || roll[0] === roll[2]) multiplier = 1.5;

      const delta = Math.floor(amount * multiplier) - amount;
      await addCoins(ctx.guild.id, ctx.user.id, delta);
      return ctx.reply('', ctx.embed({
        color: multiplier ? ctx.COLORS.ok : ctx.COLORS.err,
        title: '🎰 Caca-niquel',
        description: `# ${roll.join(' | ')}\n\n${multiplier ? `Multiplicador **${multiplier}x** — voce ${delta >= 0 ? 'ganhou' : 'perdeu'} **${fmt(Math.abs(delta))}** moedas.` : `Nao deu dessa vez. -${fmt(amount)} moedas.`}`
      }));
    }
  }
];

module.exports = { category: 'Economia', commands, SHOP };
