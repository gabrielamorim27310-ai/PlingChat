# Implantação

> O produto se chama **PlingChat**, mas os domínios (`nexus67.vercel.app`, o repositório no GitHub) continuam com o nome antigo — trocar isso quebraria os links que já existem. Onde este documento cita `nexus67.vercel.app`, é o domínio real, não um erro de digitação.

Frontend estático na **Vercel**, backend com processo persistente no **Render**, banco de dados Postgres no **Supabase**.

O backend não roda em plataforma serverless: ele mantém conexões WebSocket abertas e guarda estado em memória (salas de voz, sinalização WebRTC, filas de música). Por isso a divisão.

O banco fica no Supabase (Postgres), não no disco do Render — o plano `free` do Render funciona bem porque um respin/redeploy não apaga mais nada.

---

## 1. Banco de dados no Supabase

1. Em [supabase.com](https://supabase.com), crie um projeto novo (free tier).
2. Em **Project Settings → Database → Connection string**, use o **Transaction Pooler** (porta `6543`), não a conexão direta — a direta é IPv6-only e não resolve em vários hosts, incluindo o Render.
   Formato: `postgresql://postgres.[ref]:[senha]@aws-0-[regiao].pooler.supabase.com:6543/postgres`
3. Guarde essa string: ela vira `DATABASE_URL` no passo seguinte. O schema é criado sozinho (`db.migrate()`) na primeira vez que o servidor sobe.

> Free tier do Supabase **pausa** (não apaga) o projeto após 7 dias sem uso — qualquer acesso reativa em segundos.

---

## 2. Backend no Render

1. Em [render.com](https://dashboard.render.com) → **New** → **Blueprint**, aponte para este repositório. O `render.yaml` já descreve o serviço.
2. Se preferir criar na mão: **New → Web Service**, runtime Node, build `npm ci --omit=dev`, start `npm start`, health check `/health`.
3. Configure as variáveis:

| Variável | Valor |
|---|---|
| `NODE_VERSION` | `24` |
| `DATABASE_URL` | a connection string do Supabase (passo 1) |
| `NEXUS_SECRET` | qualquer string longa e aleatória (o Render gera sozinho pelo blueprint) |
| `ALLOWED_ORIGINS` | `https://nexus67.vercel.app` |
| `GOOGLE_CLIENT_ID` | o Client ID do passo 4 (opcional) |

Não precisa de disco persistente — o plano `free` já serve, os dados ficam no Supabase.

Anote a URL final, algo como `https://nexus-api.onrender.com`.

> No plano free o serviço hiberna após inatividade e o primeiro acesso demora alguns segundos.

---

## 3. Frontend na Vercel

1. Em [vercel.com](https://vercel.com/new), importe o mesmo repositório. O `vercel.json` já define build e saída.
2. Adicione a variável de ambiente:

| Variável | Valor |
|---|---|
| `NEXUS_API_URL` | a URL do Render, ex. `https://nexus-api.onrender.com` |

3. Deploy. O build roda `node scripts/build-web.js`, que copia `public/` para `dist/` e injeta essa URL na meta tag `nexus-api`.

Depois do primeiro deploy, volte ao Render e coloque o domínio da Vercel em `ALLOWED_ORIGINS`.

---

## 4. Login com Google (opcional)

1. No [Google Cloud Console](https://console.cloud.google.com/apis/credentials): **Criar credenciais** → **ID do cliente OAuth** → tipo **Aplicativo da Web**.
2. Em **Origens JavaScript autorizadas**, adicione:
   - `https://nexus67.vercel.app`  ✅ já cadastrada
   - `http://localhost:3000` (para desenvolvimento) — **sem "s"**: o servidor local roda em HTTP puro, então é `http://`, não `https://`. Cadastrar com o esquema errado dá erro 400 `origin_mismatch` no login.
3. Copie o **Client ID** e coloque em `GOOGLE_CLIENT_ID` no Render.

O cliente deste projeto (`nexus-506223`) ja existe e e do tipo Web. Para rodar o SSO localmente, a origem cadastrada precisa bater exatamente com a URL da barra de endereço (protocolo, host e porta) — `http://localhost:3000`.

Não é preciso configurar URI de redirecionamento nem client secret: o fluxo usa o Google Identity Services, que devolve um ID token direto ao navegador. O backend valida esse token contra o JWKS oficial do Google (`server/google.js`) — assinatura RS256, `aud` igual ao seu Client ID e `iss` do Google.

Com a variável definida, o botão "Continuar com o Google" aparece sozinho na tela de login. Sem ela, só o login por e-mail e senha fica visível.

Contas Google com e-mail igual ao de uma conta existente são **vinculadas**, não duplicadas.

---

## 5. Cadastro por convite

O `SIGNUP_MODE` vem como `invite`: só cria conta quem apresentar um código. A **primeira conta do banco é sempre liberada** — é ela que gera os primeiros convites, em **Perfil → Meus convites de cadastro**.

Cada pessoa pode manter até `MAX_INVITES_PER_USER` convites ativos (padrão 5), com 1, 5 ou 25 usos cada. O link `https://SEU-APP/?cadastro=CODIGO` já abre a tela de cadastro com o código preenchido.

Para abrir a qualquer um, defina `SIGNUP_MODE=open`.

---

## 6. E-mail: verificação e recuperação de senha (opcional)

Sem isso configurado, **não existe recuperação de senha** — quem esquecer a senha perde a conta. O botão "Esqueci minha senha" só aparece quando o envio está ativo.

1. Crie uma conta no [Resend](https://resend.com) e gere uma API key.
2. Configure no Render:

| Variável | Valor |
|---|---|
| `RESEND_API_KEY` | a chave gerada |
| `MAIL_FROM` | `PlingChat <nao-responda@plingchat.com>` |
| `APP_URL` | `https://plingchat.com` — usado para montar os links do e-mail |

`plingchat.com` já está verificado no Resend — sem isso, ele só entregaria pro e-mail da própria conta (foi exatamente esse bug que fazia amigos não receberem o e-mail de confirmação).

Quem entra pelo Google já vem com e-mail confirmado — o Google atesta isso no próprio token.

---

## 7. Turnstile / CAPTCHA (opcional)

1. Em [Cloudflare Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile), crie um widget para o domínio `nexus67.vercel.app`.
2. Configure no Render:

| Variável | Valor |
|---|---|
| `TURNSTILE_SITE_KEY` | chave pública (vai para o navegador) |
| `TURNSTILE_SECRET_KEY` | chave secreta |

Com as duas presentes, o desafio aparece no cadastro, no login e na recuperação de senha. Faltando qualquer uma, ele fica desligado e nada quebra.

---

## 8. Nexy responder com IA de verdade (opcional, de graça)

Sem isso, o Nexy só responde por regras fixas (saudação, "quem é você" etc. — ver `server/bot/commands/fun.js`). Com a chave configurada, ele passa a responder de verdade via [Groq](https://console.groq.com) em qualquer DM e quando chamado pelo nome ("nexy") num canal de servidor.

A Groq foi escolhida porque o plano gratuito é de verdade: sem cartão de crédito, sem cobrança por uso, com limite de pedidos por minuto/dia (dá bem pra um bot de servidor). Ela hospeda modelos open-weight (Llama, o `gpt-oss` da própria OpenAI, etc.) no hardware acelerado deles — a resposta sai bem rápida.

1. Crie uma conta em [console.groq.com](https://console.groq.com/keys) e gere uma API key (não pede cartão).
2. Configure no Render:

| Variável | Valor |
|---|---|
| `GROQ_API_KEY` | a chave gerada |
| `GROQ_MODEL` | opcional — modelo a usar (padrão `openai/gpt-oss-120b`, o de melhor qualidade disponível de graça lá hoje). Pra mais volume/velocidade em troca de um pouco de qualidade, `llama-3.3-70b-versatile` é outra opção boa. |

Sem chave configurada, nada muda — o bot segue no modo de sempre. Cada resposta em DM carrega as últimas mensagens da conversa como contexto; menções em canal de servidor são avulsas (sem histórico), pra não misturar o papo alheio do canal. Se o limite gratuito da Groq estourar num pico de uso, a chamada falha silenciosamente e cai pro fallback de regras fixas — ninguém vê erro.

---

## 9. Antes de abrir para outras pessoas

- **Servidor TURN.** Hoje só há STUN público. Duas pessoas atrás de NAT restrito (4G, redes corporativas) podem não conseguir fechar a conexão de voz/vídeo. Um TURN (coturn próprio, Twilio, Metered) resolve; a lista fica em `ICE_SERVERS`, no topo de `public/js/voice.js`.
- **Escala da malha de voz.** A conexão é ponto a ponto entre todos os participantes: cada pessoa envia sua mídia para todas as outras. Funciona bem até ~6 pessoas por canal. Acima disso, o caminho é um SFU (mediasoup, LiveKit, Janus).
- **Instância única.** O estado de voz vive na memória do processo. Escalar para várias instâncias exige um adaptador do Socket.IO (Redis) e mover esse estado para fora.
- **Banco.** Já é Postgres (Supabase) — pronto para múltiplas instâncias do backend sem mudar nada.
