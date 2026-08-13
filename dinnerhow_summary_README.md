# Dinner How — pilot summariser

A small Python script that reads your tracking Google Sheet and prints the conversion funnel and the
incremental-basket numbers for the FairPrice conversation. The Sheet stays the single source of
truth; you run this whenever you want a summary.

## One-time setup

```
pip install pandas
```

## Getting your Sheet into the script — two ways

**Easiest (published CSV, no login):**
1. In the Sheet: **File → Share → Publish to web**
2. Choose the tab with your events, format **CSV**, click **Publish**
3. Copy the URL it gives you (ends in `output=csv`)
4. Run:
   ```
   python3 dinnerhow_summary.py "https://docs.google.com/.../pub?output=csv"
   ```

**Offline (downloaded file):** File → Download → CSV, then:
```
python3 dinnerhow_summary.py ~/Downloads/DinnerHow.csv
```

## Save the summary to a file (for the pitch)

```
python3 dinnerhow_summary.py "<url or path>" --out summary.txt
```

## What it prints

- **Conversion funnel** — sessions → composed → added to basket → copied list, with %s
- **Key rates** — compose→basket, basket→list, overall conversion
- **Incremental basket** — avg items per list, app-suggested items, and **% of basket we drove**
- **Top app-driven items** — the SKUs Dinner How most often adds to the basket
- **Most-added dishes** — which dishes convert

## Notes

- It expects the sheet headings you set:
  `time, sid, event, id, dish, method, source, from, to, basket_size, basket_dishes,
  buy_count, missing_count, have_count, buy_ids, sourced, sourced_ids`.
  Extra columns are ignored; missing ones are treated as blank.
- `sid` is one browser, not a verified person — the script prints a reminder to phrase claims as
  **per session**, not per shopper. Keep that honest in the pitch.
- The `sourced` / `sourced_ids` columns are what make the "we drove it" number work. They started
  logging in app v4.65, so only sessions from that version onward carry attribution; older rows
  still count for the funnel but show 0 sourced.
