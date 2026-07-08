# Dinner How?

Compose a Singaporean-style meal, and let the kitchen work out the schedule.

Dinner How? is a prototype meal planner built around a cooking-reasoning engine. You
pick a meal shape, tell it what appliances you own, and it composes a meal,
schedules every dish across your hob, oven, pressure cooker and air fryer, and
tells you when to start cooking so everything lands on the table at once.

**Live demo:** https://LingBL92.github.io/dinner-how/

## What it does

**Reads recipes and works out the cooking.** Give it a step that says "simmer for
1 hour" and it knows that is moist heat, that the pork ribs in the pot are
collagen-rich, that collagen therefore breaks down, and that the dish will be
fall-apart tender. Give it a pressure cooker instead and it knows the same hour
takes about twenty minutes.

**Schedules a whole meal, not one recipe.** It knows your hob has a fixed number
of burners, that a pressure cooker holds one dish at a time, and that an oven can
hold two only if they bake at a similar temperature. It starts the long braise
early, pulls the stir-fry to the end, and tells you when to begin.

**Reasons about cuts.** Pork ribs are collagen-rich and pork loin is lean, so ribs
want a braise and a loin wants a quick sear. Pick a different cut and the method,
the time, and the whole schedule change.

**Knows a Tuesday from a Sunday.** It opens on a weeknight dinner — rice, a
vegetable, a meat, about an hour of hands-on cooking. Switch to Weekend when you
want fish and soup on the table too.

**Finds the free time,** and marks the stretches where nothing needs your hands.

**Balances flavour** on six axes — sweet, sour, salty, savoury, rich, spicy —
derived from what is actually in the pot.

## Files

```
index.html               the application: engine and interface
data/dishes.json         THE MENU — curate recipes here
data/ingredients.json    what each ingredient IS
data/methods.json        how cooking works: methods, reactions, timing
data/appliances.json     capacity, speed, volume
```

The app reads the four data files at load. No recipe knowledge is compiled into
the code.

## Curating the menu

Open `data/dishes.json`. You write only what a cook knows:

```json
{
  "name": "Bak Kut Teh",
  "role": "soup",
  "cuisine": "asian",
  "appliance": "stovetop",
  "appliances": ["stovetop", "pressure_cooker", "slow_cooker"],
  "ingredients": ["600 g pork ribs", "1 bulb garlic", "8 cups water"],
  "steps": [
    "Blanch the pork ribs in boiling water for 2 minutes, then drain.",
    "Simmer for 1 hour until the pork is tender."
  ],
  "serves": 4
}
```

Dinner How? works out the rest when it loads: how long the dish takes **on each
appliance** (stovetop 109 min, pressure cooker 50, slow cooker 379), what the
cooking produces ("fall-apart tender", "rich broth"), the shopping list and its
quantities, which aisle each item belongs in, the taste profile, the protein tag,
whether it is a slow-cook or a quick-cook, and how each ingredient gets prepped.

Never write those by hand. Change a step and everything downstream follows.

Adding an appliance is one word in the `appliances` list. If that appliance needs
different instructions, add them under `steps_variants` — and note that times
stated there belong to that appliance, so they are used as written rather than
rescaled.

If you disagree with the engine, add an explicit `time` or `results` to a dish and
it wins.

### Teaching it a new ingredient

An ingredient Dinner How? does not know is dropped from the shopping list and the
taste profile, and a warning naming the dish and the line appears in the browser
console. Add it to `data/ingredients.json`:

```json
{
  "id": "curry_leaves",
  "name": "Curry leaves",
  "aliases": ["curry leaves", "curry leaf"],
  "provides": ["aromatic"],
  "aisle": "Herbs & spices",
  "prep_verb": "measure"
}
```

`aliases` are matched against your ingredient lines and the longest match wins, so
`sesame oil` beats a bare `oil`. `provides` are the property flags the reasoning
runs on — `protein`, `collagen_rich`, `sugar`, `salt`, `acid`, `fat_solid`,
`fat_liquid`, `starch`, `water`. Meat cuts carry a `cut_role` of `braise`, `quick`
or `mince`, which is how the engine tells a rib from a loin.

### Teaching it a cooking method

`data/methods.json` holds the cooking knowledge. Each method has aliases matched
against your steps, a `heat_mode`, the reactions it could cause, and a default
`timing` used when a step states no duration. Each reaction lists the conditions
under which it fires. Maillard browning, for instance, needs protein or starch,
a dry surface, and a dry heat mode — so it happens when you sear a steak and not
when you boil one.

If a step's cooking verb is not recognised, the dish's time will be prep only, and
a console warning says so. Add the verb to the right method's aliases.

## Running it

The app fetches `data/*.json`, so it must be served over http — opening the file
directly will not work.

```
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

## Deploying to GitHub Pages

1. Put `index.html`, `README.md`, `.nojekyll` and the `data/` folder in a repository.
2. **Settings → Pages → Source: Deploy from a branch**, pick your branch and the
   root folder, save.
3. Visit `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

## Honest notes

**Cooking times are estimates, not measurements.** The engine derives them from
each recipe's steps, ingredients and appliance. They were sanity-checked against
real recipes at the level of cooking method — stir-fry, braise, roast, poach,
pressure-cook — and land in sensible ranges. Individual dishes were not each
verified in a kitchen. Treat them as a good guide to planning, not a stopwatch.

**The reasoning is heuristic and it shows.** A step that says "bring broth to a
boil" is read as a moist-heat method, which lists reduction among its possible
reactions, so a couscous salad can end up labelled "rich sauce". The engine reads
cooking verbs, not intent. Where it is wrong, correct it with an explicit
`results` on the dish, or sharpen the method's aliases.

**A wrong time fails quietly.** A missing ingredient disappears from the shopping
list and you notice. A misread cooking verb produces a plausible number and you do
not. Watch the browser console after editing — it warns on unknown ingredients and
on steps where no cooking method was recognised.

**Recipes are authored.** Fourteen Western dishes come from USDA MyPlate Kitchen
(public domain). The Singaporean, Southeast Asian and Japanese dishes were written
for this project.

**Your kitchen is remembered, nothing else.** Which appliances you own, how many
burners, and how many you cook for are kept in your browser's local storage so the
second visit is not the first. Nothing leaves your device — there is no backend, no
login, no analytics. Clear your browser data to reset it.

**Web fonts load from Google Fonts,** so styling needs an internet connection.
