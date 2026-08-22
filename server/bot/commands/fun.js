'use strict';

const store = require('../../store');
const { all, get, run } = require('../../db');

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const EIGHT_BALL = [
  'Com certeza.', 'Sem duvidas.', 'Pode apostar.', 'Provavelmente sim.', 'Os sinais apontam que sim.',
  'Melhor nao te contar agora.', 'Pergunte de novo mais tarde.', 'Nao conto com isso.',
  'Minha resposta e nao.', 'Muito duvidoso.', 'Definitivamente nao.', 'Talvez... depende de voce.'
];

const JOKES = [
  'Por que o programador foi ao terapeuta? Ele tinha muitos problemas nao resolvidos.',
  'O que o zero disse pro oito? Belo cinto!',
  'Fui num cafe que so servia expresso. Foi rapidinho.',
  'Meu wifi caiu e eu tive que falar com a familia. Pessoas legais, aliás.',
  'Existem 10 tipos de pessoas: as que entendem binario e as que nao.',
  'Chamei o suporte e disseram para desligar e ligar. Funcionou. Odeio quando funciona.',
  'A call de 5 minutos durou 2 horas. Classico.',
  'Meu codigo funcionou de primeira. Fiquei desconfiado o dia inteiro.'
];

const QUOTES = [
  '"O melhor momento para comecar foi ontem. O segundo melhor e agora."',
  '"Feito e melhor que perfeito."',
  '"Voce nao precisa ser incrivel para comecar, mas precisa comecar para ser incrivel."',
  '"Disciplina e escolher entre o que voce quer agora e o que voce mais quer."',
  '"Pequenos progressos diarios geram resultados enormes."'
];

const TRIVIA = [
  { q: 'Qual e o maior planeta do Sistema Solar?', options: ['Terra', 'Jupiter', 'Saturno', 'Marte'], answer: 1 },
  { q: 'Em que ano o Brasil ganhou o penta?', options: ['1994', '1998', '2002', '2006'], answer: 2 },
  { q: 'Qual linguagem roda nativamente no navegador?', options: ['Python', 'JavaScript', 'C#', 'Go'], answer: 1 },
  { q: 'Quantos lados tem um hexagono?', options: ['5', '6', '7', '8'], answer: 1 },
  { q: 'Qual e a capital da Australia?', options: ['Sydney', 'Melbourne', 'Camberra', 'Perth'], answer: 2 },
  { q: 'Quem pintou a Mona Lisa?', options: ['Van Gogh', 'Picasso', 'Da Vinci', 'Monet'], answer: 2 },
  { q: 'Qual o menor numero primo?', options: ['0', '1', '2', '3'], answer: 2 },
  { q: 'Qual protocolo o HTTPS usa para criptografia?', options: ['SSH', 'TLS', 'FTP', 'SMTP'], answer: 1 }
];

/** Resposta simples quando alguem chama o bot pelo nome. */
function smallTalk(text, user) {
  const t = text.toLowerCase();
  if (/\b(oi|ola|olá|eai|e ai|bom dia|boa tarde|boa noite)\b/.test(t)) {
    return pick([
      `Oi, ${user.username}! Precisa de alguma coisa? Digite \`!ajuda\`.`,
      `E ai, ${user.username}! Bora usar \`!ajuda\` pra ver o que eu faco.`,
      `Ola! Estou aqui 24/7. Tenta \`!ajuda\`.`
    ]);
  }
  if (/(tudo bem|como voce esta|como vai)/.test(t)) {
    return `Rodando liso por aqui, ${user.username}. E voce?`;
  }
  if (/(obrigad|valeu|vlw)/.test(t)) return pick(['Disponha! 😄', 'Sempre as ordens.', 'Por nada!']);
  if (/(quem e voce|quem é você|o que voce faz)/.test(t)) {
    return 'Sou o **Nexy**, o bot que ja vem embutido no nexus67. Moderacao, economia, niveis, musica e diversao — tudo em `!ajuda`.';
  }
  if (/\?$/.test(t.trim())) return pick(EIGHT_BALL);
  return null;
}

