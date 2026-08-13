#!/usr/bin/env python3
"""
Dinner How — pilot summary
Reads the tracking Google Sheet (or a downloaded CSV) and prints the conversion funnel
and the incremental-basket numbers for the FairPrice conversation.

USAGE
  python3 dinnerhow_summary.py <source> [--out summary.txt]

  <source> is either:
    - a published-CSV URL   (Sheet > File > Share > Publish to web > choose the tab > CSV)
    - a path to a downloaded .csv

  --out writes the summary to a text file as well as printing it.

Expected sheet headings (order doesn't matter, extra columns are ignored):
  time  sid  event  id  dish  method  source  from  to
  basket_size  basket_dishes  buy_count  missing_count  have_count  buy_ids
  sourced  sourced_ids

Only dependency: pandas  (pip install pandas)
"""
import sys, argparse
import pandas as pd

def load(source):
    # pandas reads a URL or a local path the same way
    df = pd.read_csv(source, dtype=str).fillna("")
    df.columns = [c.strip().lower() for c in df.columns]
    return df

def num(s):
    try: return int(float(s))
    except: return 0

def pct(a, b):
    return f"{100*a/b:.0f}%" if b else "—"

def summarise(df):
    L = []
    def out(line=""): L.append(line)

    if df.empty:
        out("No rows in the sheet yet.")
        return "\n".join(L)

    ev = df["event"] if "event" in df else pd.Series([""]*len(df))
    sids = df["sid"] if "sid" in df else pd.Series([""]*len(df))

    # ---- per-session funnel ----
    sessions = {}
    for _, r in df.iterrows():
        s = r.get("sid","")
        if not s: continue
        d = sessions.setdefault(s, {"composed":0,"added":0,"copied":0})
        e = r.get("event","")
        if e == "dish_composed": d["composed"] += 1
        elif e == "dish_added_to_basket": d["added"] += 1
        elif e == "list_copied": d["copied"] += 1

    n_sessions = len(sessions)
    n_composed = sum(1 for d in sessions.values() if d["composed"] > 0)
    n_added    = sum(1 for d in sessions.values() if d["added"]    > 0)
    n_copied   = sum(1 for d in sessions.values() if d["copied"]   > 0)

    out("="*56)
    out("  DINNER HOW — PILOT SUMMARY")
    out("="*56)
    # time span
    if "time" in df:
        ts = pd.to_datetime(df["time"], errors="coerce").dropna()
        if len(ts) >= 2:
            span = (ts.max() - ts.min())
            out(f"  Window: {ts.min():%Y-%m-%d} → {ts.max():%Y-%m-%d}  ({span.days} days)")
    out(f"  Total events logged: {len(df)}")
    out("")
    out("  CONVERSION FUNNEL  (unit = session)")
    out("  " + "-"*44)
    out(f"  1. sessions ................ {n_sessions:>5}   100%")
    out(f"  2. composed a dish ......... {n_composed:>5}   {pct(n_composed,n_sessions):>4}")
    out(f"  3. added to basket ......... {n_added:>5}   {pct(n_added,n_sessions):>4}   ← conversion")
    out(f"  4. copied shopping list .... {n_copied:>5}   {pct(n_copied,n_sessions):>4}   ← intent to shop")
    out("")
    out("  KEY RATES")
    out("  " + "-"*44)
    out(f"  compose → basket ........... {pct(n_added, n_composed)}")
    out(f"  basket → list .............. {pct(n_copied, n_added)}")
    out(f"  overall conversion ......... {pct(n_added, n_sessions)}")
    out("")

    # ---- incremental basket (the retailer story) ----
    copied = df[ev == "list_copied"]
    dabs   = df[ev == "dish_added_to_basket"]

    total_items    = sum(num(x) for x in copied.get("missing_count", copied.get("items", pd.Series([],dtype=str))))
    # the sheet may store the list size under 'missing_count' (list_generated) or the copied 'items';
    # dish_added_to_basket carries buy_count. Prefer list_copied item counts, fall back to buy_count sum.
    if total_items == 0 and "buy_count" in df:
        total_items = sum(num(x) for x in dabs.get("buy_count", pd.Series([],dtype=str)))

    total_sourced = sum(num(x) for x in copied.get("sourced", pd.Series([],dtype=str)))
    if total_sourced == 0:
        total_sourced = sum(num(x) for x in dabs.get("sourced", pd.Series([],dtype=str)))

    n_lists = len(copied)
    out("  INCREMENTAL BASKET  (for the retailer story)")
    out("  " + "-"*44)
    out(f"  shopping lists taken ....... {n_lists:>5}")
    if n_lists:
        out(f"  avg items per list ......... {total_items/n_lists:>5.1f}")
    out(f"  app-suggested items (total)  {total_sourced:>5}")
    if n_lists:
        out(f"  avg suggested per list ..... {total_sourced/n_lists:>5.1f}")
    out(f"  % of basket we drove ....... {pct(total_sourced, total_items):>5}")
    out("")

    # ---- which SKUs the app moves most (buy_ids that were sourced) ----
    sku = {}
    for _, r in df.iterrows():
        if r.get("event") not in ("dish_added_to_basket","list_copied"): continue
        for i in str(r.get("sourced_ids","")).split("|"):
            i = i.strip()
            if i: sku[i] = sku.get(i,0)+1
    if sku:
        out("  TOP APP-DRIVEN ITEMS  (SKUs we most often add to basket)")
        out("  " + "-"*44)
        for name, n in sorted(sku.items(), key=lambda x:-x[1])[:10]:
            out(f"    {name:<24} {n:>4}")
        out("")

    # ---- which dishes convert ----
    dishct = {}
    for _, r in dabs.iterrows():
        d = r.get("dish","")
        if d: dishct[d] = dishct.get(d,0)+1
    if dishct:
        out("  MOST-ADDED DISHES")
        out("  " + "-"*44)
        for name, n in sorted(dishct.items(), key=lambda x:-x[1])[:10]:
            out(f"    {name:<28} {n:>4}")
        out("")

    out("  NOTE: 'session' = one browser, not a verified person (anonymous pilot id).")
    out("  Phrase claims as per-session, not per-shopper.")
    out("="*56)
    return "\n".join(L)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source", help="published-CSV URL or path to a .csv")
    ap.add_argument("--out", help="also write the summary to this text file")
    a = ap.parse_args()
    try:
        df = load(a.source)
    except Exception as e:
        print(f"Could not read the sheet/CSV: {e}")
        sys.exit(1)
    text = summarise(df)
    print(text)
    if a.out:
        with open(a.out, "w") as f: f.write(text + "\n")
        print(f"\n[written to {a.out}]")

if __name__ == "__main__":
    main()
