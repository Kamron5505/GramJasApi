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
const PORT = process.env.PORT || 8080;

let client = null;

const createClient = () => new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
  connectionRetries: 5,
  autoReconnect: true,
  retryDelay: 2000,
});

const getClient = async () => {
  if (!client) client = createClient();
  if (!client.connected) await client.connect();
  return client;
};

// Auth middleware
const auth = (req, res, next) => {
  if (req.headers['x-service-secret'] !== SERVICE_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
};

app.get('/', (req, res) => {
  res.json({ status: 'ok', connected: client?.connected || false });
});

app.post('/send-stars', auth, async (req, res) => {
  const { telegram_user_id, amount } = req.body;
  if (!telegram_user_id || !amount) {
    return res.status(422).json({ success: false, error: 'telegram_user_id and amount required' });
  }

  try {
    const tg = await getClient();

    const users = await tg.invoke(new Api.users.GetUsers({
      id: [new Api.InputUser({ userId: BigInt(telegram_user_id), accessHash: BigInt(0) })],
    }));

    if (!users || !users[0]) throw new Error(`User ${telegram_user_id} not found`);
    const user = users[0];
    const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash });

    const giftOptions = await tg.invoke(new Api.payments.GetStarsGiftOptions({ userId: inputUser }));
    const option = giftOptions.find(o => parseInt(o.stars) === parseInt(amount));
    if (!option) {
      throw new Error(`No option for ${amount} stars. Available: ${giftOptions.map(o => o.stars).join(', ')}`);
    }

    const purpose = new Api.InputStorePaymentStarsGift({
      userId: inputUser,
      stars: BigInt(amount),
      currency: option.currency,
      amount: option.amount,
    });

    const form = await tg.invoke(new Api.payments.GetPaymentForm({
      invoice: new Api.InputInvoiceStars({ purpose }),
    }));

    await tg.invoke(new Api.payments.SendStarsForm({
      formId: form.formId,
      invoice: new Api.InputInvoiceStars({ purpose }),
    }));

    console.log(`[TG] Sent ${amount} stars to ${telegram_user_id}`);
    return res.json({ success: true, external_id: form.formId?.toString() });

  } catch (err) {
    console.error('[TG] Error:', err.message);
    // Reset client on connection error
    if (err.message.includes('Not connected') || err.message.includes('connection')) {
      client = null;
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Start HTTP server immediately
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  // Connect TG in background
  getClient().then(() => console.log('[TG] Ready')).catch(e => console.error('[TG] Init error:', e.message));
});
