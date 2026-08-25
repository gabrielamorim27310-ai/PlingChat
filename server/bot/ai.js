'use strict';

/**
 * O Nexy conversando de verdade -- chama a Groq (LLM gratuita, sem cartão
 * de crédito, hospeda modelos open-weight em hardware próprio bem rápido)
 * em vez de só casar regex com respostas prontas (isso ainda existe em
 * fun.js como fallback, pra quando a chave não está configurada ou a
 * chamada falha).
 *
 * Só entra em ação quando GROQ_API_KEY existe no ambiente -- sem chave,
 * askAI() sempre devolve null e quem chamou cai pro comportamento de
 * antes, sem quebrar nada. API compatível com o formato da OpenAI, então
 * é só um fetch -- não precisa de SDK nenhum.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// gpt-oss-120b: o modelo de maior qualidade disponível de graça na Groq
// hoje (é o modelo open-weight da própria OpenAI, hospedado lá). Troque
// via GROQ_MODEL se quiser outro (ex.: llama-3.3-70b-versatile).
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

const SYSTEM_PROMPT = `Você é o Nexy, o bot/assistente oficial do PlingChat (um app de chat, voz e vídeo em grupo).
Responda sempre em português do Brasil, casual e direto -- sem formalidade excessiva.
Respostas de chat costumam ser curtas (1 a 4 frases); só se estenda se a pergunta realmente pedir.
Você também tem comandos de utilidade/moderação/economia/música acessíveis via "!ajuda" -- pode citar isso quando fizer sentido, mas não é obrigatório em toda resposta.
Nunca invente que fez uma ação no app (banir alguém, tocar uma música etc.) -- você só conversa; ações de verdade passam pelos comandos com "!".`;

// Cooldown simples por usuário -- o plano gratuito da Groq tem limite de
// pedidos por minuto/dia; isso evita que alguém estoure a cota so
// mandando mensagem em sequencia rapida.
const lastCallAt = new Map();
const COOLDOWN_MS = 6000;

function onCooldown(userId) {
  const last = lastCallAt.get(userId) || 0;
  if (Date.now() - last < COOLDOWN_MS) return true;
  lastCallAt.set(userId, Date.now());
  return false;
}

/**
 * Pede uma resposta a Groq. `history` é uma lista de mensagens recentes
 * do canal (mais antiga primeiro), cada uma `{ content, mine }`.
 * Devolve o texto da resposta, ou `null` se a IA não estiver configurada,
 * a pessoa estiver no cooldown, ou a chamada falhar (limite gratuito
 * estourado, rede fora, etc).
 */
async function askAI({ userId, content, history = [] }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  if (onCooldown(userId)) return null;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.mine ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content }
  ];

  try {
    const resp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_completion_tokens: 512,
        // gpt-oss é um modelo "raciocinador" -- sem isso ele às vezes
        // vaza o próprio raciocínio interno na resposta em vez de só a
        // resposta final. "low" mantém rápido e barato pra bate-papo casual.
        reasoning_effort: 'low',
        include_reasoning: false
      })
    });
    if (!resp.ok) {
      console.error('[nexy-ai] Groq respondeu', resp.status, await resp.text().catch(() => ''));
      return null;
    }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('[nexy-ai] falha ao chamar a Groq:', err.message);
    return null;
  }
}

module.exports = { askAI, isEnabled: () => !!process.env.GROQ_API_KEY };
