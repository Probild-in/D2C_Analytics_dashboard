import type {
  AppNotification,
  Campaign,
  CampaignActivity,
  Client,
  CrmTask,
  Creative,
  GeoRow,
  Order,
  OrderStatus,
  Product,
  SalesPoint,
  TeamMember,
} from "./types";

// Deterministic pseudo-random generator so the UI is stable across renders/reloads.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h >>> 0;
}

export const CLIENTS: Client[] = [
  {
    id: "abc-fashion",
    name: "ABC Fashion",
    category: "Fashion & Apparel",
    logoColor: "bg-violet-500",
    logoInitial: "A",
    integrations: ["shopify", "meta", "google", "shipping"],
    status: "attention",
    owner: "Riya Kapoor",
  },
  {
    id: "xyz-cosmetics",
    name: "XYZ Cosmetics",
    category: "Beauty & Cosmetics",
    logoColor: "bg-rose-500",
    logoInitial: "X",
    integrations: ["shopify", "meta", "google", "shipping"],
    status: "healthy",
    owner: "Aditya Rao",
  },
  {
    id: "brand-c-electronics",
    name: "Brand C Electronics",
    category: "Electronics",
    logoColor: "bg-cyan-500",
    logoInitial: "C",
    integrations: ["shopify", "meta", "google"],
    status: "critical",
    owner: "Meera Nair",
  },
  {
    id: "brand-d-foods",
    name: "Brand D Foods",
    category: "Food & Beverage",
    logoColor: "bg-amber-500",
    logoInitial: "D",
    integrations: ["shopify", "meta", "shipping"],
    status: "healthy",
    owner: "Karan Singh",
  },
];

export const DEFAULT_CLIENT_ID = CLIENTS[0].id;

const CLIENT_BASE: Record<string, { orders: number; aov: number; rto: number; roas: number; spendRatio: number }> = {
  "abc-fashion": { orders: 190, aov: 2540, rto: 21, roas: 3.2, spendRatio: 0.23 },
  "xyz-cosmetics": { orders: 128, aov: 2500, rto: 18, roas: 3.8, spendRatio: 0.21 },
  "brand-c-electronics": { orders: 74, aov: 2570, rto: 31, roas: 2.9, spendRatio: 0.29 },
  "brand-d-foods": { orders: 210, aov: 950, rto: 9, roas: 4.6, spendRatio: 0.16 },
};

function generateSalesSeries(clientId: string, days: number): SalesPoint[] {
  const rand = mulberry32(seedFromString(clientId));
  const base = CLIENT_BASE[clientId] ?? CLIENT_BASE["abc-fashion"];
  const points: SalesPoint[] = [];
  const today = new Date("2026-08-21T00:00:00Z");

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dow = d.getUTCDay();
    const weekendBoost = dow === 0 || dow === 6 ? 1.18 : 1;
    const wave = 1 + 0.14 * Math.sin(i / 5) + 0.06 * Math.sin(i / 17);
    const noise = 0.85 + rand() * 0.3;
    const trendGrowth = 1 + ((days - i) / days) * 0.08;

    const orders = Math.max(6, Math.round(base.orders * weekendBoost * wave * noise * trendGrowth * (days > 60 ? 0.98 : 1)));
    const aov = base.aov * (0.92 + rand() * 0.16);
    const grossSales = Math.round(orders * aov);
    const cancelledOrders = Math.round(orders * (0.03 + rand() * 0.03));
    const rtoRate = (base.rto + (rand() - 0.5) * 8) / 100;
    const rtoOrders = Math.round(orders * Math.max(0.03, rtoRate));
    const netSales = Math.round(grossSales - cancelledOrders * aov - rtoOrders * aov * 0.65);
    const adSpend = Math.round(grossSales * base.spendRatio * (0.85 + rand() * 0.3));
    const codShare = clientId === "brand-c-electronics" ? 0.62 : clientId === "brand-d-foods" ? 0.71 : 0.55;
    const codOrders = Math.round(orders * (codShare + (rand() - 0.5) * 0.08));

    points.push({
      date: d.toISOString().slice(0, 10),
      grossSales,
      netSales,
      orders,
      adSpend,
      newCustomers: Math.round(orders * (0.58 + rand() * 0.1)),
      returningCustomers: Math.round(orders * (0.32 + rand() * 0.1)),
      codOrders,
      prepaidOrders: orders - codOrders,
      cancelledOrders,
      rtoOrders,
    });
  }
  return points;
}

