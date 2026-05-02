require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Default identity (rjmusic fallback when CLIENT_CONFIG_ID is not set)
const DEFAULT_BUSINESS = {
  name: "RJ MUSIC",
  website: "rjmusic.shop",
  location: "Baliwagan, Balingasag, Misamis Oriental, Philippines",
};

let clientBusiness = null;

async function loadClientConfig() {
  const configId = process.env.CLIENT_CONFIG_ID;
  if (!configId) return;
  const { data, error } = await supabase
    .from("botforge_configs")
    .select("config_json")
    .eq("id", configId)
    .single();
  if (error) {
    console.error("Failed to load client config:", error.message);
    return;
  }
  clientBusiness = data.config_json.business;
  console.log(`Loaded client config for: ${clientBusiness.name}`);
}

// Fetch products from Supabase
async function getProducts() {
  const { data, error } = await supabase
    .from("products")
    .select("id, name, price, original_price, category, brand, in_stock, stock, has_variants")
    .order("name");

  if (error) {
    console.error("Supabase error:", error.message);
    return [];
  }
  return data;
}

// Fetch active product variants from Supabase
async function getVariants() {
  const { data, error } = await supabase
    .from("product_variants")
    .select("id, product_id, label, price, stock, variant_type, is_active")
    .eq("is_active", true)
    .order("sort_order");

  if (error) {
    console.error("Supabase variants error:", error.message);
    return [];
  }
  return data;
}

// Fetch knowledge entries from Supabase
async function getKnowledge() {
  const { data, error } = await supabase
    .from("knowledge")
    .select("topic, content")
    .eq("is_active", true)
    .order("topic");

  if (error) {
    console.error("Supabase knowledge error:", error.message);
    return [];
  }
  return data;
}

// Get conversation history for a sender
async function getSession(fbSenderId) {
  const { data } = await supabase
    .from("messenger_sessions")
    .select("history")
    .eq("fb_sender_id", fbSenderId)
    .single();

  return data?.history || [];
}

// Save conversation history for a sender
async function saveSession(fbSenderId, history) {
  await supabase
    .from("messenger_sessions")
    .upsert({ fb_sender_id: fbSenderId, history, updated_at: new Date().toISOString() });
}

// Build system prompt with live product data and knowledge
async function buildSystemPrompt() {
  const [products, knowledge, variants] = await Promise.all([getProducts(), getKnowledge(), getVariants()]);

  // Group variants by product_id
  const variantsByProduct = {};
  for (const v of variants) {
    if (!variantsByProduct[v.product_id]) variantsByProduct[v.product_id] = [];
    variantsByProduct[v.product_id].push(v);
  }

  let productList = "No products available.";
  if (products.length > 0) {
    productList = products
      .map((p) => {
        const brand = p.brand ? ` | Brand: ${p.brand}` : "";
        const productVariants = variantsByProduct[p.id] || [];

        if (p.has_variants && productVariants.length > 0) {
          const variantLines = productVariants.map((v) => {
            const vStock = v.stock > 0 ? `In stock (${v.stock} pcs)` : "Out of stock";
            return `  - [VAR-ID:${v.id}] ${v.variant_type ? v.variant_type + ": " : ""}${v.label} | ₱${Number(v.price).toLocaleString()} | ${vStock}`;
          }).join("\n");
          return `- [ID:${p.id}] ${p.name}${brand} | Category: ${p.category} | HAS VARIATIONS:\n${variantLines}`;
        } else {
          const price = `₱${Number(p.price).toLocaleString()}`;
          const origPrice = p.original_price ? ` (orig: ₱${Number(p.original_price).toLocaleString()})` : "";
          const stock = p.in_stock ? `In stock (${p.stock} pcs)` : "Out of stock";
          return `- [ID:${p.id}] ${p.name}${brand} | ${price}${origPrice} | ${stock} | Category: ${p.category}`;
        }
      })
      .join("\n");
  }

  let knowledgeSection = "";
  if (knowledge.length > 0) {
    knowledgeSection = "\n\nSTORE KNOWLEDGE:\n" + knowledge.map((k) => `- ${k.content}`).join("\n");
  }

  const gcashNumber = process.env.GCASH_NUMBER || "[GCash number not set]";
  const gcashName = process.env.GCASH_NAME || "RJ Music";

  const biz = clientBusiness || DEFAULT_BUSINESS;

  return `You are a helpful customer support and sales assistant for ${biz.name} (${biz.website}), a store based in ${biz.location}.

Be friendly, concise, and helpful. Answer in the same language the customer uses (simple Bisaya, Filipino, or English).

CURRENT PRODUCTS & STOCK:
${productList}${knowledgeSection}

STORE INFO:
- Website: https://${biz.website} (for browsing only)
- Payment methods: Cash on Delivery (COD) or GCash
- GCash: ${gcashNumber} (${gcashName})

ORDER PROCESS - You MUST take orders directly here in chat. NEVER redirect customers to the website to order. Ask ONE piece of information at a time — wait for the customer's answer before asking the next question:
1. Confirm which product(s) the customer wants. If the product HAS VARIATIONS, show the available variants with prices and ask which variation they want — wait for answer. Then ask quantity.
2. Ask for their full name only — wait for answer
3. Ask for their complete delivery address only (house/lot no., street, barangay, city, province, zip code) — wait for answer
4. Ask for their contact number only — wait for answer
5. Ask for payment method only: COD or GCash — wait for answer
6. Show a complete order summary (items, prices, shipping fee, total) then ask the customer to type "Confirm" to place the order or "Cancel" to cancel
7. ONLY call create_order if the customer types "Confirm" (or similar confirmation like "yes", "confirm", "sige", "ok")

GUIDELINES:
- IMPORTANT: Always take orders here in Messenger chat — do NOT tell customers to go to the website to order
- At the very start of a new conversation (first message only), briefly introduce yourself as ${biz.name}'s automated assistant/chatbot so the customer knows they are talking to a bot, not a human
- Do NOT call create_order until the customer explicitly confirms the order summary
- Do not allow ordering out-of-stock items
- For GCash orders: after confirming, instruct customer to send payment to GCash ${gcashNumber} (${gcashName}) and send a screenshot as proof
- For order status inquiries, ask for their order number then immediately call check_order_status to get real-time status
- Keep replies short and clear`;
}

