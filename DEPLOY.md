# Implantação

Frontend estático na **Vercel**, backend com processo persistente no **Render**.

O backend não roda em plataforma serverless: ele mantém conexões WebSocket abertas, guarda estado em memória (salas de voz, sinalização WebRTC, filas de música) e grava num arquivo SQLite. Por isso a divisão.

---

## 1. Backend no Render

1. Em [render.com](https://dashboard.render.com) → **New** → **Blueprint**, aponte para este repositório. O `render.yaml` já descreve o serviço.
2. Se preferir criar na mão: **New → Web Service**, runtime Node, build `npm ci --omit=dev`, start `npm start`, health check `/health`.
3. Configure as variáveis:

| Variável | Valor |
|---|---|
| `NODE_VERSION` | `24` |
| `NEXUS_SECRET` | qualquer string longa e aleatória (o Render gera sozinho pelo blueprint) |
| `ALLOWED_ORIGINS` | `https://nexus67.vercel.app` |
| `GOOGLE_CLIENT_ID` | o Client ID do passo 3 (opcional) |

4. **Disco persistente:** monte um volume em `/opt/render/project/src/data`. Sem ele o banco é apagado a cada deploy. Isso exige plano pago — o `free` não suporta disco.

Anote a URL final, algo como `https://nexus-api.onrender.com`.

> No plano free o serviço hiberna após inatividade e o primeiro acesso demora alguns segundos.

---

## 2. Frontend na Vercel

1. Em [vercel.com](https://vercel.com/new), importe o mesmo repositório. O `vercel.json` já define build e saída.
2. Adicione a variável de ambiente:

| Variável | Valor |
|---|---|
| `NEXUS_API_URL` | a URL do Render, ex. `https://nexus-api.onrender.com` |

3. Deploy. O build roda `node scripts/build-web.js`, que copia `public/` para `dist/` e injeta essa URL na meta tag `nexus-api`.

Depois do primeiro deploy, volte ao Render e coloque o domínio da Vercel em `ALLOWED_ORIGINS`.

---

## 3. Login com Google (opcional)

1. No [Google Cloud Console](https://console.cloud.google.com/apis/credentials): **Criar credenciais** → **ID do cliente OAuth** → tipo **Aplicativo da Web**.
2. Em **Origens JavaScript autorizadas**, adicione:
   - `https://nexus67.vercel.app`  ✅ já cadastrada
   - `http://localhost:3000` (para desenvolvimento) ⚠️ **ainda falta cadastrar**
3. Copie o **Client ID** e coloque em `GOOGLE_CLIENT_ID` no Render.

O cliente deste projeto (`nexus-506223`) ja existe e e do tipo Web. Para rodar o SSO localmente, adicione `http://localhost:3000` nas origens da mesma credencial.

Não é preciso configurar URI de redirecionamento nem client secret: o fluxo usa o Google Identity Services, que devolve um ID token direto ao navegador. O backend valida esse token contra o JWKS oficial do Google (`server/google.js`) — assinatura RS256, `aud` igual ao seu Client ID e `iss` do Google.

Com a variável definida, o botão "Continuar com o Google" aparece sozinho na tela de login. Sem ela, só o login por e-mail e senha fica visível.

Contas Google com e-mail igual ao de uma conta existente são **vinculadas**, não duplicadas.

---

## 4. Antes de abrir para outras pessoas

- **Servidor TURN.** Hoje só há STUN público. Duas pessoas atrás de NAT restrito (4G, redes corporativas) podem não conseguir fechar a conexão de voz/vídeo. Um TURN (coturn próprio, Twilio, Metered) resolve; a lista fica em `ICE_SERVERS`, no topo de `public/js/voice.js`.
- **Escala da malha de voz.** A conexão é ponto a ponto entre todos os participantes: cada pessoa envia sua mídia para todas as outras. Funciona bem até ~6 pessoas por canal. Acima disso, o caminho é um SFU (mediasoup, LiveKit, Janus).
- **Instância única.** O estado de voz vive na memória do processo. Escalar para várias instâncias exige um adaptador do Socket.IO (Redis) e mover esse estado para fora.
- **Banco.** SQLite aguenta bem esse volume, mas depende do disco montado. Para múltiplas instâncias, troque por Postgres.
