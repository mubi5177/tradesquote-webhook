const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

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

export const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data.object;
  const uid =
    obj.client_reference_id ||
    obj.metadata?.firebaseUID ||
    null;

  if (!uid) {
    console.warn(`No UID in event ${event.type} (${event.id})`);
    return res.status(200).json({ received: true, warning: 'No UID found' });
  }

  const userRef = db.collection('users').doc(uid);

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        if (obj.mode === 'subscription' && obj.subscription) {
          const sub = await stripe.subscriptions.retrieve(obj.subscription);
          const interval = sub.items?.data?.[0]?.price?.recurring?.interval;
          const periodEnd = new Date(sub.current_period_end * 1000);
          await userRef.update({
            subscriptionStatus: 'active',
            subscriptionPlan: interval === 'year' ? 'annual' : 'monthly',
            subscriptionPeriodEnd: admin.firestore.Timestamp.fromDate(periodEnd),
            stripeCustomerId: obj.customer,
            stripeSubscriptionId: obj.subscription,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`✓ checkout.session.completed — activated for UID: ${uid}`);
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const isActive = obj.status === 'active' || obj.status === 'trialing';
        const interval = obj.items?.data?.[0]?.price?.recurring?.interval;
        const periodEnd = new Date(obj.current_period_end * 1000);
        await userRef.update({
          subscriptionStatus: isActive ? 'active' : 'expired',
          subscriptionPlan: interval === 'year' ? 'annual' : 'monthly',
          subscriptionPeriodEnd: admin.firestore.Timestamp.fromDate(periodEnd),
          stripeCustomerId: obj.customer,
          stripeSubscriptionId: obj.id,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`✓ ${event.type} — UID: ${uid}, Status: ${isActive ? 'active' : 'expired'}`);
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
        console.log(`✓ Subscription deleted — UID: ${uid}`);
        break;
      }

      case 'invoice.payment_succeeded': {
        await userRef.update({
          subscriptionStatus: 'active',
          lastPaymentDate: admin.firestore.FieldValue.serverTimestamp(),
          lastInvoiceAmount: obj.amount_paid || 0,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`✓ Payment succeeded — UID: ${uid}, Amount: ${obj.amount_paid}`);
        break;
      }

      case 'invoice.payment_failed': {
        await userRef.update({
          subscriptionStatus: 'past_due',
          lastPaymentFailedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`⚠ Payment failed — UID: ${uid}`);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error(`Firestore error for event ${event.type}:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
