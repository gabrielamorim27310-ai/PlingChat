'use strict';

/**
 * Comunidades pagas via Stripe Connect: cada dono de servidor recebe numa
 * conta Connect Express própria (a Stripe cuida do KYC/verificação); quem
 * assina paga na PLATAFORMA e uma "destination charge" repassa o valor pro
 * dono, descontando a comissão do PlingChat (PLATFORM_FEE_PERCENT).
 *
 * Só entra em ação com STRIPE_SECRET_KEY configurada -- sem isso, toda
 * função aqui recusa com um erro claro (ou devolve false/null) e quem
 * chamou trata como "monetização desligada", sem derrubar o resto do app.
 */

const store = require('./store');

let Stripe = null;
let client = null;

function getClient() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!client) {
    Stripe = Stripe || require('stripe');
    client = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return client;
}

const isEnabled = () => !!process.env.STRIPE_SECRET_KEY;

// Comissão da plataforma -- combinada mais pra frente (ver DEPLOY.md);
// até lá fica em 0%, ou seja, o dono recebe o valor cheio.
const PLATFORM_FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT || 0);

const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

/* ---------------------------------------------------------- onboarding -- */

/** Garante uma conta Connect Express pro dono do servidor e devolve um
 * link de onboarding hospedado pela própria Stripe (KYC, conta bancária
 * etc. -- nada disso passa pelo nosso servidor). */
async function createOnboardingLink(user) {
  const stripe = getClient();
  if (!stripe) throw new Error('Pagamentos não configurados no servidor.');

  let accountId = user.stripe_account_id;
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      email: user.email || undefined,
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } }
    });
    accountId = account.id;
    await store.setStripeAccountId(user.id, accountId);
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${APP_URL}/?stripe_refresh=1`,
    return_url: `${APP_URL}/?stripe_onboarded=1`,
    type: 'account_onboarding'
  });

  return link.url;
}

/** A conta Connect do dono já está liberada pra receber pagamento de
 * verdade? (onboarding tem etapas -- só fica pronta quando a Stripe
 * aprova os dados enviados). */
async function isAccountReady(accountId) {
  const stripe = getClient();
  if (!stripe || !accountId) return false;
  const account = await stripe.accounts.retrieve(accountId);
  return !!account.charges_enabled;
}

/* ----------------------------------------------------------- preço/plano */

/** Cria o preço mensal de acesso ao servidor. Price é imutável na Stripe
 * -- trocar o valor sempre gera uma Price nova; a antiga só fica órfã
 * (assinantes já ativos continuam na Price antiga até renovar/recriar). */
async function createGuildPrice(guild, priceCents) {
  const stripe = getClient();
  if (!stripe) throw new Error('Pagamentos não configurados no servidor.');
  if (!Number.isInteger(priceCents) || priceCents < 100) throw new Error('Preço mínimo é R$ 1,00.');

  const product = await stripe.products.create({ name: `Acesso a ${guild.name}`, metadata: { guildId: guild.id } });
  const price = await stripe.prices.create({
    product: product.id,
    currency: 'brl',
    unit_amount: priceCents,
    recurring: { interval: 'month' }
  });
  return price.id;
}

/* ---------------------------------------------------------------- checkout */

/** Sessão de checkout pra alguém assinar o acesso a um servidor pago --
 * devolve a URL da página hospedada pela Stripe pra redirecionar a pessoa. */
async function createCheckoutSession({ guild, priceId, ownerAccountId, buyer }) {
  const stripe = getClient();
  if (!stripe) throw new Error('Pagamentos não configurados no servidor.');

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    payment_method_types: ['card', 'pix'],
    ...(buyer.stripe_customer_id
      ? { customer: buyer.stripe_customer_id }
      : { customer_email: buyer.email || undefined }),
    client_reference_id: buyer.id,
    subscription_data: {
      transfer_data: { destination: ownerAccountId },
      application_fee_percent: PLATFORM_FEE_PERCENT,
      metadata: { guildId: guild.id, userId: buyer.id }
    },
    metadata: { guildId: guild.id, userId: buyer.id },
    success_url: `${APP_URL}/?stripe=success&guild=${guild.id}`,
    cancel_url: `${APP_URL}/?stripe=cancel&guild=${guild.id}`
  });
  return session.url;
}

/* ------------------------------------------------------------- webhook -- */

/** Verifica a assinatura do webhook -- `rawBody` precisa ser o Buffer cru
 * da requisição, sem passar pelo parser de JSON (senão a assinatura não
 * bate). Lança se a assinatura for inválida. */
function constructEvent(rawBody, signature) {
  const stripe = getClient();
  if (!stripe) throw new Error('Pagamentos não configurados no servidor.');
  if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET não configurado.');
  return stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

/** Processa um evento já verificado. Cada assinatura de servidor é
 * espelhada em guild_subscriptions (cache local do status real na
 * Stripe); a entrada/saída do servidor acompanha esse status. */
async function handleWebhookEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode !== 'subscription') break;
      const { guildId, userId } = session.metadata || {};
      if (!guildId || !userId) break;
      if (session.customer) await store.setStripeCustomerId(userId, session.customer);
      // A assinatura em si (status/current_period_end) chega no evento
      // customer.subscription.* -- aqui só garante que a pessoa já entra
      // no servidor assim que o checkout fecha, sem esperar o segundo evento.
      if (!(await store.getMember(guildId, userId))) await store.addMember(guildId, userId);
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const { guildId, userId } = sub.metadata || {};
      if (!guildId || !userId) break;
      await store.upsertGuildSubscription({
        guildId, userId, stripeSubscriptionId: sub.id, status: sub.status,
        currentPeriodEnd: sub.current_period_end ? sub.current_period_end * 1000 : null
      });
      if (['active', 'trialing'].includes(sub.status) && !(await store.getMember(guildId, userId))) {
        await store.addMember(guildId, userId);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const { guildId, userId } = sub.metadata || {};
      if (!guildId || !userId) break;
      await store.upsertGuildSubscription({
        guildId, userId, stripeSubscriptionId: sub.id, status: 'canceled', currentPeriodEnd: null
      });
      // Assinatura cancelada/expirada -- acesso ao servidor acaba junto.
      await store.removeMember(guildId, userId).catch(() => { /* já pode ter saído sozinho */ });
      break;
    }

    default:
      break; // evento que não usamos -- Stripe manda vários tipos, ignora o resto
  }
}

module.exports = {
  isEnabled, createOnboardingLink, isAccountReady, createGuildPrice,
  createCheckoutSession, constructEvent, handleWebhookEvent
};