// Get saved customer profile
async function getCustomerProfile(fbSenderId) {
  const { data } = await supabase
    .from("customer_profiles")
    .select("*")
    .eq("fb_sender_id", fbSenderId)
    .single();
  return data || null;
}

// Save/update customer profile after order
async function saveCustomerProfile(fbSenderId, orderData) {
  await supabase
    .from("customer_profiles")
    .upsert({
      fb_sender_id: fbSenderId,
      name: orderData.customer_name,
      phone: orderData.contact_number,
      street_address: orderData.street_address,
      barangay: orderData.barangay,
      city: orderData.city,
      province: orderData.province,
      postal_code: orderData.postal_code,
      updated_at: new Date().toISOString(),
    });
}

// Check order status from Supabase
async function checkOrderStatus(orderNumber) {
  const { data, error } = await supabase
    .from("orders")
    .select("order_number, shipping_name, status, payment_status, payment_method, total, shipping_fee, created_at, order_items(product_name, quantity, subtotal)")
    .ilike("order_number", orderNumber.trim())
    .single();

  if (error || !data) return null;
  return data;
}

// OpenAI function definition for placing orders
const tools = [
  {
    type: "function",
    function: {
      name: "check_order_status",
      description: "Check the status of a customer's order using their order number",
      parameters: {
        type: "object",
        properties: {
          order_number: { type: "string", description: "The order number provided by the customer" },
        },
        required: ["order_number"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_order",
      description: "Create an order in the system after the customer has confirmed all details",
      parameters: {
        type: "object",
        properties: {
          customer_name: { type: "string", description: "Full name of the customer" },
          contact_number: { type: "string", description: "Customer contact number" },
          street_address: { type: "string", description: "House/lot no. and street" },
          barangay: { type: "string", description: "Barangay" },
          city: { type: "string", description: "City or municipality" },
          province: { type: "string", description: "Province" },
          postal_code: { type: "string", description: "Zip/postal code" },
          payment_method: { type: "string", enum: ["cod", "gcash"] },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                product_id: { type: "string" },
                product_name: { type: "string" },
                price: { type: "number" },
                quantity: { type: "integer" },
                variant_id: { type: "string", description: "Variant ID if product has variations (VAR-ID)" },
                variant_label: { type: "string", description: "Variant label e.g. 'Light 10-47'" },
              },
              required: ["product_id", "product_name", "price", "quantity"],
            },
          },
        },
        required: [
          "customer_name",
          "contact_number",
          "street_address",
          "barangay",
          "city",
          "province",
          "postal_code",
          "payment_method",
          "items",
        ],
      },
    },
  },
];

