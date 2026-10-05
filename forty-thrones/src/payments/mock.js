// Development-only provider. Sends the browser to a fake checkout page served by this app.
// config.js refuses to boot with PAYMENT_PROVIDER=mock when NODE_ENV=production.
import { config } from '../config.js';

export const mockProvider = {
  name: 'mock',
  async createCheckout(claim) {
    return { url: `${config.baseUrl}/mock-pay/${claim.id}`, providerRef: `mock-${claim.id}` };
  },
};
