// Place this file in the tradesquote-webhook GitHub repo
// Path: api/stripe-webhook.js

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// ─── Firebase Admin initialisation guard ─────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();

// ─── Disable Vercel body parsing (required for Stripe signature verification) ─
export const config = {
  api: {
    bodyParser: false,
  },
};

// ─── Helper: read raw body from request stream ───────────────────────────────
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

// ─── Main webhook handler ────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // 1. Reject non-POST requests
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    // 2. Read raw body
    const rawBody = await getRawBody(req);

    // 3. Verify Stripe signature
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('⚠️  Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  const object = event.data.object;

  // 4. Extract Firebase UID from client_reference_id or metadata
  const uid =
    object.client_reference_id ||
    object.metadata?.firebaseUID ||
    null;

  // 5. If no UID, log and return 200 (don't error — some events won't have uid)
  if (!uid) {
    console.warn(
      `⚠️  No UID found for event ${event.type} (${event.id}). Skipping Firestore update.`
    );
    return res.status(200).json({ received: true, warning: 'No UID found' });
  }

  // 6. Get Firestore user document reference
  const userRef = db.collection('users').doc(uid);

  try {
    // 7. Handle event types
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = object;
        const status = subscription.status;
        const interval = subscription.items?.data?.[0]?.price?.recurring?.interval || 'month';
        const currentPeriodEnd = new Date(subscription.current_period_end * 1000);

        const subscriptionStatus =
          status === 'active' || status === 'trialing' ? 'active' : 'expired';

        await userRef.update({
          subscriptionStatus,
          subscriptionPlan: interval === 'year' ? 'annual' : 'monthly',
          subscriptionPeriodEnd: admin.firestore.Timestamp.fromDate(currentPeriodEnd),
          stripeCustomerId: subscription.customer,
          stripeSubscriptionId: subscription.id,
          stripePriceId: subscription.items?.data?.[0]?.price?.id || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(
          `✅ Subscription ${event.type} — UID: ${uid}, Status: ${subscriptionStatus}, Plan: ${interval}`
        );
        break;
      }

      case 'customer.subscription.deleted': {
        await userRef.update({
          subscriptionStatus: 'expired',
          subscriptionPlan: null,
          subscriptionPeriodEnd: null,
          stripeSubscriptionId: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`✅ Subscription deleted — UID: ${uid}`);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = object;

        await userRef.update({
          subscriptionStatus: 'active',
          lastPaymentDate: admin.firestore.FieldValue.serverTimestamp(),
          lastInvoiceAmount: invoice.amount_paid || 0,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(
          `✅ Payment succeeded — UID: ${uid}, Amount: ${invoice.amount_paid}`
        );
        break;
      }

      case 'invoice.payment_failed': {
        await userRef.update({
          subscriptionStatus: 'past_due',
          lastPaymentFailedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`⚠️  Payment failed — UID: ${uid}`);
        break;
      }

      default:
        console.log(`ℹ️  Unhandled event type: ${event.type}`);
    }

    // 8. Return success
    return res.status(200).json({ received: true });
  } catch (err) {
    // 9. Catch Firestore errors — return 500 so Stripe retries
    console.error(`❌ Firestore error for event ${event.type}:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
