# ⬢ nexus67

Plataforma de comunidade no estilo Discord: **servidores com canais**, **amizades e mensagens diretas**, **chamadas de voz e vídeo com compartilhamento de tela** e um **bot completo já embutido no app** — sem depender de nenhum serviço externo.

---

## O que já funciona

### Servidores
- Criar servidor (nasce com `#geral`, `#bot-comandos` e uma sala de voz)
- Convite por código de 8 caracteres ou link direto
- Canais de texto e de voz, criados e removidos por admins
- Cargos com hierarquia: `owner` → `admin` → `mod` → `member`
- Banimentos, expulsões e silenciamentos com hierarquia respeitada

### Amizades e DMs
- Pedido de amizade por `usuario#0000`, com busca por nome
- Aceitar, recusar, remover e bloquear
- Conversas diretas com notificação e contador de não lidas
- Lista de amigos separada por online / todos / pendentes / bloqueados

### Chat
- Tempo real via WebSocket, com histórico paginado
- Responder, editar, apagar, reagir com emoji
- Indicador de "está digitando", agrupamento de mensagens e separadores por dia
- Markdown reduzido: `**negrito**`, `*itálico*`, `~~riscado~~`, `` `código` ``, blocos de código, títulos e links

### Voz, vídeo e tela
- Malha WebRTC ponto a ponto (mesh), com sinalização pelo próprio servidor
- Áudio com cancelamento de eco e supressão de ruído
- Câmera e **compartilhamento de tela** simultâneos (streams separadas)
- Detecção de quem está falando, mudo, ensurdecer
- Chamadas diretas em DM com tela de "chamada recebida"
- Negociação no padrão *perfect negotiation*, sem colisão de ofertas

### 🤖 Nexy — o bot integrado
Não é um bot externo com token: ele roda **dentro do servidor da aplicação**, escutando o mesmo barramento de mensagens que os usuários. Entra automaticamente em servidores novos e pode ser adicionado/removido pelo painel 🤖.

| Categoria | Comandos |
|---|---|
| **Utilidades** | `ajuda` `ping` `uptime` `avatar` `userinfo` `serverinfo` `convite` `enquete` `lembrete` `calc` `escolher` `dado` `sorteio` `membros` `dizer` `embed` |
| **Moderação** | `kick` `ban` `unban` `banidos` `mute` `unmute` `warn` `warns` `limparwarns` `limpar` `promover` `rebaixar` `apelido` |
| **Economia** | `saldo` `daily` `trabalhar` `crime` `pagar` `depositar` `sacar` `roubar` `loja` `comprar` `inventario` `ranking` `apostar` `slots` |
| **Níveis** | `nivel` `top` `darxp` `resetxp` |
| **Diversão** | `8ball` `piada` `frase` `ship` `casar` `divorciar` `ppt` `quiz` `responder` `abracar` `tapa` `roleta` `gado` `ascii` |
| **Música** | `tocar` `fila` `agora` `pular` `pausar` `parar` `embaralhar` `remover` |
| **Configuração** | `config` `prefixo` `boasvindas` `despedida` `logs` `automod` `niveis` `mensagemnivel` `addcmd` `delcmd` `listcmd` |

Além dos comandos:
- **XP automático** por conversar, com mensagem de level up e bônus em moedas
- **Auto-moderação**: anti-spam, bloqueio de links, bloqueio de CAPS e lista de palavras proibidas
- **Boas-vindas e despedidas** com `{user}`, `{server}`, `{count}`
- **Canal de logs** de moderação
- **Comandos personalizados** por servidor
- Responde quando chamado pelo nome ("Nexy, tudo bem?")

> O player de música sincroniza uma URL direta de áudio (`.mp3`, `.ogg`, `.m4a`, `.wav` ou stream de rádio) entre todos que estão no canal de voz. Não há extração de YouTube.

---

## Rodando localmente

```bash
npm install
npm start
```

Abra `http://localhost:3000`, crie uma conta e pronto.

**Requisito:** Node.js 22.5+ (o banco usa o módulo nativo `node:sqlite`, sem dependência compilada). Testado no Node 24.

### Câmera e microfone na rede local

`getUserMedia` só funciona em contexto seguro. Em `localhost` o HTTP basta; para acessar de outro dispositivo da rede, coloque `cert.pem` e `key.pem` em `data/` e o servidor sobe em HTTPS automaticamente.

```bash
# certificado autoassinado para uso em rede local
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout data/key.pem -out data/cert.pem -subj "/CN=localhost"
```

---

## Arquitetura

```
server/
  index.js        HTTP/HTTPS + estáticos + SPA
  db.js           schema SQLite (node:sqlite, zero dependência nativa)
  store.js        camada de domínio — usada por REST, sockets e bot
  auth.js         registro, login, JWT
  api.js          rotas REST
  realtime.js     Socket.IO: chat, presença, sinalização WebRTC
  bot/
    index.js      núcleo do bot: dispatch, XP, automod, agendador
    commands/     utilidades, moderação, economia, níveis, diversão, música, config
public/
  index.html      shell da aplicação
  css/style.css   tema escuro
  js/
    app.js        estado, sockets e renderização
    voice.js      malha WebRTC (voz, vídeo, tela)
    modals.js     diálogos (servidor, bot, perfil, amigos)
    util.js       DOM, markdown, datas
    api.js        cliente REST
```

O estado vive em SQLite (`data/nexus.db`, criado no primeiro boot) e o tempo real em Socket.IO. Não há serviço externo, chave de API ou dependência nativa.

---

## Implantação

Frontend na Vercel, backend no Render — passo a passo em [DEPLOY.md](DEPLOY.md).

## Notas de implantação

O backend mantém **conexões WebSocket persistentes** e **estado em memória** (salas de voz, filas de música), além de gravar em um arquivo SQLite. Isso exige um host com processo de longa duração — Render, Railway, Fly.io, uma VPS ou similar. Plataformas puramente serverless não sustentam esse modelo sem trocar o transporte e o armazenamento.

Para produção, considere ainda:
- Definir `NEXUS_SECRET` (senão o segredo é gerado em `data/.secret`)
- Um servidor **TURN** além do STUN — sem ele, chamadas entre redes com NAT restrito podem não conectar
- Volume persistente montado em `data/`
