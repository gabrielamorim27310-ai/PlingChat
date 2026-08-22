'use strict';

const store = require('../../store');
const { all, get, run } = require('../../db');

const onOff = (v) => (v ? '🟢 ligado' : '🔴 desligado');

function parseBool(value) {
  if (/^(on|ligar|sim|true|1|ativar)$/i.test(value || '')) return 1;
  if (/^(off|desligar|nao|não|false|0|desativar)$/i.test(value || '')) return 0;
  return null;
}

const commands = [
  {
    name: 'config',
    aliases: ['configuracoes', 'settings'],
    description: 'Mostra a configuracao do bot neste servidor',
    guildOnly: true,
    permission: 'admin',
    run(ctx) {
      const s = store.getSettings(ctx.guild.id);
      const welcomeChannel = s.welcome_channel_id ? store.getChannel(s.welcome_channel_id) : null;
      const logChannel = s.log_channel_id ? store.getChannel(s.log_channel_id) : null;
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.brand,
        title: `⚙️ Configuracao do Nexy — ${ctx.guild.name}`,
        fields: [
          { name: 'Prefixo', value: `\`${s.prefix}\``, inline: true },
          { name: 'Niveis', value: onOff(s.levels_enabled), inline: true },
          { name: 'Economia', value: onOff(s.economy_enabled), inline: true },
          { name: 'Canal de boas-vindas', value: welcomeChannel ? `#${welcomeChannel.name}` : '—', inline: true },
          { name: 'Canal de logs', value: logChannel ? `#${logChannel.name}` : '—', inline: true },
          { name: 'Anti-spam', value: onOff(s.automod_spam), inline: true },
          { name: 'Bloquear links', value: onOff(s.automod_links), inline: true },
          { name: 'Bloquear CAPS', value: onOff(s.automod_caps), inline: true },
          { name: 'Palavras bloqueadas', value: s.automod_words ? `\`${s.automod_words}\`` : '—' }
        ],
        footer: `Use ${ctx.prefix}prefixo, ${ctx.prefix}boasvindas, ${ctx.prefix}automod, ${ctx.prefix}logs`
      }));
    }
  },
  {
    name: 'prefixo',
    aliases: ['prefix'],
    description: 'Muda o prefixo dos comandos',
    usage: 'prefixo ?',
    guildOnly: true,
    permission: 'admin',
    run(ctx) {
      const prefix = ctx.argStr.trim();
      if (!prefix || prefix.length > 3) return ctx.reply('Escolha um prefixo de 1 a 3 caracteres. Ex: `!prefixo ?`');
      store.updateSettings(ctx.guild.id, { prefix });
      ctx.bot.deliver?.({ __settingsUpdated: true, guildId: ctx.guild.id });
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.ok, description: `✅ Prefixo alterado para \`${prefix}\`` }));
    }
  },
  {
    name: 'boasvindas',
    aliases: ['welcome'],
    description: 'Define o canal e a mensagem de boas-vindas',
    usage: 'boasvindas #canal | Bem-vindo {user} ao {server}!',
    guildOnly: true,
    permission: 'admin',
    run(ctx) {
      const [channelPart, ...messageParts] = ctx.argStr.split('|');
      if (!channelPart?.trim()) {
        return ctx.reply('', ctx.embed({
          color: ctx.COLORS.err,
          description: 'Use: `!boasvindas #geral | Bem-vindo {user} ao {server}!`\nVariaveis: `{user}`, `{server}`, `{count}`'
        }));
      }
      if (/^(off|desligar)$/i.test(channelPart.trim())) {
        store.updateSettings(ctx.guild.id, { welcome_channel_id: null });
        return ctx.reply('', ctx.embed({ color: ctx.COLORS.warn, description: '🔕 Boas-vindas desativadas.' }));
      }
      const channel = store.findChannelByName(ctx.guild.id, channelPart.trim());
      if (!channel || channel.type !== 'text') return ctx.reply('Canal de texto nao encontrado.');
      const patch = { welcome_channel_id: channel.id };
      if (messageParts.length) patch.welcome_message = messageParts.join('|').trim();
      store.updateSettings(ctx.guild.id, patch);
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.ok,
        title: '👋 Boas-vindas configuradas',
        description: `Canal: **#${channel.name}**\nMensagem: ${store.getSettings(ctx.guild.id).welcome_message}`
      }));
    }
  },
  {
    name: 'despedida',
    aliases: ['goodbye'],
    description: 'Define a mensagem de saida',
    usage: 'despedida {user} nos deixou...',
    guildOnly: true,
    permission: 'admin',
    run(ctx) {
      if (!ctx.argStr) return ctx.reply('Escreva a mensagem. Variaveis: `{user}`, `{count}`');
      store.updateSettings(ctx.guild.id, { goodbye_message: ctx.argStr });
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.ok, description: '✅ Mensagem de despedida atualizada.' }));
    }
  },
  {
    name: 'logs',
    description: 'Define o canal de logs de moderacao',
    usage: 'logs #canal | logs off',
    guildOnly: true,
    permission: 'admin',
    run(ctx) {
      if (/^(off|desligar)$/i.test(ctx.argStr.trim())) {
        store.updateSettings(ctx.guild.id, { log_channel_id: null });
        return ctx.reply('', ctx.embed({ color: ctx.COLORS.warn, description: '🔕 Logs desativados.' }));
      }
      const channel = store.findChannelByName(ctx.guild.id, ctx.argStr);
      if (!channel || channel.type !== 'text') return ctx.reply('Canal de texto nao encontrado.');
      store.updateSettings(ctx.guild.id, { log_channel_id: channel.id });
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.ok, description: `📋 Logs serao enviados em **#${channel.name}**.` }));
    }
  },
  {
    name: 'automod',
    description: 'Liga ou desliga as protecoes automaticas',
    usage: 'automod links|spam|caps|palavras on/off',
    guildOnly: true,
    permission: 'admin',
    run(ctx) {
      const [featureRaw, ...rest] = ctx.args;
      const feature = (featureRaw || '').toLowerCase();
      const map = { links: 'automod_links', spam: 'automod_spam', caps: 'automod_caps' };

      if (feature === 'palavras') {
        const words = rest.join(' ').trim();
        store.updateSettings(ctx.guild.id, { automod_words: words });
        return ctx.reply('', ctx.embed({
          color: ctx.COLORS.ok,
          description: words ? `🚫 Palavras bloqueadas: \`${words}\`` : '✅ Lista de palavras bloqueadas limpa.'
        }));
      }

      if (!map[feature]) {
        return ctx.reply('', ctx.embed({
          color: ctx.COLORS.err,
          description: 'Use: `!automod links on`, `!automod spam off`, `!automod caps on`, `!automod palavras palavra1, palavra2`'
        }));
      }

      const value = parseBool(rest[0]);
      if (value === null) return ctx.reply('Diga `on` ou `off`.');
      store.updateSettings(ctx.guild.id, { [map[feature]]: value });
      return ctx.reply('', ctx.embed({
        color: value ? ctx.COLORS.ok : ctx.COLORS.warn,
        description: `🛡️ Automod **${feature}**: ${onOff(value)}`
      }));
    }
  },
  {
    name: 'niveis',
    aliases: ['levels'],
    description: 'Liga ou desliga o sistema de niveis',
    usage: 'niveis on|off',
    guildOnly: true,
    permission: 'admin',
    run(ctx) {
      const value = parseBool(ctx.args[0]);
      if (value === null) return ctx.reply('Use `!niveis on` ou `!niveis off`.');
      store.updateSettings(ctx.guild.id, { levels_enabled: value });
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.ok, description: `📈 Sistema de niveis: ${onOff(value)}` }));
    }
  },
  {
    name: 'mensagemnivel',
    aliases: ['levelupmsg'],
    description: 'Personaliza a mensagem de level up',
    usage: 'mensagemnivel Parabens {user}, nivel {level}!',
    guildOnly: true,
    permission: 'admin',
    run(ctx) {
      if (!ctx.argStr) return ctx.reply('Escreva a mensagem. Variaveis: `{user}`, `{level}`, `{server}`');
      store.updateSettings(ctx.guild.id, { levelup_message: ctx.argStr });
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.ok, description: '✅ Mensagem de level up atualizada.' }));
    }
  },
  {
    name: 'addcmd',
    aliases: ['novocomando'],
    description: 'Cria um comando personalizado',
    usage: 'addcmd regras | Leia o canal #regras!',
    guildOnly: true,
    permission: 'admin',
    run(ctx) {
      const [nameRaw, ...responseParts] = ctx.argStr.split('|');
      const name = (nameRaw || '').trim().toLowerCase();
      const response = responseParts.join('|').trim();
      if (!name || !response) return ctx.reply('Use: `!addcmd regras | Leia as regras em #regras`');
      if (ctx.bot.commands.has(name)) return ctx.reply('Ja existe um comando nativo com esse nome.');
      run(
        `INSERT INTO custom_commands (guild_id, name, response) VALUES (?, ?, ?)
         ON CONFLICT(guild_id, name) DO UPDATE SET response = excluded.response`,
        ctx.guild.id, name, response
      );
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.ok,
        description: `✅ Comando \`${ctx.prefix}${name}\` criado.`
      }));
    }
  },
  {
    name: 'delcmd',
    aliases: ['apagarcomando'],
    description: 'Remove um comando personalizado',
    usage: 'delcmd regras',
    guildOnly: true,
    permission: 'admin',
    run(ctx) {
      const name = ctx.argStr.trim().toLowerCase();
      run('DELETE FROM custom_commands WHERE guild_id = ? AND name = ?', ctx.guild.id, name);
      return ctx.reply('', ctx.embed({ color: ctx.COLORS.warn, description: `🗑️ Comando \`${name}\` removido.` }));
    }
  },
  {
    name: 'listcmd',
    aliases: ['comandospersonalizados'],
    description: 'Lista os comandos personalizados do servidor',
    guildOnly: true,
    run(ctx) {
      const rows = all('SELECT * FROM custom_commands WHERE guild_id = ?', ctx.guild.id);
      if (!rows.length) return ctx.reply('Nenhum comando personalizado ainda.');
      return ctx.reply('', ctx.embed({
        color: ctx.COLORS.brand,
        title: '📝 Comandos personalizados',
        description: rows.map((r) => `\`${ctx.prefix}${r.name}\` → ${r.response}`).join('\n')
      }));
    }
  }
];

module.exports = { category: 'Configuracao', commands };
