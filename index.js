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

// Маппинг названий подарков на gift_id (получается через getStarGifts)
const GIFT_NAME_MAP = {
  'Yurak':    null,
  'Ayiqcha':  null,
  "Sovg'a":   null,
  'Atirgul':  null,
  'Tort':     null,
  'Raketa':   null,
  'Shampan':  null,
  'Guldasta': null,
  'Olmos':    null,
  'Kubok':    null,
  'Uzuk':     null,
};

// Fetch and cache gift list
let cachedGifts = null;
const getGifts = async () => {
  if (cachedGifts) return cachedGifts;
  const result = await invoke(new Api.payments.GetStarGifts({ hash: 0 }));
  cachedGifts = result.gifts;
  setTimeout(() => { cachedGifts = null; }, 60 * 60 * 1000); // cache 1h
  return cachedGifts;
};

app.get('/gifts', auth, async (req, res) => {
  try {
    const gifts = await getGifts();
    return res.json({ success: true, gifts: gifts.map(g => ({ id: g.id.toString(), stars: g.stars, limited: g.limited || false })) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/send-gift', auth, async (req, res) => {
  const { telegram_user_id, gift_id } = req.body;
  if (!telegram_user_id || !gift_id) {
    return res.status(422).json({ success: false, error: 'telegram_user_id and gift_id required' });
  }

  try {
    const users = await invoke(new Api.users.GetUsers({
      id: [new Api.InputUser({ userId: BigInt(telegram_user_id), accessHash: BigInt(0) })],
    }));
    if (!users?.[0]) throw new Error(`User ${telegram_user_id} not found`);
    const user = users[0];
    const peer = new Api.InputPeerUser({ userId: user.id, accessHash: user.accessHash });

    const purpose = new Api.InputInvoiceStarGift({
      peer,
      giftId: BigInt(gift_id),
      hideName: false,
    });

    const form = await invoke(new Api.payments.GetPaymentForm({
      invoice: purpose,
    }));

    await invoke(new Api.payments.SendStarsForm({
      formId: form.formId,
      invoice: purpose,
    }));

    console.log(`[TG] Sent gift ${gift_id} to ${telegram_user_id}`);
    return res.json({ success: true, external_id: form.formId?.toString() });

  } catch (err) {
    console.error('[TG] send-gift error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

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
