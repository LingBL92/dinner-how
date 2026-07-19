# Dish images

Drop dish photos here. The app shows a photo when a file matches the dish's key,
and falls back to the generative SVG art when there's no matching file.

## Filename = the dish key
Format:  <method>_<subject>_<direction>.jpg   (.png and .webp also work)
- method:     steam | stirfry | rice | onepot
- subject:    the main ingredient id (e.g. pomfret, chicken_thigh, pork_ribs)
- direction:  the seasoning/style key (e.g. ginger_scallion, sambal, claypot, soup)
              use "plain" if no direction is selected
All lowercase; any non-letter/number becomes an underscore.

## Examples
steam_pomfret_ginger_scallion.jpg
stirfry_chicken_thigh_sambal.jpg
rice_chicken_thigh_claypot.jpg
onepot_pork_ribs_soup.jpg

Tip: open the browser console on a dish and it will try to load its exact filename —
if the image 404s, the name doesn't match the key. Match the name and it appears.
