# TripSplit ☥ — split trip expenses, no passwords

## Put it on Hostinger (5 minutes)
1. hPanel → **Websites → Manage → File Manager → public_html** (or a sub-folder like `public_html/trip`).
2. **Upload `tripsplit.zip`** there and **Extract** it. (index.html must sit directly in the folder.)
3. Make sure PHP 8+ is on (hPanel → Advanced → PHP Configuration). SQLite is included — no database to create.
4. Open `https://yourdomain.com/` (or `/trip/`). Create the trip, then tap **Share** and send the link on WhatsApp.

## Using it
- Friend opens the link → types name → taps Male/Female → **Join**. Done, no password.
- **＋** adds an expense (icon auto-picks: hotel, flights, taxi, camel…). Split equally or by amount. "Just for me" = private personal spending.
- **Settle** shows the fewest payments needed; tap *Mark paid*. **Stats** shows totals per person and per category. CSV export included.
- Install: Android Chrome → ⋮ → *Install app*; iPhone Safari → Share → *Add to Home Screen*. (HTTPS is on by default on Hostinger.)

## Notes
- Data lives in `api/data/tripsplit.sqlite` (blocked from the web by .htaccess). Back it up now and then.
- Name-only join = anyone with the link can join. Keep the link inside your group.

## v6 additions
Lend money (Expense | Lend toggle, or Settle tab) · category strip with filter · Stats: Total / Per person · EGP entry with group rate · WhatsApp remind + share summary.
