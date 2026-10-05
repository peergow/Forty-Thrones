import { config } from '../config.js';
import { mockProvider } from './mock.js';
import { lemonProvider } from './lemonsqueezy.js';

export function getProvider() {
  if (config.paymentProvider === 'lemonsqueezy') return lemonProvider;
  if (config.paymentProvider === 'mock') return mockProvider;
  throw new Error(`Unknown PAYMENT_PROVIDER: ${config.paymentProvider}`);
}
