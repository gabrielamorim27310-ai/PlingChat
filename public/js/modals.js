import { api } from './api.js';
import { $, el, icon, avatarNode, escapeHtml, initials } from './util.js';
import {
  state, socket, toast, openGuild, openHome, startDM, refresh, appConfig, setupPush, applyTheme, getTheme,
  voice, applyAudioOutput
} from './app.js';
import {
  soundsEnabled, setSoundsEnabled, osNotificationsEnabled, enableOsNotifications, disableOsNotifications,
  isIOS, isMac, isStandaloneApp
} from './notify.js';
import { listMediaDevices, canPickAudioOutput } from './voice.js';

/* ============================================================ básico ==== */

export function openModal(node) {
  const modal = $('#modal');
  // Trocar de modal direto (ex.: "Meu perfil" -> "Meus convites") também
  // descarta o anterior sem passar por closeModal() -- roda a limpeza dele
  // aqui também, senão um teste de microfone/câmera ficaria aberto.
  modal.firstElementChild?.__modalCleanup?.();
  modal.replaceChildren(node);
  $('#modalBackdrop').hidden = false;
}

export function closeModal() {
  // Alguns modais (ex.: teste de microfone/câmera em "Voz e vídeo") deixam
  // stream aberta enquanto estão na tela -- sem isso o LED da câmera
  // continuaria aceso depois de fechar.
  $('#modal').firstElementChild?.__modalCleanup?.();
  $('#modalBackdrop').hidden = true;
  $('#modal').replaceChildren();
}

const shell = ({ title, subtitle, body, foot, tabs }) => el('div', {},
  el('div', { class: 'modal-head' }, el('h2', {}, title), subtitle ? el('p', {}, subtitle) : null),
  tabs || null,
  el('div', { class: 'modal-body' }, body),
  foot ? el('div', { class: 'modal-foot' }, foot) : null);

const cancelBtn = () => el('button', { class: 'btn btn-ghost', onclick: closeModal }, 'Cancelar');

const field = (label, input) => el('label', { class: 'field' }, el('span', {}, label), input);

/** Botões de compartilhar um link/código por e-mail e WhatsApp. */
const shareButtons = (link, message) => [
  el('button', {
    class: 'icon-btn', title: 'Mandar por e-mail',
    onclick: () => {
      location.href = `mailto:?subject=${encodeURIComponent('Convite pro PlingChat')}&body=${encodeURIComponent(`${message}\n\n${link}`)}`;
    }
  }, icon('mail', 16)),
  el('button', {
    class: 'icon-btn', title: 'Mandar por WhatsApp',
    onclick: () => {
      window.open(`https://wa.me/?text=${encodeURIComponent(`${message}\n${link}`)}`, '_blank');
    }
  }, icon('message-circle', 16))
];

const switchRow = (label, description, value, onChange) => {
  const toggle = el('div', { class: `switch ${value ? 'on' : ''}` });
  toggle.addEventListener('click', () => {
    const next = !toggle.classList.contains('on');
    toggle.classList.toggle('on', next);
    onChange(next);
  });
  return el('div', { class: 'switch-row' },
    el('div', { class: 'txt' }, el('strong', {}, label), el('small', {}, description)),
    toggle);
};

/**
 * Substitui um <select> nativo -- o menu aberto dele usa o estilo do
 * sistema operacional (aquele azul do Windows), que o CSS não controla.
 * `options`: [{ value, label, dot? }]. Devolve um nó com `.value`
 * get/set, pra continuar dropando no lugar de um <select> comum.
 */
function customSelect(options, initialValue, onChange) {
  let opts = options;
  let current = initialValue;
  const label = el('span', { class: 'custom-select-label' });
  const btn = el('button', { type: 'button', class: 'custom-select-btn' });
  const panel = el('div', { class: 'custom-select-panel', hidden: true });

  const close = () => { panel.hidden = true; };
  const pick = (value) => {
    current = value;
    renderBtn();
    close();
    onChange?.(value);
  };
  const renderPanel = () => {
    // el() já filtra filhos null -- passar direto pro replaceChildren nativo
    // (sem o el()) não filtra, e um `null` solto vira o texto "null" na tela.
    panel.replaceChildren(...opts.map((opt) => el('button', {
      type: 'button', class: 'custom-select-option',
      onclick: () => pick(opt.value)
    }, opt.dot ? el('span', { class: 'status-dot', style: `background:${opt.dot}` }) : null, el('span', {}, opt.label))));
  };
  const renderBtn = () => {
    const opt = opts.find((o) => o.value === current) ?? opts[0];
    label.textContent = opt?.label ?? '';
    const dot = opt?.dot ? el('span', { class: 'status-dot', style: `background:${opt.dot}` }) : null;
    btn.replaceChildren(...[dot, label, icon('chevron-down', 15)].filter(Boolean));
  };

  const wrap = el('div', { class: 'custom-select' }, btn, panel);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
  });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });

  renderPanel();
  renderBtn();
  Object.defineProperty(wrap, 'value', { get: () => current, set: (v) => { current = v; renderBtn(); } });
  // Pra listas que só se conhecem depois de um await (dispositivos de
  // áudio/vídeo, por exemplo) -- troca as opções sem recriar o dropdown.
  wrap.setOptions = (newOptions, newValue) => {
    opts = newOptions;
    if (newValue !== undefined) current = newValue;
    renderPanel();
    renderBtn();
  };
  return wrap;
}

/* =========================================================== servidor === */

/** Entrada única pra criar OU entrar num servidor — antes eram dois botões separados. */
function addGuild() {
  const option = (name, title, subtitle, onclick) => el('button', {
    class: 'guild-option',
    onclick
  }, icon(name, 22), el('div', {},
    el('strong', {}, title),
    el('span', {}, subtitle)));

  return shell({
    title: 'Adicionar um servidor',
    body: el('div', { class: 'guild-options' },
      option('plus', 'Criar um servidor', 'Comece um do zero, só seu.', () => openModal(createGuild())),
      option('compass', 'Entrar com um convite', 'Já tem um código ou link? Use aqui.', () => openModal(joinGuild()))),
    foot: [cancelBtn()]
  });
}