// Create order in Supabase via SECURITY DEFINER RPC (bypasses RLS)
async function createOrder(orderData, fbSenderId) {
  const { randomUUID } = require("crypto");
  const orderId = randomUUID();
  const orderNumber = `MSG-${Date.now().toString().slice(-8)}`;
  const isLocal = orderData.city.toLowerCase().includes("balingasag");
  const shippingFee = isLocal ? 0 : 105;
  // Include variant label in product name if applicable
  orderData.items = orderData.items.map((item) =>
    item.variant_label
      ? { ...item, product_name: `${item.product_name} (${item.variant_label})` }
      : item
  );
  const subtotal = orderData.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const total = subtotal + shippingFee;

  const addressLine1 = [orderData.street_address, orderData.barangay].filter(Boolean).join(", ");

  const { error } = await supabase.rpc("create_messenger_order", {
    p_id: orderId,
    p_order_number: orderNumber,
    p_customer_name: orderData.customer_name,
    p_customer_phone: orderData.contact_number,
    p_shipping_address_line1: addressLine1,
    p_shipping_city: orderData.city,
    p_shipping_state: orderData.province,
    p_shipping_postal_code: orderData.postal_code,
    p_subtotal: subtotal,
    p_shipping_fee: shippingFee,
    p_total: total,
    p_payment_method: orderData.payment_method,
    p_items: orderData.items,
    p_fb_sender_id: fbSenderId,
  });

  if (error) throw new Error(error.message);

  return { orderNumber, total, shippingFee };
}

// Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Deduplication: track recently processed message IDs
const processedMids = new Map(); // mid -> timestamp
const MID_TTL_MS = 60000; // 60 seconds

function isDuplicate(mid) {
  const now = Date.now();
  // Clean up old entries
  for (const [key, ts] of processedMids) {
    if (now - ts > MID_TTL_MS) processedMids.delete(key);
  }
  if (processedMids.has(mid)) return true;
  processedMids.set(mid, now);
  return false;
}

// Comment keyword → product name mapping
const COMMENT_KEYWORDS = {
  "capo":           "Classic Guitar Capo",
  "elixir":         "Elixir Guitar Strings",
  "elixir acoustic":"Elixir Acoustic Guitar Strings",
  "elixir electric":"Elixir Nanoweb Nickel Plated Steel Electric Guitar Strings",
  "picks":          "Guitar Picks",
  "pick":           "Guitar Picks",
  "hanger":         "Guitar Hanger Hook Holder Wall",
  "irig":           "Irig",
  "tuner":          "Joyo Guitar Tuner JT-01",
  "joyo":           "Joyo Guitar Tuner JT-01",
};

