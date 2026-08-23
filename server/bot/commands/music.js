'use strict';

const store = require('../../store');

/**
 * Player de audio compartilhado. O bot nao transcodifica nada: ele mantem a
 * fila e o relogio, e os clientes conectados ao canal de voz tocam a mesma
 * faixa a partir do mesmo instante. Aceita URLs diretas de audio
 * (.mp3, .ogg, .m4a, .wav) ou streams de radio.
 */

const AUDIO_URL = /^https?:\/\/\S+$/i;

function state(ctx) {
  const { bot, guild } = ctx;
  if (!bot.music.has(guild.id)) {
    bot.music.set(guild.id, { queue: [], current: null, startedAt: 0, paused: false, voiceChannelId: null });
  }
  return bot.music.get(guild.id);
}

function broadcast(ctx) {
  const s = state(ctx);
  ctx.bot.deliver?.({
    __music: true,
    guildId: ctx.guild.id,
    payload: {
      current: s.current,
      queue: s.queue,
      startedAt: s.startedAt,
      paused: s.paused,
      voiceChannelId: s.voiceChannelId
    }
  });
}

function playNext(ctx) {
  const s = state(ctx);
  s.current = s.queue.shift() || null;
  s.startedAt = Date.now();
  s.paused = false;
  broadcast(ctx);
  if (s.current) {
    ctx.reply('', ctx.embed({
      color: ctx.COLORS.brand,
      title: '🎵 Tocando agora',
      description: `**${s.current.title}**\nPedido por ${s.current.requestedBy}`,
      music: s.current
    }));
  } else {
    ctx.reply('', ctx.embed({ color: ctx.COLORS.warn, description: '⏹️ Fila vazia. Player encerrado.' }));
  }
}

const titleFromUrl = (url) => {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return name.replace(/\.(mp3|ogg|m4a|wav|aac|flac)$/i, '').replace(/[-_]+/g, ' ') || new URL(url).hostname;
  } catch {
    return url;
  }
};

const commands = [
  {
    name: 'tocar',
    aliases: ['play', 'p'],
    description: 'Toca um audio no canal de voz (URL direta de audio ou radio)',
    usage: 'tocar https://exemplo.com/musica.mp3',
    guildOnly: true,
    async run(ctx) {
      const url = ctx.argStr.trim();
      if (!AUDIO_URL.test(url)) {
        return ctx.reply('', ctx.embed({
          color: ctx.COLORS.err,
          title: '🎵 Como usar o player',
          description: [
            `\`${ctx.prefix}tocar <url>\` — aceita links diretos de audio (.mp3, .ogg, .m4a, .wav) e streams de radio.`,
            '',
            'O bot sincroniza a reproducao entre todos que estao no canal de voz:',
            `\`${ctx.prefix}fila\` · \`${ctx.prefix}pular\` · \`${ctx.prefix}pausar\` · \`${ctx.prefix}parar\` · \`${ctx.prefix}agora\``
          ].join('\n')
        }));
      }

      const s = state(ctx);
      const channels = await store.listChannels(ctx.guild.id);
      const voice = channels.find((c) => c.type === 'voice');
      s.voiceChannelId = voice?.id ?? null;

      const track = { url, title: titleFromUrl(url), requestedBy: ctx.user.username, addedAt: Date.now() };

      if (!s.current) {
        s.queue.push(track);
        return playNext(ctx);
      }
      s.queue.push(track);
      broadcast(ctx);
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.ok,
        description: `➕ **${track.title}** adicionado a fila (posicao ${s.queue.length}).`
      }));
    }
  },
  {
    name: 'fila',
    aliases: ['queue', 'q'],
    description: 'Mostra a fila de reproducao',
    guildOnly: true,
    run(ctx) {
      const s = state(ctx);
      if (!s.current && !s.queue.length) return ctx.reply('A fila esta vazia.');
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.brand,
        title: '🎶 Fila de reproducao',
        description: [
          s.current ? `**Tocando:** ${s.current.title} — ${s.current.requestedBy}` : '_Nada tocando_',
          '',
          ...s.queue.map((t, i) => `**${i + 1}.** ${t.title} — ${t.requestedBy}`)
        ].join('\n'),
        footer: `${s.queue.length} na fila`
      }));
    }
  },
  {
    name: 'agora',
    aliases: ['np', 'nowplaying'],
    description: 'Mostra o que esta tocando',
    guildOnly: true,
    run(ctx) {
      const s = state(ctx);
      if (!s.current) return ctx.reply('Nao ha nada tocando agora.');
      const elapsed = Math.floor((Date.now() - s.startedAt) / 1000);
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.brand,
        title: '🎵 Tocando agora',
        description: `**${s.current.title}**\nPedido por ${s.current.requestedBy} · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} decorridos`,
        music: s.current
      }));
    }
  },
  {
    name: 'pular',
    aliases: ['skip', 's'],
    description: 'Pula para a proxima faixa',
    guildOnly: true,
    run(ctx) {
      const s = state(ctx);
      if (!s.current) return ctx.reply('Nao ha nada tocando.');
      ctx.reply('', ctx.embed({ color: ctx.COLORS.warn, description: `⏭️ **${s.current.title}** foi pulada.` }));
      return playNext(ctx);
    }
  },
  {
    name: 'pausar',
    aliases: ['pause', 'retomar', 'resume'],
    description: 'Pausa ou retoma a reproducao',
    guildOnly: true,
    run(ctx) {
      const s = state(ctx);
      if (!s.current) return ctx.reply('Nao ha nada tocando.');
      s.paused = !s.paused;
      broadcast(ctx);
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.info,
        description: s.paused ? '⏸️ Reproducao pausada.' : '▶️ Reproducao retomada.'
      }));
    }
  },
  {
    name: 'parar',
    aliases: ['stop'],
    description: 'Para a musica e limpa a fila',
    guildOnly: true,
    permission: 'mod',
    run(ctx) {
      const s = state(ctx);
      s.queue = [];
      s.current = null;
      s.paused = false;
      broadcast(ctx);
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.err, description: '⏹️ Player parado e fila limpa.' }));
    }
  },
  {
    name: 'embaralhar',
    aliases: ['shuffle'],
    description: 'Embaralha a fila',
    guildOnly: true,
    run(ctx) {
      const s = state(ctx);
      for (let i = s.queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [s.queue[i], s.queue[j]] = [s.queue[j], s.queue[i]];
      }
      broadcast(ctx);
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.ok, description: `🔀 Fila embaralhada (${s.queue.length} faixas).` }));
    }
  },
  {
    name: 'remover',
    aliases: ['remove'],
    description: 'Remove uma faixa da fila pela posicao',
    usage: 'remover 2',
    guildOnly: true,
    run(ctx) {
      const s = state(ctx);
      const index = parseInt(ctx.args[0], 10) - 1;
      if (!s.queue[index]) return ctx.reply('Posicao invalida. Veja `!fila`.');
      const [removed] = s.queue.splice(index, 1);
      broadcast(ctx);
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.warn, description: `🗑️ **${removed.title}** removida da fila.` }));
    }
  }
];

module.exports = { category: 'Musica', commands };
