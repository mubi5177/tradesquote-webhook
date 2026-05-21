# TradesQuote — Stripe Webhook Handler

Vercel Serverless Function that handles Stripe webhooks and updates Firebase Firestore.  
Replaces Firebase Cloud Functions — **no paid plan needed**. Works entirely on Vercel's free Hobby tier and Firebase's free Spark plan.

---

## Setup

1. **Clone this repo**
   ```bash
   git clone https://github.com/YOUR_USERNAME/tradesquote-webhook.git
   cd tradesquote-webhook
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create `.env` from `.env.example`**
   ```bash
   cp .env.example .env
   # Fill in your real values
   ```

4. **Import to Vercel**
   - Go to [vercel.com](https://vercel.com) → New Project → Import this GitHub repo
   - Framework Preset: Other
   - Build Command: (leave empty)
   - Output Directory: (leave empty)

5. **Add environment variables in Vercel Dashboard**
   - Go to your project → Settings → Environment Variables
   - Add all 5 variables listed below

6. **Add Vercel URL as Stripe webhook endpoint**
   - Go to [Stripe Dashboard → Developers → Webhooks](https://dashboard.stripe.com/webhooks)
   - Click "Add endpoint"
   - URL: `https://tradesquote-webhook.vercel.app/api/stripe-webhook`
   - Select events (see below)

7. **Copy webhook signing secret**
   - After creating the endpoint, click "Reveal" under Signing secret
   - Add this value to Vercel as `STRIPE_WEBHOOK_SECRET`
   - Redeploy the project for changes to take effect

---

## Environment Variables

| Name | Description | Where to find |
|------|-------------|---------------|
| `STRIPE_SECRET_KEY` | Stripe API secret key | Stripe Dashboard → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret | Stripe Dashboard → Webhooks → Your endpoint → Signing secret |
| `FIREBASE_PROJECT_ID` | Firebase project ID | Firebase Console → Project Settings → General |
| `FIREBASE_CLIENT_EMAIL` | Service account email | Firebase Console → Project Settings → Service Accounts |
| `FIREBASE_PRIVATE_KEY` | Service account private key | Generated JSON file → `private_key` field (include quotes, keep `\n`) |

---

## Local Testing

1. Install [Stripe CLI](https://stripe.com/docs/stripe-cli)

2. Start Vercel dev server:
   ```bash
   npx vercel dev
   ```

3. Forward Stripe events to local server:
   ```bash
   stripe listen --forward-to localhost:3000/api/stripe-webhook
   ```

4. Trigger test events:
   ```bash
   stripe trigger customer.subscription.created
   stripe trigger invoice.payment_succeeded
   ```

---

## Events Handled

| Event | Action |
|-------|--------|
| `customer.subscription.created` | Sets subscription active, stores plan details |
| `customer.subscription.updated` | Updates subscription status and plan |
| `customer.subscription.deleted` | Marks subscription as expired |
| `invoice.payment_succeeded` | Confirms active status, records payment |
| `invoice.payment_failed` | Marks subscription as past_due |

---

## Firestore Fields Updated

The webhook updates the following fields on the `users/{uid}` document:

| Field | Type | Description |
|-------|------|-------------|
| `subscriptionStatus` | string | `'active'`, `'expired'`, or `'past_due'` |
| `subscriptionPlan` | string \| null | `'monthly'` or `'annual'` |
| `subscriptionPeriodEnd` | Timestamp \| null | Current billing period end date |
| `stripeCustomerId` | string | Stripe customer ID |
| `stripeSubscriptionId` | string \| null | Stripe subscription ID |
| `stripePriceId` | string \| null | Stripe price ID |
| `lastPaymentDate` | Timestamp | Last successful payment timestamp |
| `lastInvoiceAmount` | number | Last payment amount in pence |
| `lastPaymentFailedAt` | Timestamp | Last failed payment timestamp |
| `updatedAt` | Timestamp | Server timestamp of last update |

---

## Architecture

```
Flutter App (Web)
    │
    ├─── Stripe Payment Link (buy.stripe.com/...)
    │         │
    │         ▼
    │    Stripe processes payment
    │         │
    │         ▼
    │    Stripe sends webhook ──────► Vercel Serverless Function
    │                                      │
    │                                      ▼
    │                                 Firebase Firestore
    │                                      │
    └─── Riverpod stream listens ◄─────────┘
              │
              ▼
         UI updates automatically
```

---

## License

Private — TradesQuote Ltd.