async function replyToComment(commentId, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${commentId}/comments`,
      { message },
      { params: { access_token: process.env.PAGE_ACCESS_TOKEN } }
    );
  } catch (err) {
    console.error("Error replying to comment:", err.message);
  }
}

async function handleComment(change) {
  const value = change.value;
  if (value?.item !== "comment" || value?.verb !== "add") return;

  const commentText = (value.message || "").trim().toLowerCase();
  const commentId = value.comment_id;
  const senderId = value.from?.id;
  const senderName = value.from?.name || "there";

  if (!senderId || !commentId) return;

  // Check if comment matches any keyword
  const matchedProduct = Object.entries(COMMENT_KEYWORDS).find(([keyword]) =>
    commentText === keyword || commentText.includes(keyword)
  );

  if (!matchedProduct) return;

  const [, productName] = matchedProduct;
  console.log(`Comment keyword match: "${commentText}" → ${productName} from ${senderName} (${senderId})`);

  // Reply to comment
  await replyToComment(commentId, `Hi ${senderName}! Sending you a private message now 📩`);

  // Send DM to start order flow
  await sendTypingOn(senderId);
  await sendMessage(
    senderId,
    `Hi ${senderName}! 👋 Nakita namo ang imong comment. Gusto nimo mag-order og ${productName}?\n\nI-type lang ang quantity ug delivery details para ma-process namo ang imong order! 😊`
  );
}

// Receive messages
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object !== "page") return res.sendStatus(404);

  res.sendStatus(200); // Respond fast to Facebook

  for (const entry of body.entry) {
    // Handle comment events (feed changes)
    if (entry.changes) {
      for (const change of entry.changes) {
        if (change.field === "feed") {
          await handleComment(change);
        }
      }
      continue;
    }

    const event = entry.messaging?.[0];
    if (!event?.message?.text) continue;

    const mid = event.message.mid;
    if (mid && isDuplicate(mid)) {
      console.log(`Duplicate message ignored: ${mid}`);
      continue;
    }

    const senderId = event.sender.id;
    const userMessage = event.message.text;

    console.log(`Message from ${senderId}: ${userMessage}`);

    try {
      // Show typing indicator while processing
      await sendTypingOn(senderId);

      const [systemPrompt, history, customerProfile] = await Promise.all([
        buildSystemPrompt(),
        getSession(senderId),
        getCustomerProfile(senderId),
      ]);

      // Append saved profile to system prompt if exists
      let fullSystemPrompt = systemPrompt;
      if (customerProfile) {
        fullSystemPrompt += `\n\nSAVED CUSTOMER PROFILE (from previous order):
- Name: ${customerProfile.name}
- Phone: ${customerProfile.phone}
- Address: ${customerProfile.street_address}, ${customerProfile.barangay}, ${customerProfile.city}, ${customerProfile.province} ${customerProfile.postal_code}

IMPORTANT RULE FOR SAVED PROFILE:
After confirming the product and quantity, show the customer their saved details and ask ONCE: "Gamiton ba nato ang inyong nauna nga delivery details? (Yes/No)"

If the customer says YES (or "yes", "oo", "sige", "ok", "same", "yes na"):
- DO NOT ask for name, address, or phone number again
- Use the saved details above directly
- Proceed immediately to asking ONLY for the payment method (COD or GCash)

If the customer says NO:
- Ask for new name, address, and phone one at a time

NOTE: Always ask for product and quantity first as normal — only name, address, and phone are skipped when the customer confirms saved details.`;
      }

      const messages = [
        { role: "system", content: fullSystemPrompt },
        ...history.slice(-20),
        { role: "user", content: userMessage },
      ];

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        tools,
        tool_choice: "auto",
        max_tokens: 600,
      });

      const choice = response.choices[0];
      let replyText = "";

      if (choice.finish_reason === "tool_calls") {
        const toolCall = choice.message.tool_calls[0];

        if (toolCall.function.name === "check_order_status") {
          const { order_number } = JSON.parse(toolCall.function.arguments);
          const order = await checkOrderStatus(order_number);

          if (!order) {
            replyText = `Sorry, dili nako makit-an ang order number "${order_number}". Please double-check ang order number ug try again.`;
          } else {
            const statusEmoji = {
              Pending: "🕐", Processing: "⚙️", Shipped: "🚚", Delivered: "✅", Cancelled: "❌",
            }[order.status] || "📦";

            const itemsList = order.order_items
              .map((i) => `  • ${i.product_name} x${i.quantity} — ₱${Number(i.subtotal).toLocaleString()}`)
              .join("\n");

            replyText =
              `${statusEmoji} Order #${order.order_number}\n` +
              `Status: ${order.status}\n` +
              `Payment: ${order.payment_status.toUpperCase()} (${order.payment_method.toUpperCase()})\n\n` +
              `Items:\n${itemsList}\n\n` +
              `Shipping: ₱${Number(order.shipping_fee).toLocaleString()}\n` +
              `Total: ₱${Number(order.total).toLocaleString()}\n\n` +
              `Order Date: ${new Date(order.created_at).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}`;
          }

          const updatedHistory = [
            ...history.slice(-18),
            { role: "user", content: userMessage },
            { role: "assistant", content: replyText },
          ];
          await saveSession(senderId, updatedHistory);

        } else if (toolCall.function.name === "create_order") {
          const orderData = JSON.parse(toolCall.function.arguments);

          try {
            const { orderNumber, total, shippingFee } = await createOrder(orderData, senderId);

            if (orderData.payment_method === "gcash") {
              const gcashNumber = process.env.GCASH_NUMBER || "[GCash number]";
              const gcashName = process.env.GCASH_NAME || "RJ Music";
              replyText =
                `Order confirmed! Order #${orderNumber}\n\n` +
                `Total: ₱${total.toLocaleString()} (incl. ₱${shippingFee} shipping)\n\n` +
                `Para sa GCash payment, send ₱${total.toLocaleString()} to:\n` +
                `${gcashNumber} - ${gcashName}\n\n` +
                `Please send a screenshot to our page to confirm the payment. Thank you!`;
            } else {
              replyText =
                `Order confirmed! Order #${orderNumber}\n\n` +
                `Total: ₱${total.toLocaleString()} (incl. ₱${shippingFee} shipping)\n` +
                `Payment: Cash on Delivery (COD)\n\n` +
                `Please wait for our call or message regarding your delivery. Thank you!`;
            }

            // Save customer profile for future orders
            await saveCustomerProfile(senderId, orderData);

            // Clear history after order is placed
            await saveSession(senderId, []);
          } catch (err) {
            console.error("Order creation error:", err.message);
            replyText = "Sorry, may problema sa pag-save sa imong order. Please try again o contact us sa website.";
          }
        }
      } else {
        replyText = choice.message.content;

        // Save updated conversation history
        const updatedHistory = [
          ...history.slice(-18),
          { role: "user", content: userMessage },
          { role: "assistant", content: replyText },
        ];
        await saveSession(senderId, updatedHistory);
      }

      if (replyText) await sendMessage(senderId, replyText);
    } catch (err) {
      console.error("Error:", err.message);
    }
  }
});

