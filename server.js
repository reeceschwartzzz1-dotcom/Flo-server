require('dotenv').config();

process.on('uncaughtException', (err) => { console.error('[CRASH] uncaughtException:', err); });
process.on('unhandledRejection', (reason) => { console.error('[CRASH] unhandledRejection:', reason); });
process.on('exit', (code) => { console.log('[EXIT] Process exiting with code:', code); });
const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Clients ──────────────────────────────────────────────────────────────────

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});
const plaid = new PlaidApi(plaidConfig);

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service key for server-side admin access
);

// ─── Auth middleware ──────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    console.log('[Auth] No token provided');
    return res.status(401).json({ message: 'Unauthorized' });
  }

  console.log('[Auth] Token received, length:', token.length);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error) console.log('[Auth] Supabase error:', error.message);
  if (!user) console.log('[Auth] No user returned');
  if (error || !user) return res.status(401).json({ message: 'Invalid token' });

  console.log('[Auth] User authenticated:', user.id);
  req.user = user;
  next();
}

// ─── Plaid routes ─────────────────────────────────────────────────────────────

// Create a Plaid Link token
app.post('/api/plaid/link-token', requireAuth, async (req, res) => {
  try {
    const response = await plaid.linkTokenCreate({
      user: { client_user_id: req.user.id },
      client_name: 'Flo',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
      redirect_uri: 'https://flo-server-production.up.railway.app/oauth-return',
    });
    res.json({ link_token: response.data.link_token });
  } catch (e) {
    console.error('[Plaid] link-token error:', e.response?.data || e.message);
    res.status(500).json({ message: 'Could not create link token' });
  }
});

// Exchange public token for access token
app.post('/api/plaid/exchange', requireAuth, async (req, res) => {
  const { public_token } = req.body;
  try {
    const exchangeRes = await plaid.itemPublicTokenExchange({ public_token });
    const accessToken = exchangeRes.data.access_token;
    const itemId = exchangeRes.data.item_id;

    // Get institution info
    const itemRes = await plaid.itemGet({ access_token: accessToken });
    const institutionId = itemRes.data.item.institution_id;
    let institutionName = 'My Bank';
    if (institutionId) {
      const instRes = await plaid.institutionsGetById({
        institution_id: institutionId,
        country_codes: ['US'],
      });
      institutionName = instRes.data.institution.name;
    }

    // Save connection to Supabase (access token stored server-side only)
    const { error } = await supabase.from('plaid_connections').insert({
      user_id: req.user.id,
      institution_id: institutionId || 'unknown',
      institution_name: institutionName,
      plaid_item_id: itemId,
      plaid_access_token: accessToken, // add this column to your schema
    });
    if (error) throw error;

    // Sync accounts immediately
    await syncAccounts(req.user.id, accessToken, itemId);

    res.json({ success: true, institution_name: institutionName });
  } catch (e) {
    console.error('[Plaid] exchange error:', e.response?.data || e.message);
    res.status(500).json({ message: 'Could not connect bank account' });
  }
});

// Sync transactions
app.post('/api/plaid/sync', requireAuth, async (req, res) => {
  try {
    const { data: connections } = await supabase
      .from('plaid_connections')
      .select('*')
      .eq('user_id', req.user.id);

    let totalSynced = 0;
    for (const conn of connections || []) {
      await syncTransactions(req.user.id, conn.plaid_access_token, conn.id);
      totalSynced++;
    }

    res.json({ synced: totalSynced });
  } catch (e) {
    console.error('[Plaid] sync error:', e.message);
    res.status(500).json({ message: 'Sync failed' });
  }
});

// ─── Budget route ─────────────────────────────────────────────────────────────