const SALES_CACHE = new Map<string, SalesPoint[]>();
export function getSalesSeries(clientId: string, days = 90): SalesPoint[] {
  const key = `${clientId}:${days}`;
  if (!SALES_CACHE.has(key)) SALES_CACHE.set(key, generateSalesSeries(clientId, days));
  return SALES_CACHE.get(key)!;
}

export function getAllClientsSalesSeries(days = 90): SalesPoint[] {
  const key = `all:${days}`;
  if (!SALES_CACHE.has(key)) {
    const series = CLIENTS.map((c) => getSalesSeries(c.id, days));
    const merged: SalesPoint[] = series[0].map((_, i) => ({
      date: series[0][i].date,
      grossSales: series.reduce((s, arr) => s + arr[i].grossSales, 0),
      netSales: series.reduce((s, arr) => s + arr[i].netSales, 0),
      orders: series.reduce((s, arr) => s + arr[i].orders, 0),
      adSpend: series.reduce((s, arr) => s + arr[i].adSpend, 0),
      newCustomers: series.reduce((s, arr) => s + arr[i].newCustomers, 0),
      returningCustomers: series.reduce((s, arr) => s + arr[i].returningCustomers, 0),
      codOrders: series.reduce((s, arr) => s + arr[i].codOrders, 0),
      prepaidOrders: series.reduce((s, arr) => s + arr[i].prepaidOrders, 0),
      cancelledOrders: series.reduce((s, arr) => s + arr[i].cancelledOrders, 0),
      rtoOrders: series.reduce((s, arr) => s + arr[i].rtoOrders, 0),
    }));
    SALES_CACHE.set(key, merged);
  }
  return SALES_CACHE.get(key)!;
}

export function sumSeries(points: SalesPoint[]) {
  return points.reduce(
    (acc, p) => {
      acc.grossSales += p.grossSales;
      acc.netSales += p.netSales;
      acc.orders += p.orders;
      acc.adSpend += p.adSpend;
      acc.newCustomers += p.newCustomers;
      acc.returningCustomers += p.returningCustomers;
      acc.codOrders += p.codOrders;
      acc.prepaidOrders += p.prepaidOrders;
      acc.cancelledOrders += p.cancelledOrders;
      acc.rtoOrders += p.rtoOrders;
      return acc;
    },
    {
      grossSales: 0,
      netSales: 0,
      orders: 0,
      adSpend: 0,
      newCustomers: 0,
      returningCustomers: 0,
      codOrders: 0,
      prepaidOrders: 0,
      cancelledOrders: 0,
      rtoOrders: 0,
    },
  );
}

const STATES = ["Maharashtra", "Delhi", "Karnataka", "Tamil Nadu", "Uttar Pradesh", "Gujarat", "West Bengal", "Telangana", "Rajasthan", "Punjab"];
const CITIES: Record<string, string[]> = {
  Maharashtra: ["Mumbai", "Pune", "Nagpur"],
  Delhi: ["New Delhi", "Dwarka"],
  Karnataka: ["Bengaluru", "Mysuru"],
  "Tamil Nadu": ["Chennai", "Coimbatore"],
  "Uttar Pradesh": ["Lucknow", "Noida"],
  Gujarat: ["Ahmedabad", "Surat"],
  "West Bengal": ["Kolkata", "Howrah"],
  Telangana: ["Hyderabad", "Warangal"],
  Rajasthan: ["Jaipur", "Udaipur"],
  Punjab: ["Ludhiana", "Amritsar"],
};
const COURIERS = ["Delhivery", "Bluedart", "Ekart", "Xpressbees", "DTDC", "Shadowfax"];
const FIRST_NAMES = ["Aarav", "Vivaan", "Aditi", "Diya", "Kabir", "Ishaan", "Ananya", "Saanvi", "Reyansh", "Myra", "Arjun", "Zara", "Kiaan", "Anaya", "Vihaan", "Riya"];
const LAST_NAMES = ["Sharma", "Verma", "Gupta", "Iyer", "Reddy", "Menon", "Patel", "Chatterjee", "Nair", "Singh", "Kapoor", "Rao"];

