// Lemon Squeezy (merchant of record). VERIFY the API shape and fees against the current docs before going live:
// https://docs.lemonsqueezy.com/api/checkouts and https://docs.lemonsqueezy.com/help/webhooks
import crypto from 'node:crypto';
import { config } from '../config.js';

export const lemonProvider = {
  name: 'lemonsqueezy',

  async createCheckout(claim, user) {
    const { apiKey, storeId, variantId } = config.lemon;
    if (!apiKey || !storeId || !variantId) throw new Error('Lemon Squeezy is not configured');
    const res = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            custom_price: claim.price_cents, // cents; tax is added on top by the merchant of record
            product_options: {
              name: `Forty Thrones: ${claim.tile_name}`,
              description: `Display space on tile "${claim.tile_name}". Non-refundable.`,
              redirect_url: `${config.baseUrl}/?claim=${claim.id}`,
            },
            checkout_data: { email: user.email, custom: { claim_id: String(claim.id) } },
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
          relationships: {
            store: { data: { type: 'stores', id: String(storeId) } },
            variant: { data: { type: 'variants', id: String(variantId) } },
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`Lemon Squeezy checkout failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return { url: json.data.attributes.url, providerRef: null };
  },

  /** Verify HMAC-SHA256 signature of the raw body. Returns {claimId, orderId, paidCents} or null for events we ignore. */
  parseWebhook(rawBody, signature) {
    const secret = config.lemon.webhookSecret;
    if (!secret || !signature) throw new Error('Missing webhook secret or signature');
    const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(digest, 'utf8');
    const b = Buffer.from(String(signature), 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Bad webhook signature');

    const payload = JSON.parse(rawBody.toString('utf8'));
    if (payload?.meta?.event_name !== 'order_created') return null;
    const attrs = payload.data?.attributes || {};
    if (attrs.status && attrs.status !== 'paid') return null;
    const claimId = Number(payload.meta?.custom_data?.claim_id);
    if (!claimId) return null;
    return { claimId, orderId: String(payload.data.id), paidCents: Number(attrs.subtotal ?? attrs.total ?? 0) };
  },
};
