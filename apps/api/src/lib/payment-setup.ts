import type { Config } from '../config.js';
import { createEagleGateway } from './eagle.js';
import { webhookPath, type PaymentGateway } from './gateway.js';
import { createNovusGateway } from './novus.js';

export interface PaymentSetup {
  /** Takes new deposits and withdrawals; null = payments off. */
  gateway: PaymentGateway | null;
  /** Other configured gateways, still serving the transactions they hold. */
  previousGateways: PaymentGateway[];
  postbackUrl: string | null;
}

/** Builds the gateways from the environment and picks the one for new transactions (see PAYMENT_PROVIDER). */
export function paymentSetup(config: Config, fetchImpl?: typeof fetch): PaymentSetup {
  const eagleKeys = [config.EAGLE_CLIENT_ID, config.EAGLE_PUBLIC_KEY, config.EAGLE_SECRET_KEY];
  const eagleSome = eagleKeys.some(Boolean);
  if (eagleSome && !eagleKeys.every(Boolean)) {
    throw new Error('EaglePay: set all of EAGLE_CLIENT_ID, EAGLE_PUBLIC_KEY and EAGLE_SECRET_KEY (or none).');
  }
  const eagle =
    config.EAGLE_CLIENT_ID && config.EAGLE_PUBLIC_KEY && config.EAGLE_SECRET_KEY
      ? createEagleGateway({
          clientId: config.EAGLE_CLIENT_ID,
          publicKey: config.EAGLE_PUBLIC_KEY,
          secretKey: config.EAGLE_SECRET_KEY,
          baseUrl: config.EAGLE_API_URL,
          fetch: fetchImpl,
        })
      : null;
  const novus = config.NOVUS_API_KEY
    ? createNovusGateway({
        apiKey: config.NOVUS_API_KEY,
        webhookSecret: config.NOVUS_WEBHOOK_SECRET,
        baseUrl: config.NOVUS_API_URL,
        fetch: fetchImpl,
      })
    : null;

  const wanted = config.PAYMENT_PROVIDER ?? (eagle ? 'eagle' : novus ? 'novus' : null);
  const gateway = wanted === 'eagle' ? eagle : wanted === 'novus' ? novus : null;
  if (wanted && !gateway) {
    throw new Error(
      wanted === 'eagle'
        ? 'PAYMENT_PROVIDER=eagle needs EAGLE_CLIENT_ID, EAGLE_PUBLIC_KEY and EAGLE_SECRET_KEY.'
        : 'PAYMENT_PROVIDER=novus needs NOVUS_API_KEY.',
    );
  }
  const previousGateways = [eagle, novus].filter((g): g is PaymentGateway => g !== null && g !== gateway);
  const postbacks = config.PAYMENT_POSTBACKS ?? config.NOVUS_POSTBACKS ?? false;
  return {
    gateway,
    previousGateways,
    postbackUrl: gateway && postbacks ? `${config.PUBLIC_ORIGIN}${webhookPath(gateway.name)}` : null,
  };
}
