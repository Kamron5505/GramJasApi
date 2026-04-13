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

const newClient = () => new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
  connectionRetries: 3,
  autoReconnect: true,
  retryDelay: 1000,
});

let client = newClient();

const connect = async () => {
  try {
    await client.connect();
    console.log('[TG] Connected');
  } catch (e) {
    console.error('[TG] Connect error:', e.message);
  }
};

// Auth
const auth = (req, res, next) => {
  if (req.headers['x-service-secret'] !== SERVICE_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
};

// Invoke with auto-retry on disconnect
const invoke = async (method, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      if (!client.connected) {
        console.log('[TG] Not connected, reconnecting...');
        client = newClient();
        await client.connect();
      }
      return await client.invoke(method);
    } catch (e) {
      console.error(`[TG] Invoke error (attempt ${i+1}):`, e.message);
      if (i < retries - 1) {
        client = newClient();
        await client.connect();
        await new Promise(r => setTimeout(r, 1000));
      } else {
        throw e;
      }
    }
  }
};

app.get('/', (req, res) => res.json({ status: 'ok', connected: client?.connected || false }));

app.post('/send-stars', auth, async (req, res) => {
  const { telegram_user_id, amount } = req.body;
  if (!telegram_user_id || !amount) {
    return res.status(422).json({ success: false, error: 'telegram_user_id and amount required' });
  }

  try {
    const users = await invoke(new Api.users.GetUsers({
      id: [new Api.InputUser({ userId: BigInt(telegram_user_id), accessHash: BigInt(0) })],
    }));

    if (!users?.[0]) throw new Error(`User ${telegram_user_id} not found`);
    const user = users[0];
    const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash });

    const giftOptions = await invoke(new Api.payments.GetStarsGiftOptions({ userId: inputUser }));
    const option = giftOptions.find(o => parseInt(o.stars) === parseInt(amount));
    if (!option) throw new Error(`No option for ${amount} stars. Available: ${giftOptions.map(o => o.stars).join(', ')}`);

    const purpose = new Api.InputStorePaymentStarsGift({
      userId: inputUser,
      stars: BigInt(amount),
      currency: option.currency,
      amount: option.amount,
    });

    const form = await invoke(new Api.payments.GetPaymentForm({
      invoice: new Api.InputInvoiceStars({ purpose }),
    }));

    await invoke(new Api.payments.SendStarsForm({
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

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  connect();
});
