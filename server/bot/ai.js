'use strict';

/**
 * O Nexy conversando de verdade -- chama a API da Anthropic (Claude) em vez
 * de só casar regex com respostas prontas (isso ainda existe em fun.js
 * como fallback, pra quando a chave não está configurada ou a API falha).
 *
 * Só entra em ação quando ANTHROPIC_API_KEY existe no ambiente -- sem
 * chave, askAI() sempre devolve null e quem chamou cai pro comportamento
 * de antes, sem quebrar nada.
 */

let Anthropic = null;
let client = null;

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    Anthropic = Anthropic || require('@anthropic-ai/sdk');
    client = new Anthropic();
  }
  return client;
}

const MODEL = process.env.ANTHROPIC_BOT_MODEL || 'claude-opus-5';

const SYSTEM_PROMPT = `Você é o Nexy, o bot/assistente oficial do PlingChat (um app de chat, voz e vídeo em grupo).
Responda sempre em português do Brasil, casual e direto -- sem formalidade excessiva.
Respostas de chat costumam ser curtas (1 a 4 frases); só se estenda se a pergunta realmente pedir.
Você também tem comandos de utilidade/moderação/economia/música acessíveis via "!ajuda" -- pode citar isso quando fizer sentido, mas não é obrigatório em toda resposta.
Nunca invente que fez uma ação no app (banir alguém, tocar uma música etc.) -- você só conversa; ações de verdade passam pelos comandos com "!".`;

// Cooldown simples por usuário -- evita que alguém gaste a cota da API só
// mandando mensagem em sequência rápida.
const lastCallAt = new Map();
const COOLDOWN_MS = 6000;

function onCooldown(userId) {
  const last = lastCallAt.get(userId) || 0;
  if (Date.now() - last < COOLDOWN_MS) return true;
  lastCallAt.set(userId, Date.now());
  return false;
}

/**
 * Pede uma resposta ao Claude. `history` é uma lista de mensagens recentes
 * do canal (mais antiga primeiro), cada uma `{ author, content, mine }`.
 * Devolve o texto da resposta, ou `null` se a IA não estiver configurada,
 * a pessoa estiver no cooldown, ou a chamada falhar.
 */
async function askAI({ userId, username, content, history = [] }) {
  const anthropic = getClient();
  if (!anthropic) return null;
  if (onCooldown(userId)) return null;

  const messages = [
    ...history.map((m) => ({ role: m.mine ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content }
  ];

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      output_config: { effort: 'low' },
      messages
    });
    const text = response.content.find((b) => b.type === 'text')?.text?.trim();
    return text || null;
  } catch (err) {
    console.error('[nexy-ai] falha ao chamar a API da Anthropic:', err.message);
    return null;
  }
}

module.exports = { askAI, isEnabled: () => !!process.env.ANTHROPIC_API_KEY };