async function sendTypingOn(recipientId) {
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages`,
    {
      recipient: { id: recipientId },
      sender_action: "typing_on",
    },
    {
      params: { access_token: process.env.PAGE_ACCESS_TOKEN },
    }
  );
}

async function sendTypingOff(recipientId) {
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages`,
    {
      recipient: { id: recipientId },
      sender_action: "typing_off",
    },
    {
      params: { access_token: process.env.PAGE_ACCESS_TOKEN },
    }
  );
}

async function sendMessage(recipientId, text) {
  await sendTypingOff(recipientId);
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages`,
    {
      recipient: { id: recipientId },
      message: { text },
    },
    {
      params: { access_token: process.env.PAGE_ACCESS_TOKEN },
    }
  );
}

// Listen for order status changes and notify customers via Messenger
const STATUS_MESSAGES = {
  Processing: (name, num) => `Hi ${name}! Your order #${num} is now being processed. We will notify you once it has been shipped. Thank you for ordering from RJ Music Shop!`,
  Shipped:    (name, num) => `Hi ${name}! Your order #${num} has been shipped and is now on the way. Please wait for updates from the courier.`,
  Delivered:  (name, num) => `Hi ${name}! Your order #${num} has been delivered. Thank you for purchasing from RJ Music Shop!`,
  Cancelled:  (name, num) => `Hi ${name}. Your order #${num} has been cancelled. Please message us if you need assistance.`,
};

let orderStatusChannel = null;
let reconnectDelay = 5000;
const MAX_RECONNECT_DELAY = 60000;

function subscribeOrderStatus() {
  if (orderStatusChannel) {
    supabase.removeChannel(orderStatusChannel);
    orderStatusChannel = null;
  }

  orderStatusChannel = supabase
    .channel("order-status-changes")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "orders" },
      async (payload) => {
        const newOrder = payload.new;
        const oldOrder = payload.old;

        if (newOrder.status === oldOrder.status) return;
        if (!newOrder.fb_sender_id) return;

        const msgFn = STATUS_MESSAGES[newOrder.status];
        if (!msgFn) return;

        const message = msgFn(newOrder.shipping_name || "Customer", newOrder.order_number);
        try {
          await sendMessage(newOrder.fb_sender_id, message);
          console.log(`Notified ${newOrder.fb_sender_id} → status: ${newOrder.status}`);
        } catch (err) {
          console.error("Failed to send order notification:", err.message);
        }
      }
    )
    .subscribe((status) => {
      console.log("Order status listener:", status);
      if (status === "SUBSCRIBED") {
        reconnectDelay = 5000; // reset on success
      } else if (status === "CLOSED" || status === "TIMED_OUT") {
        console.log(`Reconnecting order status listener in ${reconnectDelay / 1000}s...`);
        setTimeout(subscribeOrderStatus, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY); // exponential backoff
      }
    });
}

subscribeOrderStatus();

const PORT = process.env.PORT || 3000;
loadClientConfig().then(() => {
  app.listen(PORT, () => {
    console.log(`Bot running on port ${PORT}`);
  });
});