const PRODUCT_CATALOG: Record<string, { name: string; category: string; color: string }[]> = {
  "abc-fashion": [
    { name: "Oversized Denim Jacket", category: "Outerwear", color: "bg-indigo-100 text-indigo-600" },
    { name: "Linen Co-ord Set", category: "Sets", color: "bg-rose-100 text-rose-600" },
    { name: "Classic White Sneakers", category: "Footwear", color: "bg-slate-100 text-slate-600" },
    { name: "Printed Maxi Dress", category: "Dresses", color: "bg-fuchsia-100 text-fuchsia-600" },
    { name: "Everyday Crew Tee", category: "Tops", color: "bg-cyan-100 text-cyan-600" },
    { name: "High-Rise Cargo Pants", category: "Bottoms", color: "bg-emerald-100 text-emerald-600" },
  ],
  "xyz-cosmetics": [
    { name: "Vitamin C Serum 30ml", category: "Skincare", color: "bg-amber-100 text-amber-600" },
    { name: "Matte Liquid Lipstick", category: "Makeup", color: "bg-rose-100 text-rose-600" },
    { name: "Hydra Glow Sunscreen SPF50", category: "Skincare", color: "bg-yellow-100 text-yellow-700" },
    { name: "Charcoal Face Wash", category: "Skincare", color: "bg-slate-100 text-slate-600" },
    { name: "Rose Water Toner", category: "Skincare", color: "bg-pink-100 text-pink-600" },
    { name: "Kajal & Eyeliner Combo", category: "Makeup", color: "bg-violet-100 text-violet-600" },
  ],
  "brand-c-electronics": [
    { name: "TWS Earbuds Pro", category: "Audio", color: "bg-slate-100 text-slate-600" },
    { name: "65W GaN Fast Charger", category: "Charging", color: "bg-cyan-100 text-cyan-600" },
    { name: "Smartwatch Series X", category: "Wearables", color: "bg-indigo-100 text-indigo-600" },
    { name: "Portable Bluetooth Speaker", category: "Audio", color: "bg-amber-100 text-amber-600" },
    { name: "USB-C Hub 7-in-1", category: "Accessories", color: "bg-emerald-100 text-emerald-600" },
    { name: "Wireless Charging Pad", category: "Charging", color: "bg-rose-100 text-rose-600" },
  ],
  "brand-d-foods": [
    { name: "Protein Granola 500g", category: "Breakfast", color: "bg-amber-100 text-amber-600" },
    { name: "Cold Pressed Almond Oil", category: "Pantry", color: "bg-emerald-100 text-emerald-600" },
    { name: "Roasted Makhana Mix", category: "Snacks", color: "bg-yellow-100 text-yellow-700" },
    { name: "Herbal Immunity Tea", category: "Beverages", color: "bg-lime-100 text-lime-700" },
    { name: "Dark Chocolate Almonds", category: "Snacks", color: "bg-stone-100 text-stone-600" },
    { name: "Organic Honey 500g", category: "Pantry", color: "bg-orange-100 text-orange-700" },
  ],
};