app.get('/api/budget/safe-to-spend', requireAuth, async (req, res) => {
  try {
    const month = new Date().toISOString().slice(0, 7);
    const startOfMonth = `${month}-01`;
    const now = new Date().toISOString().slice(0, 10);

    // Get all transactions this month
    const { data: transactions } = await supabase
      .from('transactions')
      .select('amount, category, date')
      .eq('user_id', req.user.id)
      .gte('date', startOfMonth)
      .lte('date', now);

    const txList = transactions || [];

    // Calculate totals
    const income = txList.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
    const expenses = txList.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const bills = txList.filter(t => ['Bills', 'Rent', 'Utilities'].includes(t.category)).reduce((s, t) => s + t.amount, 0);

    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const dayOfMonth = new Date().getDate();
    const daysLeft = daysInMonth - dayOfMonth;

    const safeToSpend = income - bills;
    const remaining = safeToSpend - expenses;
    const dailyBudget = daysLeft > 0 ? remaining / daysLeft : 0;

    res.json({
      safe_to_spend: safeToSpend,
      spent_today: 0,
      spent_this_week: expenses,
      income_this_month: income,
      bills_this_month: bills,
      savings_this_month: 0,
      daily_budget: dailyBudget,
    });
  } catch (e) {
    console.error('[Budget] error:', e.message);
    res.status(500).json({ message: 'Could not calculate budget' });
  }
});

// ─── Sandbox test route ───────────────────────────────────────────────────────

app.post('/api/plaid/sandbox-connect', requireAuth, async (req, res) => {
  try {
    console.log('[Sandbox] Creating test token...');
    // Create a sandbox public token for First Platypus Bank
    const sandboxRes = await plaid.sandboxPublicTokenCreate({
      institution_id: 'ins_109508',
      initial_products: ['transactions'],
    });
    const publicToken = sandboxRes.data.public_token;
    console.log('[Sandbox] Got public token, exchanging...');

    // Exchange it
    const exchangeRes = await plaid.itemPublicTokenExchange({ public_token: publicToken });
    const accessToken = exchangeRes.data.access_token;
    const itemId = exchangeRes.data.item_id;

    console.log('[Sandbox] Exchanged, saving to Supabase...');
    // Save to Supabase
    const { error } = await supabase.from('plaid_connections').insert({
      user_id: req.user.id,
      institution_id: 'ins_109508',
      institution_name: 'First Platypus Bank (Test)',
      plaid_item_id: itemId,
      plaid_access_token: accessToken,
    });
    if (error) throw error;

    await syncAccounts(req.user.id, accessToken, itemId);

    console.log('[Sandbox] Done!');
    res.json({ success: true, institution_name: 'First Platypus Bank (Test)' });
  } catch (e) {
    console.error('[Sandbox] error:', e.response?.data || e.message);
    res.status(500).json({ message: e.response?.data?.error_message || e.message });
  }
});

// ─── Stripe routes ────────────────────────────────────────────────────────────

app.post('/api/stripe/subscribe', requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase.from('users').select('stripe_customer_id').eq('id', req.user.id).single();

    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: req.user.email });
      customerId = customer.id;
      await supabase.from('users').update({ stripe_customer_id: customerId }).eq('id', req.user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'usd', product_data: { name: 'Flo Pro' }, recurring: { interval: 'month' }, unit_amount: 499 }, quantity: 1 }],
      mode: 'subscription',
      success_url: 'https://flo-server-production.up.railway.app/payment-success',
      cancel_url: 'https://flo-server-production.up.railway.app/payment-cancel',
    });

    res.json({ checkout_url: session.url });
  } catch (e) {
    console.error('[Stripe] subscribe error:', e.message);
    res.status(500).json({ message: 'Could not start subscription' });
  }
});

app.get('/oauth-return', (req, res) => {
  res.send('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="margin:0;background:#111820;"><script>window.location.href = window.location.href;</script></body></html>');
});

