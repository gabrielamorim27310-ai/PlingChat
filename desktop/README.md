# nexus67 no PC

Não é um app separado — é o mesmo `https://nexus67.vercel.app` numa janela sem barra de endereço, abas nem menu de navegador. O login, as mensagens e os dados são exatamente os mesmos de quando você usa pelo Chrome/Edge.

## Rodar em modo desenvolvimento

```
cd desktop
npm install
npm start
```

Abre uma janela carregando o site de produção. Câmera, microfone e compartilhamento de tela já são liberados automaticamente (o Electron, diferente do navegador, não pergunta sozinho).

**Compartilhar tela** abre uma janelinha com miniaturas de cada tela e cada janela aberta — escolhe qual quer mostrar, igual o Zoom/Meet fazem.

## Gerar o instalador

```
npm run icons     # só precisa rodar de novo se trocar build/icon.svg
npm run dist:win  # gera dist/nexus67 Setup <versão>.exe
npm run dist:mac  # gera um .dmg (só builda num Mac)
npm run dist:linux # gera um .AppImage
```

O `.exe` do Windows já foi gerado e testado nesta máquina — está em `desktop/dist/`. Ele não é assinado digitalmente (não temos um certificado de assinatura de código), então o Windows/SmartScreen pode avisar "editor desconhecido" na primeira instalação — é clicar em "Mais informações → Executar assim mesmo". Assinar de verdade custa um certificado pago; não é algo que dê pra resolver sem isso.

## Apontar pra outro backend/URL (dev local, por exemplo)

```
NEXUS_URL=http://localhost:3000 npm start
```

## Estrutura

- `main.js` — janela principal + permissões de mídia + escolha de tela pra compartilhar.
- `picker/` — a janelinha de "qual tela compartilhar".
- `build/icon.svg` — o logo fonte. `build/icon.png|ico|icns` são gerados a partir dele, não edite eles direto.