export function getOrders(clientId: string, count = 60): Order[] {
  const rand = mulberry32(seedFromString(clientId + ":orders"));
  const base = CLIENT_BASE[clientId] ?? CLIENT_BASE["abc-fashion"];
  const products = PRODUCT_CATALOG[clientId] ?? PRODUCT_CATALOG["abc-fashion"];
  const statuses: OrderStatus[] = [
    "Delivered",
    "Delivered",
    "Delivered",
    "In Transit",
    "Out for Delivery",
    "Dispatched",
    "NDR",
    "RTO Initiated",
    "RTO Delivered",
    "Cancelled",
  ];
  const orders: Order[] = [];
  for (let i = 0; i < count; i++) {
    const state = STATES[Math.floor(rand() * STATES.length)];
    const cityList = CITIES[state];
    const city = cityList[Math.floor(rand() * cityList.length)];
    const status = statuses[Math.floor(rand() * statuses.length)];
    const amount = Math.round(base.aov * (0.5 + rand() * 1.3));
    const d = new Date("2026-08-21T00:00:00Z");
    d.setDate(d.getDate() - Math.floor(rand() * 30));
    orders.push({
      id: `#${10000 + Math.floor(rand() * 89999)}`,
      clientId,
      customer: `${FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(rand() * LAST_NAMES.length)]}`,
      date: d.toISOString().slice(0, 10),
      amount,
      status,
      payment: rand() > 0.45 ? "Prepaid" : "COD",
      city,
      state,
      courier: COURIERS[Math.floor(rand() * COURIERS.length)],
      product: products[Math.floor(rand() * products.length)].name,
    });
  }
  return orders.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function getProducts(clientId: string): Product[] {
  const rand = mulberry32(seedFromString(clientId + ":products"));
  const base = CLIENT_BASE[clientId] ?? CLIENT_BASE["abc-fashion"];
  const products = PRODUCT_CATALOG[clientId] ?? PRODUCT_CATALOG["abc-fashion"];
  return products
    .map((p, idx) => {
      const orders = Math.round((base.orders / products.length) * (0.5 + rand() * 1.4) * (products.length - idx * 0.3));
      const sales = Math.round(orders * base.aov * (0.85 + rand() * 0.4));
      const rtoPercent = Math.max(3, base.rto + (rand() - 0.5) * 14);
      return {
        id: `prod-${clientId}-${idx}`,
        name: p.name,
        image: p.color,
        category: p.category,
        orders,
        sales,
        netSales: Math.round(sales * (1 - rtoPercent / 100 - 0.03)),
        rtoPercent: Math.round(rtoPercent * 10) / 10,
        cancellationPercent: Math.round((3 + rand() * 6) * 10) / 10,
        trend: Array.from({ length: 12 }, () => Math.round(20 + rand() * 80)),
      };
    })
    .sort((a, b) => b.sales - a.sales);
}

export function getGeoBreakdown(clientId: string, level: "state" | "city" = "state"): GeoRow[] {
  const rand = mulberry32(seedFromString(clientId + ":geo:" + level));
  const base = CLIENT_BASE[clientId] ?? CLIENT_BASE["abc-fashion"];
  const names = level === "state" ? STATES : Object.values(CITIES).flat();
  return names
    .map((name) => {
      const orders = Math.round((base.orders / (level === "state" ? 6 : 14)) * (0.4 + rand() * 1.6));
      const sales = Math.round(orders * base.aov);
      const rtoPercent = Math.max(4, base.rto + (rand() - 0.5) * 20);
      const delivered = Math.round(orders * (1 - rtoPercent / 100 - 0.05));
      return {
        name,
        orders,
        sales,
        delivered,
        rto: Math.round(orders * (rtoPercent / 100)),
        rtoPercent: Math.round(rtoPercent * 10) / 10,
        cancellationPercent: Math.round((3 + rand() * 6) * 10) / 10,
        previousRtoPercent: Math.round(Math.max(3, rtoPercent - (rand() - 0.3) * 12) * 10) / 10,
      };
    })
    .sort((a, b) => b.sales - a.sales);
}

export function getCourierBreakdown(clientId: string) {
  const rand = mulberry32(seedFromString(clientId + ":courier"));
  const base = CLIENT_BASE[clientId] ?? CLIENT_BASE["abc-fashion"];
  return COURIERS.map((name) => {
    const orders = Math.round((base.orders / 4) * (0.5 + rand() * 1.2));
    const rtoPercent = Math.max(4, base.rto + (rand() - 0.5) * 16);
    return {
      name,
      orders,
      delivered: Math.round(orders * (1 - rtoPercent / 100 - 0.04)),
      rtoPercent: Math.round(rtoPercent * 10) / 10,
      avgDeliveryDays: Math.round((2.5 + rand() * 3) * 10) / 10,
      ndrPercent: Math.round((4 + rand() * 8) * 10) / 10,
    };
  }).sort((a, b) => b.orders - a.orders);
}

const CAMPAIGN_NAMES = [
  "Summer Sale — Prospecting",
  "Retargeting — Cart Abandoners",
  "New Launch Awareness",
  "Festive Collection Push",
  "Lookalike — Top Buyers",
  "Brand Video — Reach",
];

export function getCampaigns(clientId: string, platform: "meta" | "google"): Campaign[] {
  const rand = mulberry32(seedFromString(clientId + ":" + platform));
  const base = CLIENT_BASE[clientId] ?? CLIENT_BASE["abc-fashion"];
  const statuses: Campaign["status"][] = ["Active", "Active", "Active", "Paused", "In Review", "Completed"];
  return CAMPAIGN_NAMES.map((name, idx) => {
    const spend = Math.round(base.orders * base.aov * base.spendRatio * (0.08 + rand() * 0.1));
    const roas = Math.max(0.8, base.roas + (rand() - 0.5) * 1.6);
    const results = Math.round((spend * roas) / base.aov);
    // Derive clicks/impressions/cpm from cpc + ctr so every metric stays
    // mutually consistent (spend / clicks == cpc, clicks / impressions == ctr).
    const cpc = Math.round((8 + rand() * 20) * 100) / 100;
    const clicks = Math.max(1, Math.round(spend / cpc));
    const ctr = Math.round((1.2 + rand() * 2.3) * 100) / 100;
    const impressions = Math.max(clicks, Math.round(clicks / (ctr / 100)));
    const cpm = Math.round((spend / impressions) * 1000 * 100) / 100;
    return {
      id: `camp-${clientId}-${platform}-${idx}`,
      clientId,
      platform,
      name: platform === "google" ? name.replace("—", "-") + " (Search)" : name,
      status: statuses[idx % statuses.length],
      spend,
      results,
      resultType: platform === "meta" ? "Purchases" : "Conversions",
      impressions,
      clicks,
      ctr,
      cpc,
      cpm,
      roas: Math.round(roas * 100) / 100,
    };
  });
}

const CREATIVE_LIBRARY: { name: string; format: Creative["format"]; headline: string; primaryText: string; cta: string }[] = [
  {
    name: "Product Hero Shot",
    format: "Image",
    headline: "The bestseller everyone's talking about",
    primaryText: "Premium quality, made to last. Free shipping on all orders this week — shop the collection before it's gone.",
    cta: "Shop Now",
  },
  {
    name: "UGC Testimonial",
    format: "Video",
    headline: "Real customers, real results",
    primaryText: "\"I wasn't expecting it to be this good.\" See why thousands of customers keep coming back.",
    cta: "Watch & Shop",
  },
  {
    name: "Before / After Carousel",
    format: "Carousel",
    headline: "See the difference for yourself",
    primaryText: "Swipe through to see real transformations from our community. Your turn starts here.",
    cta: "Get Offer",
  },
  {
    name: "Founder Story",
    format: "Video",
    headline: "Why we started this brand",
    primaryText: "A short story about the problem we set out to solve — and why customers trust us with theirs.",
    cta: "Learn More",
  },
  {
    name: "Limited-Time Discount",
    format: "Image",
    headline: "20% off — this week only",
    primaryText: "Our most popular styles are on sale. Stock is limited, so don't wait to grab yours.",
    cta: "Get Offer",
  },
  {
    name: "Lifestyle Flatlay",
    format: "Image",
    headline: "Made for everyday life",
    primaryText: "Designed to fit seamlessly into your routine. Explore the full range and find your favorite.",
    cta: "Shop Now",
  },
];

export function getCreatives(campaign: Campaign): Creative[] {
  const rand = mulberry32(seedFromString(campaign.id + ":creatives"));
  const count = 2 + Math.floor(rand() * 3);
  const weights = Array.from({ length: count }, () => 0.5 + rand());
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  return weights.map((weight, idx) => {
    const share = weight / totalWeight;
    const lib = CREATIVE_LIBRARY[(idx * 2 + Math.floor(rand() * CREATIVE_LIBRARY.length)) % CREATIVE_LIBRARY.length];
    const spend = Math.max(1, Math.round(campaign.spend * share));
    const impressions = Math.max(1, Math.round(campaign.impressions * share));
    const clicks = Math.max(1, Math.round(campaign.clicks * share * (0.75 + rand() * 0.5)));
    const ctr = Math.round((clicks / impressions) * 10000) / 100;
    const cpc = Math.round((spend / clicks) * 100) / 100;
    const results = Math.max(0, Math.round(campaign.results * share * (0.65 + rand() * 0.7)));
    const roas = Math.max(0.4, Math.round((campaign.roas * (0.6 + rand() * 0.9)) * 100) / 100);
    const isWeakest = idx === count - 1 && roas < campaign.roas * 0.7;

    return {
      id: `${campaign.id}-cr-${idx}`,
      campaignId: campaign.id,
      name: lib.name,
      format: lib.format,
      headline: lib.headline,
      primaryText: lib.primaryText,
      cta: lib.cta,
      thumbnailUrl: null,
      status: isWeakest && rand() > 0.4 ? "Paused" : "Active",
      spend,
      impressions,
      clicks,
      ctr,
      cpc,
      results,
      roas,
      hookRate: lib.format === "Video" ? Math.round((28 + rand() * 30) * 10) / 10 : null,
      holdRate: lib.format === "Video" ? Math.round((8 + rand() * 18) * 10) / 10 : null,
      launchedDate: "2026-07-" + (10 + (idx % 15)),
    };
  });
}

export function getCampaignActivity(campaignId: string): CampaignActivity[] {
  const rand = mulberry32(seedFromString(campaignId + ":activity"));
  const script: Omit<CampaignActivity, "id" | "campaignId" | "timestamp">[] = [
    { type: "created", author: "System", authorRole: "system", message: "Campaign created and launched." },
    { type: "note", author: "Client", authorRole: "client", message: "Please reduce the daily budget slightly and test a new creative — engagement feels flat this week." },
    { type: "response", author: "Marketing Team", authorRole: "marketing", message: "Understood — pausing the underperforming ad set and uploading two new creative variants for testing." },
    { type: "creative", author: "Marketing Team", authorRole: "marketing", message: "New UGC-style creative uploaded and testing has started on a 20% budget split." },
    { type: "budget", author: "Marketing Team", authorRole: "marketing", message: "Daily budget adjusted from ₹8,000 to ₹6,500 as requested." },
    { type: "note", author: "Client", authorRole: "client", message: "The new creative looks great. Approved — please continue testing for another 3 days." },
    { type: "status", author: "Marketing Team", authorRole: "marketing", message: "Marked task as completed. Monitoring performance daily." },
  ];
  const start = new Date("2026-08-14T09:00:00Z").getTime();
  return script.map((s, i) => ({
    ...s,
    id: `${campaignId}-act-${i}`,
    campaignId,
    timestamp: new Date(start + i * (3 + rand() * 10) * 3600 * 1000).toISOString(),
  }));
}

const TASK_TITLES = [
  "Review Maharashtra RTO spike",
  "Approve new creative for Summer Sale",
  "Follow up on delayed Delhivery shipments",
  "Prepare weekly performance report",
  "Update product images on Shopify",
  "Investigate cancellation spike — Electronics",
  "Negotiate courier rates for Q3",
  "Set up retargeting audience for cart abandoners",
  "Reconcile COD remittance for July",
  "Draft festive campaign brief",
  "Fix NDR follow-up SOP with ops team",
  "Client monthly review call — prep deck",
];

export function getTasks(clientId?: string): CrmTask[] {
  const rand = mulberry32(seedFromString((clientId ?? "all") + ":tasks"));
  const assignees = ["Riya Kapoor", "Aditya Rao", "Meera Nair", "Karan Singh", "Priya Menon", "Sameer Khan"];
  const priorities: CrmTask["priority"][] = ["Low", "Medium", "High", "Urgent"];
  const statuses: CrmTask["status"][] = ["To Do", "In Progress", "Waiting", "Completed"];
  const clientPool = clientId ? [clientId] : CLIENTS.map((c) => c.id);

  return TASK_TITLES.map((title, i) => {
    const cid = clientPool[Math.floor(rand() * clientPool.length)];
    const d = new Date("2026-08-21T00:00:00Z");
    d.setDate(d.getDate() + Math.floor(rand() * 14) - 4);
    return {
      id: `task-${i}`,
      clientId: cid,
      title,
      description: "Auto-generated task description outlining the required follow-up and expected outcome for the team.",
      assignee: assignees[Math.floor(rand() * assignees.length)],
      priority: priorities[Math.floor(rand() * priorities.length)],
      status: statuses[i % statuses.length],
      dueDate: d.toISOString().slice(0, 10),
      comments: Math.floor(rand() * 6),
      tags: rand() > 0.5 ? ["Ops"] : rand() > 0.3 ? ["Marketing"] : ["Client Facing"],
    };
  });
}

const NOTIF_SCRIPT: { kind: AppNotification["kind"]; title: string; description: string }[] = [
  { kind: "campaign", title: "New campaign feedback", description: "added a note to Summer Sale — Prospecting campaign." },
  { kind: "rto", title: "RTO alert", description: "Maharashtra RTO crossed 30% threshold this week." },
  { kind: "task", title: "Task assigned to you", description: "You were assigned: \"Review Maharashtra RTO spike\"." },
  { kind: "sales", title: "Sales dip detected", description: "Orders dropped 22% compared to the same day last week." },
  { kind: "ads", title: "Ad spend anomaly", description: "Ad spend increased 18% while conversions stayed flat." },
  { kind: "roas", title: "Blended ROAS below target", description: "Blended ROAS fell to 2.4x, below your 3.0x threshold." },
  { kind: "task", title: "Task marked completed", description: "\"Approve new creative for Summer Sale\" was completed." },
  { kind: "campaign", title: "Marketing team responded", description: "responded to your feedback on Retargeting — Cart Abandoners." },
  { kind: "system", title: "Weekly summary ready", description: "Your weekly performance summary is ready to view." },
];

export function getNotifications(): AppNotification[] {
  const rand = mulberry32(42);
  const start = new Date("2026-08-21T09:00:00Z").getTime();
  return NOTIF_SCRIPT.map((n, i) => {
    const clientId = CLIENTS[Math.floor(rand() * CLIENTS.length)].id;
    return {
      id: `notif-${i}`,
      clientId,
      kind: n.kind,
      title: n.title,
      description: n.description,
      timestamp: new Date(start - i * (40 + rand() * 90) * 60 * 1000).toISOString(),
      read: i > 3,
    };
  });
}

export const TEAM: TeamMember[] = [
  { id: "t1", name: "Riya Kapoor", role: "Owner", email: "riya@agency.com", clients: CLIENTS.map((c) => c.id) },
  { id: "t2", name: "Aditya Rao", role: "Manager", email: "aditya@agency.com", clients: ["abc-fashion", "xyz-cosmetics"] },
  { id: "t3", name: "Meera Nair", role: "Marketer", email: "meera@agency.com", clients: ["brand-c-electronics"] },
  { id: "t4", name: "Karan Singh", role: "Manager", email: "karan@agency.com", clients: ["brand-d-foods"] },
  { id: "t5", name: "Priya Menon", role: "Team Member", email: "priya@agency.com", clients: ["abc-fashion"] },
  { id: "t6", name: "Sameer Khan", role: "Team Member", email: "sameer@agency.com", clients: ["xyz-cosmetics", "brand-d-foods"] },
];

export function relativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const refDiff = new Date("2026-08-21T09:30:00Z").getTime() - new Date(iso).getTime();
  const diff = Math.max(refDiff, diffMs > 0 ? refDiff : refDiff);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
