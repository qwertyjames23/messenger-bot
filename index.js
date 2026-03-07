require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Fetch products from Supabase
async function getProducts() {
  const { data, error } = await supabase
    .from("products")
    .select("id, name, price, original_price, category, brand, in_stock, stock")
    .order("name");

  if (error) {
    console.error("Supabase error:", error.message);
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
  const [products, knowledge] = await Promise.all([getProducts(), getKnowledge()]);

  let productList = "No products available.";
  if (products.length > 0) {
    productList = products
      .map((p) => {
        const price = `₱${Number(p.price).toLocaleString()}`;
        const origPrice = p.original_price ? ` (orig: ₱${Number(p.original_price).toLocaleString()})` : "";
        const stock = p.in_stock ? `In stock (${p.stock} pcs)` : "Out of stock";
        const brand = p.brand ? ` | Brand: ${p.brand}` : "";
        return `- [ID:${p.id}] ${p.name}${brand} | ${price}${origPrice} | ${stock} | Category: ${p.category}`;
      })
      .join("\n");
  }

  let knowledgeSection = "";
  if (knowledge.length > 0) {
    knowledgeSection = "\n\nSTORE KNOWLEDGE:\n" + knowledge.map((k) => `- ${k.content}`).join("\n");
  }

  const gcashNumber = process.env.GCASH_NUMBER || "[GCash number not set]";
  const gcashName = process.env.GCASH_NAME || "RJ Music";

  return `You are a helpful customer support and sales assistant for RJ MUSIC (rjmusic.shop), a Philippine online store selling musical accessories and studio gear.

Be friendly, concise, and helpful. Answer in the same language the customer uses (simple Bisaya, Filipino, or English).

CURRENT PRODUCTS & STOCK:
${productList}${knowledgeSection}

STORE INFO:
- Website: https://rjmusic.shop
- Payment methods: Cash on Delivery (COD) or GCash
- GCash: ${gcashNumber} (${gcashName})
- Shipping fee: ₱50 for Balingasag local, ₱150 for nationwide

ORDER PROCESS - follow these steps in order:
1. Confirm which product(s) and quantity the customer wants (check if in stock first)
2. Ask for their full name
3. Ask for their complete delivery address: house/lot no. and street, barangay, city/municipality, province, zip code
4. Ask for their contact number
5. Ask for payment method: COD or GCash
6. Show a complete order summary (items, prices, shipping fee, total) and ask for confirmation
7. After customer confirms, call the create_order function immediately

GUIDELINES:
- Do NOT call create_order until the customer explicitly says "confirm" or "yes, place the order" or similar
- Do not allow ordering out-of-stock items
- For GCash orders: after confirming, instruct customer to send payment to GCash ${gcashNumber} (${gcashName}) and send a screenshot as proof
- For order status inquiries, ask for their order number
- Keep replies short and clear`;
}

// OpenAI function definition for placing orders
const tools = [
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

// Create order in Supabase
async function createOrder(orderData) {
  const orderNumber = `MSG-${Date.now().toString().slice(-8)}`;
  const isLocal = orderData.city.toLowerCase().includes("balingasag");
  const shippingFee = isLocal ? 50 : 150;
  const subtotal = orderData.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const total = subtotal + shippingFee;

  const addressLine1 = [orderData.street_address, orderData.barangay].filter(Boolean).join(", ");

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .insert({
      order_number: orderNumber,
      customer_name: orderData.customer_name,
      customer_phone: orderData.contact_number,
      shipping_name: orderData.customer_name,
      shipping_phone: orderData.contact_number,
      shipping_address_line1: addressLine1,
      shipping_city: orderData.city,
      shipping_state: orderData.province,
      shipping_postal_code: orderData.postal_code,
      shipping_country: "Philippines",
      subtotal,
      shipping_fee: shippingFee,
      total,
      status: "Pending",
      payment_method: orderData.payment_method,
      payment_status: "pending",
      notes: "Order via Facebook Messenger",
    })
    .select("id")
    .single();

  if (orderError) throw new Error(orderError.message);

  const orderItems = orderData.items.map((item) => ({
    order_id: order.id,
    product_id: item.product_id,
    product_name: item.product_name,
    product_price: item.price,
    quantity: item.quantity,
    subtotal: item.price * item.quantity,
  }));

  const { error: itemsError } = await supabase.from("order_items").insert(orderItems);
  if (itemsError) throw new Error(itemsError.message);

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

// Receive messages
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object !== "page") return res.sendStatus(404);

  res.sendStatus(200); // Respond fast to Facebook

  for (const entry of body.entry) {
    const event = entry.messaging[0];
    if (!event?.message?.text) continue;

    const senderId = event.sender.id;
    const userMessage = event.message.text;

    console.log(`Message from ${senderId}: ${userMessage}`);

    try {
      const [systemPrompt, history] = await Promise.all([buildSystemPrompt(), getSession(senderId)]);

      const messages = [
        { role: "system", content: systemPrompt },
        ...history.slice(-20), // keep last 20 messages for context
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

        if (toolCall.function.name === "create_order") {
          const orderData = JSON.parse(toolCall.function.arguments);

          try {
            const { orderNumber, total, shippingFee } = await createOrder(orderData);

            if (orderData.payment_method === "gcash") {
              const gcashNumber = process.env.GCASH_NUMBER || "[GCash number]";
              const gcashName = process.env.GCASH_NAME || "RJ Music";
              replyText =
                `Order confirmed! Order #${orderNumber}\n\n` +
                `Total: ₱${total.toLocaleString()} (incl. ₱${shippingFee} shipping)\n\n` +
                `Para sa GCash payment, send ₱${total.toLocaleString()} to:\n` +
                `${gcashNumber} - ${gcashName}\n\n` +
                `Send screenshot sa aming page para ma-confirm ang payment. Salamat!`;
            } else {
              replyText =
                `Order confirmed! Order #${orderNumber}\n\n` +
                `Total: ₱${total.toLocaleString()} (incl. ₱${shippingFee} shipping)\n` +
                `Payment: Cash on Delivery (COD)\n\n` +
                `Antayon lang ang tawag/mensahe para sa delivery. Salamat!`;
            }

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

async function sendMessage(recipientId, text) {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
