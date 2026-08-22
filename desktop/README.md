# nexus67 no PC

Não é um app separado — é o mesmo `https://nexus67.vercel.app` numa janela sem barra de endereço, abas nem menu de navegador. O login, as mensagens e os dados são exatamente os mesmos de quando você usa pelo Chrome/Edge.

## Rodar

```
cd desktop
npm install
npm start
```

Abre uma janela carregando o site de produção. Câmera, microfone e compartilhamento de tela já são liberados automaticamente (o Electron, diferente do navegador, não pergunta sozinho).

## Limitações de hoje

- **Compartilhar tela sempre compartilha a tela inteira** — ainda não dá pra escolher uma janela específica. É a próxima melhoria natural aqui.
- **Sem ícone próprio** — usa o ícone padrão do Electron. Falta gerar um `.ico`/`.icns` a partir do logo.
- **Sem instalador** — hoje só roda com `npm start`. Pra virar um `.exe`/`.dmg` instalável de verdade, o próximo passo é configurar o `electron-builder`.
- **Sem auto-update** — cada atualização do site já aparece sozinha (é só uma página carregada), mas atualizações do próprio Electron (segurança do Chromium embutido) exigiriam reinstalar.

## Apontar pra outro backend/URL (dev local, por exemplo)

```
NEXUS_URL=http://localhost:3000 npm start
```
