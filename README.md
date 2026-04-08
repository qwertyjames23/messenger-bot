# RJ Music Messenger Bot

A production AI chatbot for [rjmusic.shop](https://rjmusic.shop) built on the Facebook Messenger platform. Handles the full customer order flow — from product inquiry to order confirmation — with zero manual intervention.

## Features

- **AI-powered conversations** — GPT-4o-mini handles natural language in English, Filipino, and Bisaya
- **Full order flow** — product selection → variant picking → delivery details → payment → confirmation
- **Product variants** — fetches live variant options (size, type, price) from Supabase per product
- **Saved customer profiles** — repeat customers can reuse their saved delivery details
- **Real-time order status** — customers can check order status by order number; bot queries Supabase live
- **Status notifications** — automatically messages customers when their order status changes (Processing → Shipped → Delivered)
- **Comment-to-DM** — detects product keywords in Facebook post comments and sends an automated DM to start the order flow
- **Deduplication** — prevents duplicate order processing via Facebook message ID tracking
- **Typing indicators** — shows typing_on while processing, dismisses before sending reply

## Tech Stack

- **Runtime:** Node.js + Express
- **AI:** OpenAI GPT-4o-mini (function calling for order creation and status checks)
- **Database:** Supabase (PostgreSQL) — orders, products, variants, sessions, customer profiles
- **Messaging:** Facebook Messenger API (Graph API v19.0)
- **Deployment:** Render

## Environment Variables

```
OPENAI_API_KEY=
SUPABASE_URL=
SUPABASE_KEY=
PAGE_ACCESS_TOKEN=
VERIFY_TOKEN=
GCASH_NUMBER=
GCASH_NAME=
PORT=
```

## Order Flow

```
Customer message
      ↓
GPT-4o-mini (system prompt with live products + customer profile)
      ↓
  [tool_call?]
  ├── create_order  → writes to Supabase via SECURITY DEFINER RPC → confirms to customer
  └── check_order_status → queries orders table → returns status summary
      ↓
Reply sent via Messenger API
```

## Running Locally

```bash
npm install
cp .env.example .env   # fill in your credentials
npm start
```

## Deployment

Deployed on [Render](https://render.com). Set all environment variables in the Render dashboard — no `.env` file needed in production.