function createGuild() {
  const input = el('input', { type: 'text', maxlength: 40, placeholder: 'Servidor do Rafa' });

  const submit = async () => {
    const name = input.value.trim();
    if (name.length < 2) return toast('Escolha um nome com pelo menos 2 caracteres.', 'err');
    try {
      const { guild } = await api.post('/guilds', { name });
      state.guilds.push(guild);
      closeModal();
      openGuild(guild.id);
      toast(`Servidor "${guild.name}" criado!`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  setTimeout(() => input.focus(), 50);

  return shell({
    title: 'Criar um servidor',
    subtitle: 'Seu servidor já nasce com canais de texto, voz e o bot Nexy pronto para uso.',
    body: field('Nome do servidor', input),
    foot: [cancelBtn(), el('button', { class: 'btn btn-primary', onclick: submit }, 'Criar servidor')]
  });
}

function joinGuild() {
  const input = el('input', { type: 'text', placeholder: 'ex: k3npq7ab' });

  const submit = async () => {
    try {
      const { guild } = await api.post('/guilds/join', { code: input.value.trim() });
      state.guilds.push(guild);
      closeModal();
      openGuild(guild.id);
      toast(`Você entrou em "${guild.name}"!`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  setTimeout(() => input.focus(), 50);

  return shell({
    title: 'Entrar em um servidor',
    subtitle: 'Cole abaixo o código de convite que te enviaram.',
    body: field('Código de convite', input),
    foot: [cancelBtn(), el('button', { class: 'btn btn-primary', onclick: submit }, 'Entrar')]
  });
}

function createChannel(guildId, type = 'text') {
  const name = el('input', { type: 'text', placeholder: type === 'voice' ? 'Sala de jogos' : 'novo-canal' });
  const topic = el('input', { type: 'text', placeholder: 'Sobre o que é este canal? (opcional)' });
  const kind = el('select', {},
    el('option', { value: 'text' }, '# Canal de texto'),
    el('option', { value: 'voice' }, '🔊 Canal de voz'));
  kind.value = type;

  const submit = async () => {
    if (!name.value.trim()) return toast('Dê um nome ao canal.', 'err');
    try {
      await api.post(`/guilds/${guildId}/channels`, {
        name: name.value.trim(), type: kind.value, topic: topic.value.trim() || null
      });
      closeModal();
      toast('Canal criado!', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  name.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  setTimeout(() => name.focus(), 50);

  return shell({
    title: 'Criar canal',
    body: [field('Tipo', kind), field('Nome', name), field('Tópico', topic)],
    foot: [cancelBtn(), el('button', { class: 'btn btn-primary', onclick: submit }, 'Criar canal')]
  });
}

function guildMenu(guild) {
  if (!guild) return el('div', {});
  const isOwner = guild.myRole === 'owner';
  const isAdmin = ['owner', 'admin'].includes(guild.myRole);

  const item = (iconName, label, onclick, danger = false) => el('button', {
    class: 'channel',
    style: danger ? 'color:var(--red)' : '',
    onclick
  }, el('span', { class: 'glyph' }, icon(iconName, 15)), el('span', { class: 'name' }, label));

  return shell({
    title: guild.name,
    subtitle: `${guild.members.length} membros · você é ${guild.myRole}`,
    body: el('div', {},
      item('user-plus', 'Convidar pessoas', () => openModal(invite(guild))),
      isAdmin ? item('sliders', 'Configurações do servidor', () => openModal(guildSettings(guild))) : null,
      isAdmin ? item('cpu', 'Painel do bot Nexy', () => openModal(botPanel(guild))) : null,
      isAdmin ? item('list', 'Log de auditoria', () => openModal(auditLog(guild))) : null,
      isAdmin ? item('plus', 'Criar canal', () => openModal(createChannel(guild.id))) : null,
      !isOwner ? item('log-out', 'Sair do servidor', async () => {
        if (!confirm(`Sair de "${guild.name}"?`)) return;
        await api.del(`/guilds/${guild.id}/leave`);
        state.guilds = state.guilds.filter((g) => g.id !== guild.id);
        closeModal();
        openHome();
        refresh.rail();
      }, true) : null,
      isOwner ? item('trash', 'Excluir servidor', async () => {
        if (!confirm(`Excluir "${guild.name}" para sempre? Isso apaga todos os canais e mensagens.`)) return;
        await api.del(`/guilds/${guild.id}`);
        state.guilds = state.guilds.filter((g) => g.id !== guild.id);
        closeModal();
        openHome();
        refresh.rail();
      }, true) : null),
    foot: [el('button', { class: 'btn btn-ghost', onclick: closeModal }, 'Fechar')]
  });
}

function invite(guild) {
  const input = el('input', { type: 'text', value: guild.inviteCode, readonly: true });
  const link = `${location.origin}/?convite=${guild.inviteCode}`;

  const memberIds = new Set(guild.members.map((m) => m.id));
  const eligible = state.friends.friends.filter((f) => !memberIds.has(f.id));

  const friendList = el('div', { class: 'invite-friend-list' });
  const renderFriends = () => {
    friendList.replaceChildren();
    if (!eligible.length) {
      friendList.append(el('p', { style: 'color:var(--text-mute);font-size:13px;padding:8px 0' },
        state.friends.friends.length ? 'Seus amigos já estão todos aqui.' : 'Você ainda não tem amigos adicionados.'));
      return;
    }
    for (const friend of eligible) {
      const row = el('div', { class: 'invite-friend-row' },
        avatarNode(friend, { size: 28 }),
        el('span', { class: 'name' }, friend.username),
        el('button', {
          class: 'btn btn-ghost',
          onclick: async (event) => {
            try {
              await api.post(`/guilds/${guild.id}/invite-friend`, { userId: friend.id });
              row.replaceWith(el('div', { class: 'invite-friend-row done' }, `✓ Convite enviado a ${friend.username}`));
              toast(`Convite enviado! ${friend.username} decide se entra.`, 'ok');
            } catch (err) {
              toast(err.message, 'err');
            }
          }
        }, 'Convidar'));
      friendList.append(row);
    }
  };
  renderFriends();

  const shareBtn = navigator.share ? el('button', {
    class: 'btn btn-ghost btn-block',
    style: 'margin-top:10px',
    onclick: () => navigator.share({ title: `Entrar em ${guild.name}`, url: link }).catch(() => {})
  }, 'Compartilhar link') : null;

  return shell({
    title: 'Convidar para o servidor',
    subtitle: 'Adicione direto quem já é seu amigo, ou compartilhe o código/link com mais gente.',
    body: el('div', {},
      el('div', { style: 'margin-bottom:16px' },
        el('p', { style: 'font-size:12px;color:var(--text-mute);margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em;font-weight:700' }, 'Convidar amigo direto'),
        friendList),
      el('p', { style: 'font-size:12px;color:var(--text-mute);margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em;font-weight:700' }, 'Ou por código/link'),
      el('div', { class: 'invite-box' },
        input,
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            await navigator.clipboard.writeText(guild.inviteCode).catch(() => {});
            toast('Código copiado!', 'ok');
          }
        }, 'Copiar')),
      el('p', { style: 'margin-top:14px;font-size:12px;color:var(--text-mute)' }, 'Link direto:'),
      el('div', { class: 'invite-box', style: 'margin-top:6px' },
        el('input', { type: 'text', value: link, readonly: true }),
        el('button', {
          class: 'btn btn-ghost',
          onclick: async () => {
            await navigator.clipboard.writeText(link).catch(() => {});
            toast('Link copiado!', 'ok');
          }
        }, 'Copiar'),
        ...shareButtons(link, `Vem pro servidor "${guild.name}" no PlingChat!`)),
      shareBtn),
    foot: [el('button', { class: 'btn btn-ghost', onclick: closeModal }, 'Fechar')]
  });
}

/* ================================================== configurações guild = */

function guildSettings(guild) {
  const settings = { ...guild.settings };
  const textChannels = guild.channels.filter((c) => c.type === 'text');

  /* ------------------------------------------------- aparência (ícone) --- */
  const guildColors = ['#9b4dff', '#d94fc0', '#5eead4', '#37b6f0', '#f0c264', '#ff7a7a', '#3d7ce0', '#7ec8f5', '#ff7ab8'];
  let iconColor = guild.iconColor;
  let iconPhoto = guild.iconUrl || null;

  const iconPreview = el('span', {
    class: 'avatar big', style: iconPhoto ? '' : `background:${iconColor}`
  }, iconPhoto ? el('img', { src: iconPhoto, alt: '' }) : initials(guild.name));

  const iconRemoveBtn = el('button', { class: 'btn btn-ghost', hidden: !iconPhoto, onclick: () => setIconPreview(null) }, 'Remover foto');

  const setIconPreview = (dataUrl) => {
    iconPhoto = dataUrl;
    iconRemoveBtn.hidden = !iconPhoto;
    iconPreview.replaceChildren();
    if (dataUrl) {
      iconPreview.append(el('img', { src: dataUrl, alt: '' }));
      iconPreview.style.background = iconColor;
    } else {
      iconPreview.style.background = iconColor;
      iconPreview.textContent = initials(guild.name);
    }
  };

  const iconHandleFile = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('Escolha uma imagem.', 'err');
    if (file.size > 15 * 1024 * 1024) return toast('Escolha uma imagem de até 15MB.', 'err');
    const dataUrl = await photoEditor(file);
    if (dataUrl) setIconPreview(dataUrl);
  };

  const iconPickInput = (extra = {}) => {
    const input = el('input', { type: 'file', accept: 'image/*', hidden: true, ...extra });
    input.addEventListener('change', () => { iconHandleFile(input.files?.[0]); input.value = ''; });
    return input;
  };

  const iconIsTouch = matchMedia('(pointer: coarse)').matches;
  const iconCameraInput = iconPickInput({ capture: 'environment' });
  const iconFilesInput = iconPickInput();

  const iconSourceButtons = iconIsTouch ? [
    el('button', { class: 'btn btn-ghost', onclick: () => iconCameraInput.click() }, icon('camera', 15), ' Tirar foto'),
    el('button', { class: 'btn btn-ghost', onclick: () => iconFilesInput.click() }, 'Da galeria/arquivos')
  ] : [
    el('button', {
      class: 'btn btn-ghost',
      onclick: async () => { const file = await cameraCapture(); if (file) iconHandleFile(file); }
    }, icon('camera', 15), ' Tirar foto agora'),
    el('button', { class: 'btn btn-ghost', onclick: () => iconFilesInput.click() }, 'Escolher arquivo')
  ];

  const iconSwatches = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px' },
    guildColors.map((c) => {
      const dot = el('button', {
        style: `width:30px;height:30px;border-radius:50%;background:${c};border:3px solid ${c === iconColor ? '#fff' : 'transparent'}`,
        onclick: () => {
          iconColor = c;
          for (const node of iconSwatches.children) node.style.borderColor = 'transparent';
          dot.style.borderColor = '#fff';
          if (!iconPhoto) iconPreview.style.background = c;
        }
      });
      return dot;
    }));

  const saveIcon = async () => {
    try {
      const patch = { iconColor };
      if (iconPhoto !== (guild.iconUrl || null)) patch.iconUrl = iconPhoto;
      const { guild: updated } = await api.patch(`/guilds/${guild.id}/icon`, patch);
      guild.iconColor = updated.iconColor;
      guild.iconUrl = updated.iconUrl;
      refresh.rail();
      toast('Aparência do servidor atualizada!', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  const channelSelect = (value) => {
    const select = el('select', {}, el('option', { value: '' }, '— nenhum —'),
      textChannels.map((c) => el('option', { value: c.id }, `# ${c.name}`)));
    select.value = value || '';
    return select;
  };

  const prefix = el('input', { type: 'text', maxlength: 3, value: settings.prefix });
  const welcomeChannel = channelSelect(settings.welcome_channel_id);
  const welcomeMessage = el('input', { type: 'text', value: settings.welcome_message || '' });
  const goodbyeMessage = el('input', { type: 'text', value: settings.goodbye_message || '' });
  const logChannel = channelSelect(settings.log_channel_id);
  const levelupMessage = el('input', { type: 'text', value: settings.levelup_message || '' });
  const badWords = el('input', { type: 'text', value: settings.automod_words || '', placeholder: 'palavra1, palavra2' });
  const orgDomain = el('input', { type: 'text', value: settings.org_domain || '', placeholder: 'suaempresa.com.br' });

  const flags = {
    levels_enabled: settings.levels_enabled,
    economy_enabled: settings.economy_enabled,
    automod_spam: settings.automod_spam,
    automod_links: settings.automod_links,
    automod_caps: settings.automod_caps
  };

  const save = async () => {
    try {
      const { settings: updated } = await api.patch(`/guilds/${guild.id}/settings`, {
        prefix: prefix.value.trim() || '!',
        welcome_channel_id: welcomeChannel.value || null,
        welcome_message: welcomeMessage.value,
        goodbye_message: goodbyeMessage.value,
        log_channel_id: logChannel.value || null,
        levelup_message: levelupMessage.value,
        automod_words: badWords.value,
        org_domain: orgDomain.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null,
        ...Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, v ? 1 : 0]))
      });
      guild.settings = updated;
      closeModal();
      toast('Configurações salvas!', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  return shell({
    title: `Configurações · ${guild.name}`,
    subtitle: 'Tudo que o Nexy faz neste servidor é ajustado aqui.',
    body: el('div', {},
      el('h4', { style: 'margin:4px 0 10px;color:var(--brand-2);font-size:12px;text-transform:uppercase' }, 'Aparência'),
      el('div', { style: 'display:flex;gap:14px;align-items:center;margin-bottom:14px' },
        iconPreview,
        el('div', {}, el('div', { class: 'avatar-source-row' }, iconSourceButtons, iconRemoveBtn, iconCameraInput, iconFilesInput))),
      field('Cor do servidor', iconSwatches),
      el('button', { class: 'btn btn-primary btn-block', style: 'margin:4px 0 22px', onclick: saveIcon }, 'Salvar aparência'),

      el('h4', { style: 'margin:4px 0 10px;color:var(--brand-2);font-size:12px;text-transform:uppercase' }, 'Empresa'),
      field('Domínio de e-mail verificado', orgDomain),
      el('p', { style: 'font-size:12px;color:var(--text-mute);margin-top:-8px' },
        settings.org_domain
          ? `Qualquer conta com e-mail @${settings.org_domain} pode entrar sem convite, pelo link: ${location.origin}/?org=${guild.id}`
          : 'Deixe em branco pra manter fechado só por convite. Preenchido, qualquer pessoa com e-mail desse domínio entra sozinha.'),

      el('h4', { style: 'margin:22px 0 10px;color:var(--brand-2);font-size:12px;text-transform:uppercase' }, 'Bot'),
      field('Prefixo dos comandos', prefix),
      switchRow('Sistema de níveis', 'Ganha XP conversando e sobe de nível', flags.levels_enabled, (v) => { flags.levels_enabled = v; }),
      field('Mensagem de level up', levelupMessage),
      switchRow('Economia', 'Moedas, loja, apostas e ranking', flags.economy_enabled, (v) => { flags.economy_enabled = v; }),

      el('h4', { style: 'margin:22px 0 10px;color:var(--brand-2);font-size:12px;text-transform:uppercase' }, 'Boas-vindas e logs'),
      field('Canal de boas-vindas', welcomeChannel),
      field('Mensagem de entrada', welcomeMessage),
      field('Mensagem de saída', goodbyeMessage),
      field('Canal de logs de moderação', logChannel),
      el('p', { style: 'font-size:12px;color:var(--text-mute);margin-top:-8px' },
        'Variáveis: {user}, {server}, {count}, {level}'),

      el('h4', { style: 'margin:22px 0 10px;color:var(--brand-2);font-size:12px;text-transform:uppercase' }, 'Auto-moderação'),
      switchRow('Anti-spam', 'Silencia quem manda mensagens em sequência', flags.automod_spam, (v) => { flags.automod_spam = v; }),
      switchRow('Bloquear links', 'Apaga mensagens com links de não-moderadores', flags.automod_links, (v) => { flags.automod_links = v; }),
      switchRow('Bloquear CAPS', 'Apaga mensagens gritadas', flags.automod_caps, (v) => { flags.automod_caps = v; }),
      field('Palavras bloqueadas (separadas por vírgula)', badWords)),
    foot: [cancelBtn(), el('button', { class: 'btn btn-primary', onclick: save }, 'Salvar')]
  });
}

/* ====================================================== log de auditoria = */

const strong = (s) => `<strong>${escapeHtml(s ?? '???')}</strong>`;
const AUDIT_LABEL = {
  kick: (e) => `expulsou ${strong(e.target?.username)}${e.meta?.reason ? ` — ${escapeHtml(e.meta.reason)}` : ''}`,
  ban: (e) => `baniu ${strong(e.target?.username)}${e.meta?.reason ? ` — ${escapeHtml(e.meta.reason)}` : ''}`,
  unban: (e) => `desbaniu ${strong(e.target?.username)}`,
  mute: (e) => `silenciou ${strong(e.target?.username)}${e.meta?.reason ? ` — ${escapeHtml(e.meta.reason)}` : ''}`,
  unmute: (e) => `liberou ${strong(e.target?.username)}`,
  warn: (e) => `advertiu ${strong(e.target?.username)} (${escapeHtml(String(e.meta?.total ?? '?'))}/3)`,
  warns_cleared: (e) => `limpou as advertências de ${strong(e.target?.username)}`,
  messages_purged: (e) => `apagou ${escapeHtml(String(e.meta?.count ?? '?'))} mensagens em #${escapeHtml(e.meta?.channel ?? '?')}`,
  role_promoted: (e) => `promoveu ${strong(e.target?.username)} a ${escapeHtml(e.meta?.role ?? 'cargo')}`,
  role_demoted: (e) => `rebaixou ${strong(e.target?.username)}`,
  settings_update: (e) => `alterou configurações (${escapeHtml((e.meta?.keys || []).join(', ') || '—')})`,
  channel_deleted: (e) => `excluiu o canal #${escapeHtml(e.meta?.name ?? '?')}`,
  member_joined_invite: () => `entrou por convite`,
  member_invited: (e) => `adicionou ${strong(e.target?.username)} direto`,
  member_joined_domain: () => `entrou pelo domínio verificado`
};

function auditLog(guild) {
  const list = el('div', { style: 'display:flex;flex-direction:column;gap:2px;max-height:420px;overflow-y:auto' });
  const loadMore = el('button', { class: 'btn btn-ghost btn-block', style: 'margin-top:10px' }, 'Carregar mais');
  let before = null;
  let loading = false;

  const row = (e) => {
    const describe = AUDIT_LABEL[e.action] || (() => e.action);
    return el('div', { style: 'display:flex;gap:10px;padding:10px 4px;border-bottom:1px solid var(--line);align-items:flex-start' },
      avatarNode(e.actor, { size: 26, status: false }),
      el('div', { style: 'min-width:0;flex:1' },
        el('div', { style: 'font-size:13.5px', html: `${strong(e.actor?.username || 'alguém')} ${describe(e)}` }),
        el('div', { style: 'font-size:11px;color:var(--text-mute);margin-top:2px' },
          new Date(e.createdAt).toLocaleString('pt-BR'))));
  };

  const load = async () => {
    if (loading) return;
    loading = true;
    try {
      const qs = before ? `?before=${before}` : '';
      const { entries } = await api.get(`/guilds/${guild.id}/audit-log${qs}`);
      for (const e of entries) list.append(row(e));
      if (entries.length) before = entries[entries.length - 1].createdAt;
      loadMore.hidden = entries.length < 50;
      if (!entries.length && !before) {
        list.append(el('p', { style: 'padding:16px 4px;color:var(--text-mute);font-size:13px' }, 'Nada registrado ainda.'));
      }
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      loading = false;
    }
  };
  loadMore.addEventListener('click', load);
  load();

  return shell({
    title: `Log de auditoria · ${guild.name}`,
    subtitle: 'Quem fez o quê, e quando — banimentos, mudança de cargo, configuração.',
    body: el('div', {}, list, loadMore),
    foot: [el('button', { class: 'btn btn-ghost', onclick: closeModal }, 'Fechar')]
  });
}

/* ========================================================== painel bot == */

function botPanel(guild) {
  if (!guild) return el('div', {});
  const botMember = guild.members.find((m) => m.isBot);
  const isAdmin = ['owner', 'admin'].includes(guild.myRole);
  const prefix = guild.settings?.prefix || '!';

  const byCategory = new Map();
  for (const cmd of state.botCommands) {
    if (!byCategory.has(cmd.category)) byCategory.set(cmd.category, []);
    byCategory.get(cmd.category).push(cmd);
  }

  const body = el('div', {});

  body.append(el('div', { class: 'switch-row', style: 'padding-bottom:16px' },
    el('div', { style: 'display:flex;gap:12px;align-items:center' },
      avatarNode(state.botUser, { size: 44, status: false }),
      el('div', {},
        el('strong', {}, 'Nexy'),
        el('div', { style: 'font-size:12px;color:var(--text-mute)' },
          botMember ? `Ativo neste servidor · prefixo ${prefix}` : 'Ainda não está neste servidor'))),
    isAdmin ? el('button', {
      class: `btn ${botMember ? 'btn-ghost' : 'btn-primary'}`,
      onclick: async () => {
        try {
          const { members } = await api.post(`/guilds/${guild.id}/bot`, { enable: !botMember });
          guild.members = members;
          closeModal();
          refresh.members();
          toast(botMember ? 'Nexy saiu do servidor.' : 'Nexy entrou no servidor!', 'ok');
        } catch (err) {
          toast(err.message, 'err');
        }
      }
    }, botMember ? 'Remover bot' : 'Adicionar ao servidor') : null));

  body.append(el('p', { style: 'font-size:13px;color:var(--text-dim);margin:14px 0' },
    `São ${state.botCommands.length} comandos. Use `,
    el('code', { style: 'background:var(--bg-0);padding:2px 6px;border-radius:5px' }, `${prefix}ajuda`),
    ' em qualquer canal.'));

  for (const [category, commands] of byCategory) {
    body.append(el('div', { class: 'cmd-group' },
      el('h4', {}, category),
      commands.sort((a, b) => a.name.localeCompare(b.name)).map((cmd) =>
        el('div', { class: 'cmd' },
          el('code', {}, `${prefix}${cmd.usage}`),
          el('span', {}, cmd.description, cmd.permission ? ` · requer ${cmd.permission}` : '')))));
  }

  return shell({
    title: '🤖 Nexy — bot integrado',
    subtitle: 'Moderação, economia, níveis, música e diversão, tudo embutido no PlingChat.',
    body,
    foot: [
      isAdmin ? el('button', { class: 'btn btn-ghost', onclick: () => openModal(guildSettings(guild)) }, 'Configurar') : null,
      el('button', { class: 'btn btn-primary', onclick: closeModal }, 'Fechar')
    ].filter(Boolean)
  });
}

/* ========================================================= usuário ====== */

/** Convites de cadastro: cada pessoa gera códigos para trazer amigos. */
function appInvites() {
  const list = el('div', {});
  const note = el('input', { type: 'text', maxlength: 40, placeholder: 'Para quem é? (opcional)' });
  const subtitle = el('p', { style: 'color:var(--text-mute);font-size:13px;margin-top:4px' });
  let limits = { max: 0, maxUses: 0, unlimited: false };

  const render = (codes) => {
    subtitle.textContent = limits.unlimited
      ? 'Convites sem limite de usos nem de quantos você pode ter ativos.'
      : `Cada convite vale para até ${limits.maxUses} pessoas — no máximo ${limits.max} convites ativos ao mesmo tempo.`;

    list.replaceChildren();
    if (!codes.length) {
      list.append(el('p', { style: 'color:var(--text-mute);font-size:13px;padding:12px 0' },
        'Nenhum convite ainda. Gere um abaixo e mande para quem você quer trazer.'));
    }
    for (const item of codes) {
      const link = `${location.origin}/?cadastro=${item.code}`;
      list.append(el('div', { class: 'invite-row' },
        el('code', { class: item.active ? '' : 'used' }, item.code),
        el('span', { style: 'color:var(--text-mute);font-size:12px' },
          item.note ? `${item.note} · ` : '',
          item.revoked ? 'revogado' : (limits.unlimited ? `usado ${item.uses}x` : `${item.uses}/${item.maxUses} usados`)),
        el('div', { class: 'acts' },
          item.active ? el('button', {
            class: 'icon-btn', title: 'Copiar link de cadastro',
            onclick: async () => {
              await navigator.clipboard.writeText(link).catch(() => {});
              toast('Link de convite copiado!', 'ok');
            }
          }, icon('link-2', 16)) : null,
          item.active ? el('button', {
            class: 'icon-btn', title: 'Copiar código',
            onclick: async () => {
              await navigator.clipboard.writeText(item.code).catch(() => {});
              toast('Código copiado!', 'ok');
            }
          }, icon('clipboard', 16)) : null,
          item.active ? shareButtons(link, 'Vem pro PlingChat! Usa esse convite pra criar sua conta:') : null,
          item.active ? el('button', {
            class: 'icon-btn', title: 'Revogar',
            onclick: async () => {
              try {
                const data = await api.del(`/invites/${item.code}`);
                render(data.codes);
                toast('Convite revogado.', 'ok');
              } catch (err) {
                toast(err.message, 'err');
              }
            }
          }, '✕') : null)));
    }
  };

  const create = async () => {
    try {
      const data = await api.post('/invites', { note: note.value.trim() || null });
      note.value = '';
      render(data.codes);
      toast(`Convite ${data.code} criado!`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  api.get('/invites')
    .then(({ codes, max, maxUses, unlimited }) => { limits = { max, maxUses, unlimited }; render(codes); })
    .catch((err) => toast(err.message, 'err'));

  return shell({
    title: '🎟️ Convites de cadastro',
    subtitle: 'O PlingChat é fechado: só cria conta quem tiver um código seu.',
    body: el('div', {},
      subtitle,
      list,
      el('div', { style: 'margin-top:18px;padding-top:16px;border-top:1px solid var(--line)' },
        field('Anotação', note),
        el('button', { class: 'btn btn-primary btn-block', onclick: create }, 'Gerar novo convite'))),
    foot: [el('button', { class: 'btn btn-ghost', onclick: closeModal }, 'Fechar')]
  });
}

/**
 * Abre a webcam num overlay próprio (fora do sistema de modal padrão, pra
 * não perder o que já estava sendo editado por trás) e devolve o frame
 * capturado como File. Usado só no desktop — celular já tem câmera nativa
 * via <input capture>.
 */
function cameraCapture() {
  return new Promise((resolve) => {
    let stream = null;
    const stop = () => stream?.getTracks().forEach((t) => t.stop());

    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then((s) => {
        stream = s;
        const video = el('video', { autoplay: true, playsInline: true, muted: true });
        video.srcObject = stream;

        const overlay = el('div', { class: 'camera-overlay' },
          el('div', { class: 'camera-card' },
            el('h3', {}, 'Tirar foto'),
            video,
            el('div', { class: 'camera-actions' },
              el('button', {
                class: 'btn btn-ghost',
                onclick: () => { stop(); overlay.remove(); resolve(null); }
              }, 'Cancelar'),
              el('button', {
                class: 'btn btn-primary',
                onclick: () => {
                  const canvas = document.createElement('canvas');
                  canvas.width = video.videoWidth;
                  canvas.height = video.videoHeight;
                  const ctx = canvas.getContext('2d');
                  // espelha de volta: a prévia já aparece espelhada (efeito selfie)
                  ctx.translate(canvas.width, 0);
                  ctx.scale(-1, 1);
                  ctx.drawImage(video, 0, 0);
                  stop();
                  overlay.remove();
                  canvas.toBlob(
                    (blob) => resolve(blob ? new File([blob], 'foto.jpg', { type: 'image/jpeg' }) : null),
                    'image/jpeg', 0.92);
                }
              }, 'Capturar'))));
        document.body.append(overlay);
      })
      .catch(() => { toast('Não consegui acessar a câmera.', 'err'); resolve(null); });
  });
}

const PHOTO_FILTERS = [
  { name: 'Nenhum', css: '' },
  { name: 'P&B', css: 'grayscale(1)' },
  { name: 'Sépia', css: 'sepia(.75)' },
  { name: 'Vívido', css: 'saturate(1.6) contrast(1.08)' },
  { name: 'Frio', css: 'saturate(1.1) hue-rotate(-10deg) brightness(1.02)' },
  { name: 'Quente', css: 'saturate(1.15) hue-rotate(10deg) brightness(1.03)' }
];

/**
 * Editor de foto num overlay próprio: recorte (arrastar + zoom), rotação
 * em passos de 90° e filtros. Devolve um data URL JPEG quadrado pronto pro
 * avatar, ou null se cancelado.
 */
function photoEditor(file) {
  const EXPORT = 512;

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onerror = () => { URL.revokeObjectURL(url); toast('Não consegui abrir essa imagem.', 'err'); resolve(null); };
    img.onload = () => {
      URL.revokeObjectURL(url);

      let rotation = 0;   // 0 | 90 | 180 | 270
      let zoom = 1;        // 1..3
      let panX = 0, panY = 0;
      let filterCss = '';

      const canvas = el('canvas', { width: EXPORT, height: EXPORT });
      const ctx = canvas.getContext('2d');

      // Escala que faz a imagem cobrir o quadrado de exportação inteiro.
      const coverScale = Math.max(EXPORT / img.width, EXPORT / img.height);
      const drawW = img.width * coverScale;
      const drawH = img.height * coverScale;

      const clampPan = () => {
        const swapped = rotation === 90 || rotation === 270;
        const halfW = ((swapped ? drawH : drawW) * zoom) / 2;
        const halfH = ((swapped ? drawW : drawH) * zoom) / 2;
        const maxX = Math.max(0, halfW - EXPORT / 2);
        const maxY = Math.max(0, halfH - EXPORT / 2);
        panX = Math.min(maxX, Math.max(-maxX, panX));
        panY = Math.min(maxY, Math.max(-maxY, panY));
      };

      const render = () => {
        clampPan();
        ctx.clearRect(0, 0, EXPORT, EXPORT);
        ctx.save();
        ctx.filter = filterCss;
        ctx.translate(EXPORT / 2 + panX, EXPORT / 2 + panY);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.scale(zoom, zoom);
        ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.restore();
      };

      const wrap = el('div', { class: 'photo-editor-canvas-wrap' }, canvas);
      let dragging = false, startX = 0, startY = 0, startPanX = 0, startPanY = 0;
      wrap.addEventListener('pointerdown', (e) => {
        dragging = true;
        startX = e.clientX; startY = e.clientY;
        startPanX = panX; startPanY = panY;
        wrap.setPointerCapture(e.pointerId);
      });
      wrap.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const scale = canvas.width / wrap.clientWidth;
        panX = startPanX + (e.clientX - startX) * scale;
        panY = startPanY + (e.clientY - startY) * scale;
        render();
      });
      wrap.addEventListener('pointerup', () => { dragging = false; });
      wrap.addEventListener('pointercancel', () => { dragging = false; });

      // Miniatura fixa (sem filtro) usada como base visual dos botões de filtro.
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 88; thumbCanvas.height = 88;
      const tScale = Math.max(88 / img.width, 88 / img.height);
      thumbCanvas.getContext('2d').drawImage(
        img, (88 - img.width * tScale) / 2, (88 - img.height * tScale) / 2, img.width * tScale, img.height * tScale);
      const thumbUrl = thumbCanvas.toDataURL('image/jpeg', 0.7);

      const filterRow = el('div', { class: 'filter-row' });
      for (const f of PHOTO_FILTERS) {
        const btn = el('button', {
          class: `filter-swatch ${f.css === filterCss ? 'active' : ''}`,
          title: f.name,
          onclick: () => {
            filterCss = f.css;
            for (const b of filterRow.children) b.classList.remove('active');
            btn.classList.add('active');
            render();
          }
        }, el('img', { src: thumbUrl, alt: '', style: f.css ? `filter:${f.css}` : '' }));
        filterRow.append(btn);
      }

      const zoomInput = el('input', { type: 'range', min: 100, max: 300, value: 100 });
      zoomInput.addEventListener('input', () => { zoom = Number(zoomInput.value) / 100; render(); });

      const rotate = (delta) => { rotation = (rotation + delta + 360) % 360; render(); };

      const overlay = el('div', { class: 'photo-editor' },
        el('div', { class: 'photo-editor-card' },
          el('h3', {}, 'Ajustar foto'),
          wrap,
          el('div', { class: 'photo-editor-controls' },
            el('div', { class: 'photo-editor-row' }, el('span', { class: 'lbl' }, 'Zoom'), zoomInput),
            el('div', { class: 'photo-editor-row' },
              el('span', { class: 'lbl' }, 'Girar'),
              el('button', { class: 'btn btn-ghost', onclick: () => rotate(-90) }, '↺'),
              el('button', { class: 'btn btn-ghost', onclick: () => rotate(90) }, '↻')),
            filterRow),
          el('div', { class: 'photo-editor-actions' },
            el('button', { class: 'btn btn-ghost', onclick: () => { overlay.remove(); resolve(null); } }, 'Cancelar'),
            el('button', {
              class: 'btn btn-primary',
              onclick: () => { const dataUrl = canvas.toDataURL('image/jpeg', 0.85); overlay.remove(); resolve(dataUrl); }
            }, 'Aplicar'))));

      document.body.append(overlay);
      render();
    };
    img.src = url;
  });
}

/**
 * Escolha de microfone/câmera/saída de áudio -- tudo dentro do próprio site
 * em vez do seletor nativo do navegador. Devolve { node, cleanup }: quem
 * abrir precisa chamar cleanup() ao fechar o modal, senão o teste de
 * microfone/câmera fica com o dispositivo aberto pra sempre.
 */
function voiceSettings() {
  const supportsOutput = canPickAudioOutput();

  const micSelect = customSelect([{ value: '', label: 'Carregando…' }], '', (id) => {
    voice.setAudioInputDevice(id).catch((err) => toast(`Não foi possível trocar o microfone: ${err.message}`, 'err'));
  });
  const camSelect = customSelect([{ value: '', label: 'Carregando…' }], '', (id) => {
    voice.setVideoInputDevice(id).catch((err) => toast(`Não foi possível trocar a câmera: ${err.message}`, 'err'));
    if (camPreviewStream) startCamPreview();
  });
  const speakerSelect = supportsOutput
    ? customSelect([{ value: '', label: 'Carregando…' }], '', (id) => voice.setAudioOutputDevice(id))
    : null;

  /* ---- teste de microfone: medidor de nível ao vivo ---- */
  const meterFill = el('div', { class: 'mic-meter-fill' });
  const micTestBtn = el('button', { type: 'button', class: 'btn btn-ghost' }, 'Testar microfone');
  let micTestStream = null, micTestCtx = null, micTestRaf = null;

  const stopMicTest = () => {
    if (micTestRaf) cancelAnimationFrame(micTestRaf);
    micTestRaf = null;
    micTestCtx?.close?.();
    micTestCtx = null;
    for (const t of micTestStream?.getTracks() || []) t.stop();
    micTestStream = null;
    meterFill.style.width = '0%';
    micTestBtn.textContent = 'Testar microfone';
  };

  const startMicTest = async () => {
    stopMicTest();
    try {
      const constraints = { ...voice.audioFx };
      if (micSelect.value) constraints.deviceId = { exact: micSelect.value };
      micTestStream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
    } catch {
      toast('Não foi possível acessar o microfone.', 'err');
      return;
    }
    micTestBtn.textContent = 'Parar teste';
    micTestCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = micTestCtx.createMediaStreamSource(micTestStream);
    const analyser = micTestCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const loop = () => {
      analyser.getByteFrequencyData(data);
      const level = data.reduce((a, b) => a + b, 0) / data.length;
      meterFill.style.width = `${Math.min(100, Math.round((level / 90) * 100))}%`;
      micTestRaf = requestAnimationFrame(loop);
    };
    loop();
  };

  micTestBtn.addEventListener('click', () => { micTestStream ? stopMicTest() : startMicTest(); });

  /* ---- pré-visualização de câmera (só quando pedido) ---- */
  const camPreview = el('video', { autoplay: true, playsInline: true, muted: true, class: 'cam-preview', hidden: true });
  const camPreviewBtn = el('button', { type: 'button', class: 'btn btn-ghost' }, 'Visualizar câmera');
  let camPreviewStream = null;

  const stopCamPreview = () => {
    for (const t of camPreviewStream?.getTracks() || []) t.stop();
    camPreviewStream = null;
    camPreview.srcObject = null;
    camPreview.hidden = true;
    camPreviewBtn.textContent = 'Visualizar câmera';
  };

  const startCamPreview = async () => {
    try {
      const constraints = { width: { ideal: 640 }, height: { ideal: 360 } };
      if (camSelect.value) constraints.deviceId = { exact: camSelect.value };
      const stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
      for (const t of camPreviewStream?.getTracks() || []) t.stop();
      camPreviewStream = stream;
      camPreview.srcObject = stream;
      camPreview.hidden = false;
      camPreviewBtn.textContent = 'Parar visualização';
    } catch {
      toast('Não foi possível acessar a câmera.', 'err');
    }
  };

  camPreviewBtn.addEventListener('click', () => { camPreviewStream ? stopCamPreview() : startCamPreview(); });

  /* ---- teste de saída de áudio ---- */
  const speakerTestBtn = supportsOutput ? el('button', {
    type: 'button', class: 'btn btn-ghost',
    onclick: () => {
      const audio = new Audio('/sounds/pling.wav');
      applyAudioOutput(audio);
      audio.play().catch(() => toast('Não foi possível tocar o som de teste.', 'err'));
    }
  }, 'Testar') : null;

  /* ---- carrega a lista real de dispositivos ---- */
  async function loadDevices() {
    try {
      const { mics, speakers, cameras } = await listMediaDevices();
      micSelect.setOptions(
        mics.length ? mics.map((d, i) => ({ value: d.deviceId, label: d.label || `Microfone ${i + 1}` }))
          : [{ value: '', label: 'Nenhum microfone encontrado' }],
        voice.deviceIds.audioInput || mics[0]?.deviceId || '');
      camSelect.setOptions(
        cameras.length ? cameras.map((d, i) => ({ value: d.deviceId, label: d.label || `Câmera ${i + 1}` }))
          : [{ value: '', label: 'Nenhuma câmera encontrada' }],
        voice.deviceIds.videoInput || cameras[0]?.deviceId || '');
      if (speakerSelect) {
        speakerSelect.setOptions(
          speakers.length ? speakers.map((d, i) => ({ value: d.deviceId, label: d.label || `Saída ${i + 1}` }))
            : [{ value: '', label: 'Padrão do sistema' }],
          voice.deviceIds.audioOutput || speakers[0]?.deviceId || '');
      }
    } catch {
      toast('Não foi possível listar os dispositivos de áudio/vídeo.', 'err');
    }
  }
  loadDevices();
  navigator.mediaDevices.addEventListener?.('devicechange', loadDevices);

  const fxToggle = (key, label, desc) =>
    switchRow(label, desc, voice.audioFx[key], (on) => voice.setAudioFx(key, on));

  const node = el('div', { class: 'voice-settings' },
    field('Microfone', el('div', { class: 'voice-settings-group' }, micSelect, el('div', { class: 'mic-meter' }, meterFill), micTestBtn)),
    field('Câmera', el('div', { class: 'voice-settings-group' }, camSelect, camPreviewBtn, camPreview)),
    supportsOutput
      ? field('Saída de áudio', el('div', { class: 'voice-settings-row' }, speakerSelect, speakerTestBtn))
      : field('Saída de áudio', el('p', { style: 'font-size:12px;color:var(--text-mute);margin:0' },
          'Escolha de saída não é suportada neste navegador -- usa o padrão do sistema.')),
    fxToggle('echoCancellation', 'Cancelamento de eco', 'Evita que sua própria voz volte pelo microfone.'),
    fxToggle('noiseSuppression', 'Supressão de ruído', 'Reduz ruído de fundo constante.'),
    fxToggle('autoGainControl', 'Ganho automático', 'Ajusta o volume do microfone sozinho.'));

  const cleanup = () => {
    stopMicTest();
    stopCamPreview();
    navigator.mediaDevices.removeEventListener?.('devicechange', loadDevices);
  };

  return { node, cleanup };
}

/** Sons de "pling" + notificações do sistema com a aba aberta em segundo plano. */
function notifSettings() {
  const soundToggle = switchRow(
    'Sons de notificação', 'Toca um "pling" para mensagens e chamadas.',
    soundsEnabled(), (on) => setSoundsEnabled(on));

  // No iPhone, notificação do sistema só existe pro app instalado na tela
  // de início (iOS 16.4+) -- dentro do Safari normal é bloqueio da Apple,
  // não tem permissão que resolva. Detecta isso e explica em vez de deixar
  // o botão falhar sem dizer por quê.
  let osControl;
  if (isIOS() && !isStandaloneApp()) {
    osControl = el('p', { style: 'font-size:12px;color:var(--text-mute);line-height:1.5;margin-top:4px' },
      '📱 No iPhone, notificação do sistema só funciona com o PlingChat instalado: toque em ',
      el('strong', {}, 'Compartilhar'), ' → ', el('strong', {}, 'Adicionar à Tela de Início'),
      ', depois abra por esse ícone (não pelo Safari) pra ativar.');
  } else {
    const osLabel = el('span', {}, osNotificationsEnabled() ? 'Notificações do sistema ativadas' : 'Ativar notificações do sistema');
    const macHint = isMac() ? el('p', { style: 'font-size:12px;color:var(--text-mute);line-height:1.5;margin-top:6px' },
      '🍎 No Mac, além de aceitar aqui, confira se o navegador está liberado em ',
      el('strong', {}, 'Ajustes do Sistema → Notificações'), '.') : null;
    osControl = el('div', {},
      el('button', {
        class: 'btn btn-ghost btn-block',
        onclick: async () => {
          if (osNotificationsEnabled()) {
            disableOsNotifications();
          } else {
            const ok = await enableOsNotifications();
            if (!ok) toast('Permissão de notificação recusada pelo navegador.', 'err');
          }
          osLabel.textContent = osNotificationsEnabled() ? 'Notificações do sistema ativadas' : 'Ativar notificações do sistema';
        }
      }, icon('bell', 15), ' ', osLabel),
      macHint);
  }

  return el('div', {}, soundToggle, osControl);
}

function userSettings() {
  const colors = ['#9b4dff', '#d94fc0', '#5eead4', '#37b6f0', '#f0c264', '#ff7a7a', '#3d7ce0', '#7ec8f5', '#ff7ab8'];
  const custom = el('input', { type: 'text', maxlength: 60, value: state.me.customStatus || '', placeholder: 'Jogando alguma coisa...' });
  const bio = el('textarea', { rows: 3, maxlength: 200, placeholder: 'Fale um pouco sobre você' });
  bio.value = state.me.bio || '';

  let color = state.me.avatarColor;
  let photo = state.me.avatarUrl || null;  // null = sem foto (mostra a cor); string = data URL
  let photoNode = photo ? el('img', { src: photo, alt: '' }) : null;

  const previewAvatar = avatarNode(state.me, { size: 64, status: false });
  if (photoNode) previewAvatar.replaceChildren(photoNode);

  const removeBtn = el('button', { class: 'btn btn-ghost', hidden: !photo, onclick: () => setPreviewPhoto(null) }, 'Remover foto');

  const setPreviewPhoto = (dataUrl) => {
    photo = dataUrl;
    removeBtn.hidden = !photo;
    previewAvatar.replaceChildren();
    if (dataUrl) {
      photoNode = el('img', { src: dataUrl, alt: '' });
      previewAvatar.append(photoNode);
      previewAvatar.style.background = color;
    } else {
      photoNode = null;
      previewAvatar.style.background = color;
      previewAvatar.textContent = initials(state.me.username);
    }
  };

  const handleFile = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('Escolha uma imagem.', 'err');
    if (file.size > 15 * 1024 * 1024) return toast('Escolha uma imagem de até 15MB.', 'err');
    const dataUrl = await photoEditor(file);
    if (dataUrl) setPreviewPhoto(dataUrl);
  };

  const pickInput = (extra = {}) => {
    const input = el('input', { type: 'file', accept: 'image/*', hidden: true, ...extra });
    input.addEventListener('change', () => { handleFile(input.files?.[0]); input.value = ''; });
    return input;
  };

  // Sem "capture", o próprio SO já mostra câmera + galeria/arquivos no
  // mesmo seletor nativo — não existe um jeito padrão de forçar só um dos
  // dois no navegador. Com "capture", o celular pula direto pra câmera.
  const isTouch = matchMedia('(pointer: coarse)').matches;
  const cameraInput = pickInput({ capture: 'user' });
  const galleryInput = pickInput();
  const filesInput = pickInput();

  const sourceButtons = isTouch ? [
    el('button', { class: 'btn btn-ghost', onclick: () => cameraInput.click() }, icon('camera', 15), ' Tirar foto'),
    el('button', { class: 'btn btn-ghost', onclick: () => galleryInput.click() }, 'Da galeria'),
    el('button', { class: 'btn btn-ghost', onclick: () => filesInput.click() }, 'Arquivos')
  ] : [
    el('button', {
      class: 'btn btn-ghost',
      onclick: async () => { const file = await cameraCapture(); if (file) handleFile(file); }
    }, icon('camera', 15), ' Tirar foto agora'),
    el('button', { class: 'btn btn-ghost', onclick: () => filesInput.click() }, 'Escolher arquivo')
  ];

  const photoButtons = el('div', { class: 'avatar-source-row' },
    sourceButtons, removeBtn, cameraInput, galleryInput, filesInput);

  const swatches = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
    colors.map((c) => {
      const dot = el('button', {
        style: `width:34px;height:34px;border-radius:50%;background:${c};border:3px solid ${c === color ? '#fff' : 'transparent'}`,
        onclick: () => {
          color = c;
          for (const node of swatches.children) node.style.borderColor = 'transparent';
          dot.style.borderColor = '#fff';
          // só reflete no avatar se ele não tiver foto (senão a cor nem aparece)
          if (!photo) previewAvatar.style.background = c;
        }
      });
      return dot;
    }));

  const statusSelect = customSelect([
    { value: 'online', label: 'Online', dot: 'var(--green)' },
    { value: 'idle', label: 'Ausente', dot: 'var(--yellow)' },
    { value: 'dnd', label: 'Não perturbe', dot: 'var(--red)' },
    { value: 'invisible', label: 'Invisível', dot: 'var(--text-mute)' }
  ], state.me.status === 'offline' ? 'online' : state.me.status);

  const themeOption = (mode, name, label) => {
    const btn = el('button', {
      class: `theme-option ${getTheme() === mode ? 'active' : ''}`,
      onclick: () => {
        applyTheme(mode);
        for (const b of themeBtns) b.classList.toggle('active', b === btn);
      }
    }, icon(name, 18), el('span', {}, label));
    return btn;
  };
  const themeBtns = [
    themeOption('dark', 'moon', 'Escuro'),
    themeOption('light', 'sun', 'Claro'),
    themeOption('auto', 'contrast', 'Automático')
  ];

  const save = async () => {
    try {
      const patch = {
        avatarColor: color,
        customStatus: custom.value.trim() || null,
        bio: bio.value.trim() || null
      };
      if (photo !== (state.me.avatarUrl || null)) patch.avatarUrl = photo;
      const { user } = await api.patch('/me', patch);
      state.me = user;
      socket.emit('presence:update', { status: statusSelect.value });
      state.me.status = statusSelect.value;
      refresh.me();
      closeModal();
      toast('Perfil atualizado!', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  const voicePanel = voiceSettings();

  const root = shell({
    title: 'Meu perfil',
    subtitle: `${state.me.username}#${state.me.tag}`,
    body: el('div', {},
      el('div', { style: 'display:flex;gap:14px;align-items:center;margin-bottom:18px' },
        previewAvatar,
        el('div', {},
          el('strong', { style: 'font-size:17px' }, state.me.username),
          el('div', { style: 'font-size:12px;color:var(--text-mute)' },
            `Seu identificador: ${state.me.username}#${state.me.tag}`),
          photoButtons)),
      field('Cor do avatar', swatches),
      field('Tema', el('div', { class: 'theme-picker' }, themeBtns)),
      field('Status', statusSelect),
      field('Status personalizado', custom),
      field('Sobre mim', bio),
      el('button', {
        class: 'btn btn-ghost btn-block',
        style: 'margin-top:6px',
        onclick: () => openModal(appInvites())
      }, icon('user-plus', 15), ' Meus convites de cadastro'),
      field('Notificações', notifSettings()),
      appConfig.vapidPublicKey ? el('button', {
        class: 'btn btn-ghost btn-block',
        style: 'margin-top:6px',
        onclick: setupPush
      }, icon('bell', 15), Notification?.permission === 'granted' ? ' Notificações push ativadas' : ' Ativar notificações push (app fechado)') : null,
      el('h3', { style: 'font-size:13px;margin:22px 0 4px;color:var(--text-mute);text-transform:uppercase;letter-spacing:.06em' }, 'Voz e vídeo'),
      voicePanel.node),
    foot: [
      el('button', {
        class: 'btn btn-danger',
        onclick: () => { localStorage.removeItem('nexus.token'); location.reload(); }
      }, 'Sair da conta'),
      cancelBtn(),
      el('button', { class: 'btn btn-primary', onclick: save }, 'Salvar')
    ]
  });
  root.__modalCleanup = voicePanel.cleanup;
  return root;
}

function addFriend() {
  const input = el('input', { type: 'text', placeholder: 'usuario#0000' });
  const results = el('div', { style: 'margin-top:14px' });

  const send = async (handle) => {
    try {
      const data = await api.post('/friends/request', { handle });
      toast(data.status === 'accepted'
        ? `Vocês agora são amigos!`
        : `Pedido enviado para ${data.user.username}.`, 'ok');
      closeModal();
      refresh.friends();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < 2) return results.replaceChildren();
    timer = setTimeout(async () => {
      const { users } = await api.get(`/users/search?q=${encodeURIComponent(query)}`);
      results.replaceChildren(...users.map((user) => el('div', { class: 'friend-row' },
        avatarNode(user, { size: 32 }),
        el('div', { class: 'meta' },
          el('div', { class: 'nm' }, `${user.username}#${user.tag}`),
          el('div', { class: 'sub' }, user.customStatus || '')),
        el('button', { class: 'btn btn-primary', onclick: () => send(user.handle) }, 'Adicionar'))));
    }, 250);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send(input.value.trim()); }
  });
  setTimeout(() => input.focus(), 50);

  return shell({
    title: 'Adicionar amigo',
    subtitle: 'Digite o nome de usuário completo, com a tag de 4 dígitos.',
    body: el('div', {}, field('Nome de usuário', input), results),
    foot: [cancelBtn(), el('button', { class: 'btn btn-primary', onclick: () => send(input.value.trim()) }, 'Enviar pedido')]
  });
}

function userCard(member, guild) {
  const isMe = member.id === state.me.id;
  const myRank = { owner: 3, admin: 2, mod: 1, member: 0 }[guild.myRole] ?? 0;
  const theirRank = { owner: 3, admin: 2, mod: 1, member: 0 }[member.role] ?? 0;
  const canModerate = !isMe && !member.isBot && myRank > theirRank && myRank >= 1;

  const friendship = state.friends.friends.some((f) => f.id === member.id);

  const act = async (fn, successMessage) => {
    try {
      await fn();
      if (successMessage) toast(successMessage, 'ok');
      closeModal();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  const moderationButtons = canModerate ? el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:16px' },
    myRank >= 2 ? el('button', {
      class: 'btn btn-ghost',
      onclick: () => sendBotCommand(`promover ${member.username} ${member.role === 'member' ? 'mod' : 'admin'}`)
    }, '⬆️ Promover') : null,
    myRank >= 2 && member.role !== 'member' ? el('button', {
      class: 'btn btn-ghost', onclick: () => sendBotCommand(`rebaixar ${member.username}`)
    }, '⬇️ Rebaixar') : null,
    el('button', { class: 'btn btn-ghost', onclick: () => sendBotCommand(`mute ${member.username} 10m`) }, '🔇 Silenciar 10m'),
    el('button', { class: 'btn btn-ghost', onclick: () => sendBotCommand(`warn ${member.username} comportamento`) }, '⚠️ Advertir'),
    el('button', { class: 'btn btn-danger', onclick: () => sendBotCommand(`kick ${member.username}`) }, '👢 Expulsar'),
    myRank >= 2 ? el('button', { class: 'btn btn-danger', onclick: () => sendBotCommand(`ban ${member.username}`) }, '🔨 Banir') : null
  ) : null;

  return shell({
    title: member.displayName,
    subtitle: `${member.username}#${member.tag}${member.isBot ? ' · BOT' : ''}`,
    body: el('div', {},
      el('div', { style: 'display:flex;gap:16px;align-items:center;margin-bottom:16px' },
        avatarNode(member, { size: 72 }),
        el('div', {},
          el('div', { style: 'font-size:13px;color:var(--text-dim)' }, member.customStatus || ''),
          el('div', { style: 'display:flex;gap:14px;margin-top:8px;font-size:13px' },
            el('span', {}, `📈 Nível ${member.level}`),
            el('span', {}, `🪙 ${member.coins.toLocaleString('pt-BR')}`),
            el('span', {}, `🏷️ ${member.role}`)))),
      member.bio ? el('p', { style: 'font-size:13px;color:var(--text-dim)' }, member.bio) : null,
      !isMe && !member.isBot ? el('div', { style: 'display:flex;gap:8px;margin-top:16px;flex-wrap:wrap' },
        el('button', { class: 'btn btn-primary', onclick: () => act(() => startDM(member.id)) }, '💬 Mensagem'),
        !friendship ? el('button', {
          class: 'btn btn-ghost',
          onclick: () => act(() => api.post('/friends/request', { handle: `${member.username}#${member.tag}` }), 'Pedido enviado!')
        }, '➕ Adicionar amigo') : null,
        el('button', {
          class: 'btn btn-ghost',
          onclick: () => act(() => api.post(`/friends/${member.id}/block`), 'Usuário bloqueado.')
        }, '🚫 Bloquear')) : null,
      moderationButtons),
    foot: [el('button', { class: 'btn btn-ghost', onclick: closeModal }, 'Fechar')]
  });
}

/** Executa um comando do bot como se o usuário tivesse digitado. */
function sendBotCommand(command) {
  const guildRef = state.guilds.find((g) => g.id === state.activeGuildId);
  const prefix = guildRef?.settings?.prefix || '!';
  socket.emit('message:send', { channelId: state.activeChannelId, content: `${prefix}${command}` }, (response) => {
    if (!response?.ok) toast(response?.error || 'Falha ao executar', 'err');
  });
  closeModal();
}

export const modals = {
  addGuild, createGuild, joinGuild, createChannel, guildMenu, invite,
  guildSettings, botPanel, userSettings, addFriend, userCard, appInvites, auditLog
};