// Hosted Plaid Link page — opens in real Safari
app.get('/plaid/connect', (req, res) => {
  const { token, uid } = req.query;
  res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><style>body{margin:0;background:#111820;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px}p{color:#fff;font-size:16px;text-align:center;padding:0 24px}</style></head><body><p>Loading bank connection...</p><script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script><script>
var handler = Plaid.create({
  token: '${token}',
  onSuccess: function(public_token, metadata) {
    fetch('/plaid/web-success', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({public_token: public_token, uid: '${uid}'})
    }).then(function(r){ return r.json(); }).then(function(){
      document.body.innerHTML = '<p style="color:#4ade80;font-size:20px;font-weight:700">✓ Bank connected!</p><p style="color:#aaa">You can close this window and return to Flo.</p>';
    }).catch(function(){ document.body.innerHTML = '<p style="color:#f87171">Something went wrong. Please try again.</p>'; });
  },
  onExit: function(){ window.close(); }
});
handler.open();
</script></body></html>`);
});

app.post('/plaid/web-success', async (req, res) => {
  const { public_token, uid } = req.body;
  try {
    const exchangeRes = await plaid.itemPublicTokenExchange({ public_token });
    const accessToken = exchangeRes.data.access_token;
    const itemId = exchangeRes.data.item_id;

    const itemRes = await plaid.itemGet({ access_token: accessToken });
    const institutionId = itemRes.data.item.institution_id;
    let institutionName = 'My Bank';
    if (institutionId) {
      const instRes = await plaid.institutionsGetById({ institution_id: institutionId, country_codes: ['US'] });
      institutionName = instRes.data.institution.name;
    }

    const { data: connData, error } = await supabase.from('plaid_connections').insert({
      user_id: uid,
      institution_id: institutionId || 'unknown',
      institution_name: institutionName,
      plaid_item_id: itemId,
      plaid_access_token: accessToken,
    }).select().single();
    if (error) throw error;

    await syncAccounts(uid, accessToken, itemId);
    await syncTransactions(uid, accessToken, connData.id);
    res.json({ success: true });
  } catch (e) {
    console.error('[Plaid web] error:', e.response?.data || e.message);
    res.status(500).json({ message: 'Could not connect bank' });
  }
});

app.get('/payment-success', (req, res) => {
  res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#111820;color:#fff"><h1>🎉 You\'re now on Flo Pro!</h1><p>Close this window and return to the app.</p></body></html>');
});

app.get('/payment-cancel', (req, res) => {
  res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#111820;color:#fff"><h1>Payment cancelled</h1><p>Close this window and return to the app.</p></body></html>');
});

app.post('/api/stripe/cancel', requireAuth, async (req, res) => {
  try {
    await supabase.from('users').update({ subscription_tier: 'free' }).eq('id', req.user.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: 'Could not cancel subscription' });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function syncAccounts(userId, accessToken, itemId) {
  const { data: conn } = await supabase.from('plaid_connections').select('id').eq('plaid_item_id', itemId).single();
  if (!conn) return;

  const res = await plaid.accountsGet({ access_token: accessToken });
  for (const account of res.data.accounts) {
    await supabase.from('accounts').upsert({
      user_id: userId,
      plaid_connection_id: conn.id,
      plaid_account_id: account.account_id,
      name: account.name,
      official_name: account.official_name,
      type: account.type,
      subtype: account.subtype,
      balance_current: account.balances.current || 0,
      balance_available: account.balances.available,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'plaid_account_id' });
  }
}

async function syncTransactions(userId, accessToken, connectionId) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 30);
  const start = startDate.toISOString().slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);

  const res = await plaid.transactionsGet({ access_token: accessToken, start_date: start, end_date: end });

  for (const tx of res.data.transactions) {
    const { data: account } = await supabase.from('accounts').select('id').eq('plaid_account_id', tx.account_id).single();
    if (!account) continue;

    await supabase.from('transactions').upsert({
      user_id: userId,
      account_id: account.id,
      plaid_transaction_id: tx.transaction_id,
      name: tx.name,
      merchant_name: tx.merchant_name,
      amount: tx.amount,
      category: tx.category?.[0] || null,
      subcategory: tx.category?.[1] || null,
      date: tx.date,
      pending: tx.pending,
      logo_url: tx.logo_url || null,
    }, { onConflict: 'plaid_transaction_id' });
  }

  await supabase.from('plaid_connections').update({ last_synced_at: new Date().toISOString() }).eq('id', connectionId);
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Flōw server running on port ${PORT}`));