const commands = [
  {
    name: '8ball',
    aliases: ['bola8', 'pergunta'],
    description: 'A bola magica responde sua pergunta',
    usage: '8ball vou passar na prova?',
    run(ctx) {
      if (!ctx.argStr) return ctx.reply('Faz a pergunta! Ex: `!8ball vou ficar rico?`');
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.brand,
        title: '🎱 Bola magica',
        fields: [{ name: 'Pergunta', value: ctx.argStr }, { name: 'Resposta', value: pick(EIGHT_BALL) }]
      }));
    }
  },
  {
    name: 'piada',
    aliases: ['joke'],
    description: 'Conta uma piada',
    run(ctx) {
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.gold, description: `😄 ${pick(JOKES)}` }));
    }
  },
  {
    name: 'frase',
    aliases: ['quote', 'motivacao'],
    description: 'Uma frase motivacional',
    run(ctx) {
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.info, description: `💡 ${pick(QUOTES)}` }));
    }
  },
  {
    name: 'ship',
    description: 'Calcula a compatibilidade entre duas pessoas',
    usage: 'ship @a @b',
    guildOnly: true,
    run(ctx) {
      const [a, b] = ctx.argStr.split(/\s+/);
      const ua = a ? store.findMemberByName(ctx.guild.id, a) : ctx.user;
      const ub = b ? store.findMemberByName(ctx.guild.id, b) : null;
      if (!ua || !ub) return ctx.reply('Use: `!ship @pessoa1 @pessoa2`');

      const seed = [ua.id, ub.id].sort().join('');
      let hash = 0;
      for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) % 101;
      const bar = '█'.repeat(Math.round(hash / 10)) + '░'.repeat(10 - Math.round(hash / 10));
      const verdict = hash > 85 ? 'Casem logo! 💍' : hash > 60 ? 'Tem quimica aqui 👀' : hash > 35 ? 'Da pra tentar...' : 'Melhor ficarem amigos 😅';

      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.pink,
        title: '💘 Shippometro',
        description: `**${ua.username}** 💞 **${ub.username}**\n\n\`${bar}\` **${hash}%**\n\n${verdict}`,
        footer: `Nome do ship: ${ua.username.slice(0, Math.ceil(ua.username.length / 2))}${ub.username.slice(Math.floor(ub.username.length / 2))}`
      }));
    }
  },
  {
    name: 'casar',
    aliases: ['marry'],
    description: 'Casa com outro membro do servidor',
    usage: 'casar @usuario',
    guildOnly: true,
    run(ctx) {
      const target = store.findMemberByName(ctx.guild.id, ctx.argStr);
      if (!target || target.id === ctx.user.id) return ctx.reply('Escolha alguem para casar. 💍');
      const mine = get('SELECT * FROM marriages WHERE guild_id = ? AND user_a = ?', ctx.guild.id, ctx.user.id);
      if (mine) return ctx.reply('Voce ja esta casado(a)! Use `!divorciar` primeiro.');
      const theirs = get('SELECT * FROM marriages WHERE guild_id = ? AND user_a = ?', ctx.guild.id, target.id);
      if (theirs) return ctx.reply(`**${target.username}** ja esta comprometido(a).`);

      run('INSERT INTO marriages (guild_id, user_a, user_b, since) VALUES (?, ?, ?, ?)', ctx.guild.id, ctx.user.id, target.id, Date.now());
      run('INSERT INTO marriages (guild_id, user_a, user_b, since) VALUES (?, ?, ?, ?)', ctx.guild.id, target.id, ctx.user.id, Date.now());
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.pink,
        title: '💒 Que comecem os votos!',
        description: `**${ctx.user.username}** e **${target.username}** agora estao casados!`
      }));
    }
  },
  {
    name: 'divorciar',
    aliases: ['divorce'],
    description: 'Termina seu casamento',
    guildOnly: true,
    run(ctx) {
      const mine = get('SELECT * FROM marriages WHERE guild_id = ? AND user_a = ?', ctx.guild.id, ctx.user.id);
      if (!mine) return ctx.reply('Voce nao esta casado(a).');
      run('DELETE FROM marriages WHERE guild_id = ? AND (user_a = ? OR user_a = ?)', ctx.guild.id, mine.user_a, mine.user_b);
      const other = store.getUser(mine.user_b);
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.err,
        description: `💔 **${ctx.user.username}** e **${other?.username ?? '???'}** se divorciaram.`
      }));
    }
  },
  {
    name: 'ppt',
    aliases: ['jokenpo', 'rps'],
    description: 'Pedra, papel ou tesoura contra o bot',
    usage: 'ppt pedra',
    run(ctx) {
      const map = { pedra: '🪨', papel: '📄', tesoura: '✂️' };
      const mine = ctx.argStr.trim().toLowerCase();
      if (!map[mine]) return ctx.reply('Escolha `pedra`, `papel` ou `tesoura`.');
      const botChoice = pick(Object.keys(map));
      const wins = { pedra: 'tesoura', papel: 'pedra', tesoura: 'papel' };
      const result = mine === botChoice ? 'Empate!' : wins[mine] === botChoice ? 'Voce venceu! 🎉' : 'Eu venci! 😎';
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.brand,
        title: '✊ Pedra, papel e tesoura',
        description: `Voce: ${map[mine]}  ×  Eu: ${map[botChoice]}\n\n**${result}**`
      }));
    }
  },
  {
    name: 'quiz',
    aliases: ['trivia'],
    description: 'Inicia uma pergunta de trivia (responda com !responder)',
    guildOnly: true,
    run(ctx) {
      if (ctx.bot.games.has(ctx.channel.id)) {
        return ctx.reply('Ja tem um quiz rolando neste canal! Responda com `!responder <numero>`.');
      }
      const question = pick(TRIVIA);
      ctx.bot.games.set(ctx.channel.id, { type: 'trivia', question, startedAt: Date.now() });
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.info,
        title: '🧠 Quiz!',
        description: `**${question.q}**\n\n${question.options.map((o, i) => `**${i + 1}.** ${o}`).join('\n')}`,
        footer: `Responda com ${ctx.prefix}responder <numero> — vale 200 moedas`
      }));
    }
  },
  {
    name: 'responder',
    aliases: ['r'],
    description: 'Responde o quiz ativo no canal',
    usage: 'responder 2',
    guildOnly: true,
    run(ctx) {
      const game = ctx.bot.games.get(ctx.channel.id);
      if (!game || game.type !== 'trivia') return ctx.reply(`Nao ha quiz ativo. Inicie com \`${ctx.prefix}quiz\`.`);
      const answer = parseInt(ctx.args[0], 10) - 1;
      if (!Number.isInteger(answer)) return ctx.reply('Responda com o numero da opcao.');

      if (answer === game.question.answer) {
        ctx.bot.games.delete(ctx.channel.id);
        run('UPDATE guild_members SET coins = coins + 200 WHERE guild_id = ? AND user_id = ?', ctx.guild.id, ctx.user.id);
        return ctx.reply('', ctx.embed({
          color: ctx.COLORS.ok,
          title: '✅ Resposta correta!',
          description: `**${ctx.user.username}** acertou: **${game.question.options[game.question.answer]}**\n+200 moedas 🪙`
        }));
      }
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.err, description: `❌ Nao e essa, **${ctx.user.username}**. Tente de novo!` }));
    }
  },
  {
    name: 'abracar',
    aliases: ['hug'],
    description: 'Abraca alguem',
    usage: 'abracar @usuario',
    guildOnly: true,
    run(ctx) {
      const target = store.findMemberByName(ctx.guild.id, ctx.argStr);
      if (!target) return ctx.reply('Quem voce quer abracar?');
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.pink,
        description: `🤗 **${ctx.user.username}** deu um abraco apertado em **${target.username}**!`
      }));
    }
  },
  {
    name: 'tapa',
    aliases: ['slap'],
    description: 'Da um tapa (de brincadeira) em alguem',
    usage: 'tapa @usuario',
    guildOnly: true,
    run(ctx) {
      const target = store.findMemberByName(ctx.guild.id, ctx.argStr);
      if (!target) return ctx.reply('Em quem?');
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.warn,
        description: `👋 **${ctx.user.username}** deu um tapa em **${target.username}** com uma truta gigante!`
      }));
    }
  },
  {
    name: 'roleta',
    aliases: ['roulette'],
    description: 'Roleta russa (so diversao, ninguem sai do servidor)',
    guildOnly: true,
    run(ctx) {
      const died = Math.random() < 1 / 6;
      return ctx.reply('', ctx.embed({
        color: died ? ctx.COLORS.err : ctx.COLORS.ok,
        title: '🔫 Roleta russa',
        description: died
          ? `💥 **BANG!** ${ctx.user.username} nao teve sorte dessa vez.`
          : `😌 *click* — ${ctx.user.username} sobreviveu.`
      }));
    }
  },
  {
    name: 'gado',
    aliases: ['gadometro'],
    description: 'Mede o nivel de gado de alguem',
    usage: 'gado [@usuario]',
    guildOnly: true,
    run(ctx) {
      const target = ctx.argStr ? store.findMemberByName(ctx.guild.id, ctx.argStr) : ctx.user;
      if (!target) return ctx.reply('Usuario nao encontrado.');
      let hash = 0;
      for (const ch of target.id + 'gado') hash = (hash * 17 + ch.charCodeAt(0)) % 101;
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.pink,
        title: '🐄 Gadometro 3000',
        description: `**${target.username}** e **${hash}%** gado.\n\`${'█'.repeat(Math.round(hash / 10))}${'░'.repeat(10 - Math.round(hash / 10))}\``
      }));
    }
  },
  {
    name: 'ascii',
    description: 'Transforma seu texto em destaque',
    usage: 'ascii texto',
    run(ctx) {
      if (!ctx.argStr) return ctx.reply('Escreva algo depois do comando.');
      return ctx.reply(`# ${ctx.argStr.slice(0, 60)}`);
    }
  }
];

module.exports = { category: 'Diversao', commands, smallTalk };
