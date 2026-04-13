require('dotenv').config();
const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const app = express();
app.use(express.json());

const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionString = process.env.TELEGRAM_SESSION;
const SERVICE_SECRET = process.env.SERVICE_SECRET || 'secret';

let client = null;

// Keep persistent connection
const initClient = async () => {
  client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 999,
    autoReconnect: true,
    retryDelay: 2000,
    useWSS: true,
  });
  await client.connect();
  console.log('[TG] Connected');

  // Keep alive ping every 60s
  setInterval(async () => {
    try {
      await client.invoke(new Api.Ping({ pingId: BigInt(Date.now()) }));
    } catch {}
  }, 60000);
};

// Auth middleware
const auth = (req, res, next) => {
  if (req.headers['x-service-secret'] !== SERVICE_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
};

// POST /send-stars
app.post('/send-stars', auth, async (req, res) => {
  const { telegram_user_id, amount } = req.body;
  if (!telegram_user_id || !amount) {
    return res.status(422).json({ success: false, error: 'telegram_user_id and amount required' });
  }

  try {
    const users = await client.invoke(new Api.users.GetUsers({
      id: [new Api.InputUser({ userId: BigInt(telegram_user_id), accessHash: BigInt(0) })],
    }));

    if (!users || !users[0]) throw new Error(`User ${telegram_user_id} not found`);
    const user = users[0];
    const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash });

    const giftOptions = await client.invoke(new Api.payments.GetStarsGiftOptions({ userId: inputUser }));
    const option = giftOptions.find(o => parseInt(o.stars) === parseInt(amount));
    if (!option) {
      const available = giftOptions.map(o => o.stars.toString()).join(', ');
      throw new Error(`No option for ${amount} stars. Available: ${available}`);
    }

    const purpose = new Api.InputStorePaymentStarsGift({
      userId: inputUser,
      stars: BigInt(amount),
      currency: option.currency,
      amount: option.amount,
    });

    const form = await client.invoke(new Api.payments.GetPaymentForm({
      invoice: new Api.InputInvoiceStars({ purpose }),
    }));

    await client.invoke(new Api.payments.SendStarsForm({
      formId: form.formId,
      invoice: new Api.InputInvoiceStars({ purpose }),
    }));

    console.log(`[TG] Sent ${amount} stars to ${telegram_user_id}`);
    return res.json({ success: true, external_id: form.formId?.toString() });

  } catch (err) {
    console.error('[TG] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
initClient().then(() => {
  app.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));
}).catch(err => {
  console.error('[TG] Init failed:', err.message);
  process.exit(1);
});
