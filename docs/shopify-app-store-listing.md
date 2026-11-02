# Shopify App Store listing — copy to paste at submission

Draft content for the Partner/dev dashboard's App Store listing form. Edit freely — this is a
starting point, not final copy.

## App name

D2C Dashboard

## Tagline (one line, shown in search results)

Sales, ads, and fulfilment — one dashboard, auto-connected to your store.

## Category

Store management → Analytics (or "Reporting" if that's a separate category in the current
dashboard — check what's offered when you get to this step, categories change over time)

## App introduction (short, 100 char or so)

See your Shopify sales, Meta/Google ad spend, and courier delivery status in one place —
connected automatically the moment you install.

## App details (longer description, several paragraphs — this is the main listing copy)

D2C Dashboard pulls your store's orders, your ad spend across Meta and Google, and your courier
delivery status into one analytics view — so you stop tab-switching between Shopify Admin, Ads
Manager, and your courier's own dashboard just to answer "how did we do this week?"

**What you get, automatically, the moment you install:**
- Your Shopify orders, synced and kept current, broken down by status, payment method, and
  location.
- A blended view of ad spend and return once you optionally connect Meta Ads and/or Google Ads —
  see true cost-per-order and ROAS across both platforms side by side, not two separate reports.
- Delivery and RTO (return-to-origin) tracking once you connect a courier partner (Shiprocket or
  Delhivery), so you catch fulfilment problems before they show up as refunds.
- Real-time alerts for sales dips, RTO spikes, and ad-spend anomalies — not just a dashboard you
  have to remember to check.

**No manual setup.** Installing from the Shopify App Store automatically creates your account,
connects your store, and signs you in — pick a plan, and you're looking at your data in minutes.

**Your data stays yours.** We only request read access to what the Dashboard actually displays.
Uninstalling removes your account and data immediately — see our Privacy Policy for details.

## Pricing shown on the listing

| Plan | Price | Notes |
|---|---|---|
| Small | $19/mo | up to 300 orders/month |
| Medium | $39/mo | up to 1,500 orders/month |
| Large | $79/mo | up to 5,000 orders/month |

**These 3 figures (`PLAN_PRICES_USD` in `server/src/integrations/shopify-billing.ts`) are still
explicitly flagged in the code as placeholder/unconfirmed pricing** — get real sign-off on these
numbers before they go in front of real merchants, since they're what actually gets charged via
Shopify Billing, not just listing copy.

## Support

- Support email: `admin@probild.in`
- Privacy Policy URL: `https://d2c.probild.online/privacy-policy.html`
- Terms of Service URL: `https://d2c.probild.online/terms-of-service.html`
- Data deletion instructions: `https://d2c.probild.online/data-deletion.html`

## Required app icon

Shopify asks for a **1200×1200px PNG or JPG, under 1MB**. This repo only has an SVG favicon
(`public/favicon.svg` — indigo rounded square, white ring, cyan dot) as a brand-mark reference;
there's no image-generation or SVG-rasterization tool available in this environment to produce
the actual PNG. Options: export a 1200×1200 PNG from that same mark in Figma/Canva/any design
tool, or have a designer produce a fresh icon using it as the starting reference.

## Required screenshots / demo

Shopify asks for a handful of screenshots (and optionally a short demo video) showing the app in
actual use. These need to be captured from the real, live dashboard — not something this session
can generate without browser access to click through the live UI. Suggested shots, in order of
what sells the product fastest:
1. The main dashboard view (sales/ads/fulfilment overview) with real-looking data.
2. The blended Meta+Google ad-spend comparison view.
3. An RTO/delivery-status screen.
4. The plan picker merchants land on right after install (`/shopify-app/plans`) — shows the
   "zero manual setup" story directly.

## Known pre-submission blockers, not yet done

- [ ] Real pricing sign-off on the 3 USD figures above.
- [ ] 1200×1200 app icon.
- [ ] Listing screenshots.
- [ ] Governing-law placeholder in `terms-of-service.html` needs a real jurisdiction filled in.
- [ ] `shopify.app.toml` deployed (`npx @shopify/cli@latest app deploy`) — creates the app's
  first configuration version, without which Shopify rejects every install link.
- [ ] The 4 mandatory webhooks registered in the Partner Dashboard, pointing at
  `https://d2c.probild.online/api/webhooks/shopify-app/...`.
- [ ] Submit for Shopify's protected customer data access review (separate gate from general
  app review — can block the whole listing if not done ahead of time).
