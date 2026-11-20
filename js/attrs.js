// Merkmale, die FashionSigLIP zusätzlich zur Kategorie erkennt: Muster, Style, Saison (Wärme).
// Jede Klasse hat mehrere englische Beschreibungen; ihre Text-Vektoren werden gemittelt
// (vorberechnet mit tools/labels.html → js/attrs.json). Ändern sich die prompts, attrs.json neu erzeugen.
// Reihenfolge und ids müssen zu attrs.json passen (wird beim Laden geprüft).

export const ATTR_GROUPS = {
  pattern: [
    { id: 'uni', name: 'Uni', prompts: ['a plain solid color garment', 'a product photo of a plain garment with no print', 'a minimalist solid colored piece of clothing'] },
    { id: 'gestreift', name: 'Gestreift', prompts: ['a striped garment', 'clothing with horizontal stripes', 'a garment with vertical pinstripes'] },
    { id: 'kariert', name: 'Kariert', prompts: ['a plaid garment', 'a checkered garment', 'a garment with a tartan check pattern', 'a gingham pattern garment'] },
    { id: 'gebluemt', name: 'Geblümt', prompts: ['a floral print garment', 'a garment with a flower pattern'] },
    { id: 'gepunktet', name: 'Gepunktet', prompts: ['a polka dot garment', 'a garment with a dotted pattern'] },
    { id: 'grafik', name: 'Grafik-Print', prompts: ['a garment with a large graphic print', 'a t-shirt with a printed picture on it', 'a garment with an illustration print'] },
    { id: 'schrift', name: 'Schriftzug', prompts: ['a garment with large text lettering', 'a garment with a slogan print', 'a garment with a big word printed on it'] },
    { id: 'logo', name: 'Logo', prompts: ['a garment with a small logo', 'a garment with a small embroidered logo on the chest', 'a plain garment with a small brand logo'] },
    { id: 'camouflage', name: 'Camouflage', prompts: ['a camouflage pattern garment', 'military camo clothing'] },
    { id: 'tierprint', name: 'Animal-Print', prompts: ['a leopard print garment', 'a zebra print garment', 'an animal print garment'] },
    { id: 'gemustert', name: 'Anderes Muster', prompts: ['a garment with an all-over abstract pattern', 'a paisley pattern garment', 'a garment with a geometric pattern'] },
  ],
  style: [
    { id: 'casual', name: 'Casual', prompts: ['casual everyday clothing', 'a basic casual garment', 'relaxed weekend clothing'] },
    { id: 'streetwear', name: 'Streetwear', prompts: ['streetwear clothing', 'an oversized streetwear garment', 'urban hype streetwear'] },
    { id: 'smart', name: 'Smart / Business', prompts: ['smart business clothing', 'elegant formal clothing', 'business casual office clothing'] },
    { id: 'sport', name: 'Sportlich / Outdoor', prompts: ['sportswear', 'athletic workout clothing', 'outdoor functional clothing for hiking'] },
  ],
  warmth: [
    { id: 'sommer', name: 'Sommer', prompts: ['light summer clothing', 'thin breathable clothing for hot weather'] },
    { id: 'uebergang', name: 'Übergang', prompts: ['clothing for spring and autumn', 'a light layer for mild weather'] },
    { id: 'winter', name: 'Winter', prompts: ['warm winter clothing', 'thick warm clothing for cold weather'] },
  ],
};

export const PATTERNS = ATTR_GROUPS.pattern.map(({ id, name }) => ({ id, name }));
export const STYLES = ATTR_GROUPS.style.map(({ id, name }) => ({ id, name }));
export const WARMTH = ATTR_GROUPS.warmth.map(({ id, name }) => ({ id, name }));
export const patternName = (id) => PATTERNS.find((p) => p.id === id)?.name || '';
export const styleName = (id) => STYLES.find((s) => s.id === id)?.name || '';
