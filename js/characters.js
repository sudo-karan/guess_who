// characters.js
// 30 colourful "Guess Who" characters, rendered procedurally as inline SVG in a
// clean, cohesive cartoon style (unified outline, rounded friendly faces). Every
// character is a unique combination of shared, askable traits — and every trait
// stays clearly visible in the drawing (e.g. sunglasses are translucent).

/* ----------------------------- palettes ----------------------------- */

const SKIN = { light: '#ffd9b3', tan: '#f0b985', brown: '#c98a52', deep: '#8d5524' };

const HAIR = {
  black:  '#2b2b34', brown: '#7a4a24', blonde: '#f4cf5f', red: '#e0562c',
  gray:   '#c9ccd4', blue:  '#3f8ee0', pink:   '#f06fb0', green: '#41ba86',
};

const EYE = { brown: '#6b4327', blue: '#3a7bd5', green: '#31a86c' };

const SHIRT = {
  red: '#e8503a', blue: '#3a8fd4', green: '#2ec27e', purple: '#9b64d6',
  orange: '#ef8c3b', teal: '#18b8a8', pink: '#ff7eb0', yellow: '#f6c445',
};

// Cheerful background tints, chosen per-character index for variety.
const BG = ['#fef1c9', '#dbeafe', '#dcfce7', '#fae8ff', '#ffe1e6', '#e0f2fe', '#eef7c9', '#e8f7f4'];

// One unified outline colour ties every shape together (the "sticker" look).
const LINE = '#48395c';
const OL = (w = 2) => `stroke="${LINE}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;

/* ---------------------------- utilities ----------------------------- */

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.round(r * (1 - amt)); g = Math.round(g * (1 - amt)); b = Math.round(b * (1 - amt));
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/* ------------------------- SVG part builders ------------------------ */

// Hair drawn BEHIND the head (long flow + afro halo).
function hairBack(style, c) {
  const cs = shade(c, 0.16);
  switch (style) {
    case 'long':
      return `<path d="M25,49 C23,23 35,14 50,14 C65,14 77,23 75,49 L75,80 C75,70 69,65 65,65 L65,45
              C65,32 58,28 50,28 C42,28 35,32 35,45 L35,65 C31,65 25,70 25,80 Z" fill="${c}" ${OL()}/>`;
    case 'afro':
      return `<path d="M50,7 C71,7 85,22 85,43 C85,52 80,59 73,61 C76,45 66,33 50,33 C34,33 24,45 27,61
              C20,59 15,52 15,43 C15,22 29,7 50,7 Z" fill="${c}" ${OL()}/>
              <circle cx="33" cy="25" r="5" fill="${cs}" opacity="0.55"/>
              <circle cx="67" cy="25" r="5" fill="${cs}" opacity="0.55"/>`;
    default:
      return '';
  }
}

// Hair drawn IN FRONT (the hairline over the forehead).
function hairFront(style, c) {
  const cap = 'M27,48 C25,24 36,15 50,15 C64,15 75,24 73,48 C68,35 60,31 50,31 C40,31 32,35 27,48 Z';
  const cs = shade(c, 0.15);
  switch (style) {
    case 'bald':
      return '';
    case 'short':
    case 'long':
      return `<path d="${cap}" fill="${c}" ${OL()}/>`;
    case 'curly':
      return `<path d="M26,48 C25,32 29,22 37,20 C41,15 46,21 50,18 C54,21 59,15 63,20 C71,22 75,32 74,48
              C68,37 60,33 50,33 C40,33 32,37 26,48 Z" fill="${c}" ${OL()}/>
              <circle cx="34" cy="25" r="4.5" fill="${cs}"/><circle cx="50" cy="21" r="5" fill="${cs}"/>
              <circle cx="66" cy="25" r="4.5" fill="${cs}"/>`;
    case 'spiky':
      return `<path d="M26,46 L31,20 L38,35 L44,16 L50,31 L56,16 L62,35 L69,20 L74,46
              C68,35 60,31 50,31 C40,31 32,35 26,46 Z" fill="${c}" ${OL()}/>`;
    case 'bun':
      return `<circle cx="50" cy="13" r="8" fill="${c}" ${OL()}/>
              <rect x="45.5" y="18" width="9" height="6" rx="3" fill="${cs}"/>
              <path d="${cap}" fill="${c}" ${OL()}/>`;
    case 'mohawk':
      return `<path d="M43,49 C40,22 46,11 50,11 C54,11 60,22 57,49 Z" fill="${c}" ${OL()}/>
              <path d="M47,21 L50,13 L53,21 Z" fill="${cs}"/>`;
    case 'afro':
      // High hairline strip so the forehead reads as hair, framed by the halo behind.
      return `<path d="M30,44 C30,33 38,30 50,30 C62,30 70,33 70,44 C64,37 58,34 50,34 C42,34 36,37 30,44 Z" fill="${c}"/>`;
    default:
      return '';
  }
}

function eyebrows(c) {
  return `<g stroke="${c}" stroke-width="2.6" stroke-linecap="round" fill="none">
    <path d="M33,41 Q40,37.5 47,41"/><path d="M53,41 Q60,37.5 67,41"/></g>`;
}

function eyes(eyeColor) {
  const e = (cx) => `
    <ellipse cx="${cx}" cy="50" rx="6" ry="6.6" fill="#fff" ${OL(1.4)}/>
    <circle cx="${cx}" cy="51" r="3.9" fill="${eyeColor}"/>
    <circle cx="${cx}" cy="51" r="1.9" fill="#20222c"/>
    <circle cx="${cx - 1.5}" cy="48.4" r="1.3" fill="#fff"/>`;
  return e(40) + e(60);
}

function glasses(kind) {
  if (kind === 'none') return '';
  const fr = '#2f2a3a';
  const arms = `<path d="M26,50 L18,48 M74,50 L82,48" stroke="${fr}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  const bridge = `<line x1="47" y1="50" x2="53" y2="50" stroke="${fr}" stroke-width="2.2"/>`;
  if (kind === 'round') {
    return `<g>${arms}<circle cx="40" cy="50" r="8.6" fill="none" stroke="${fr}" stroke-width="2.4"/>
      <circle cx="60" cy="50" r="8.6" fill="none" stroke="${fr}" stroke-width="2.4"/>${bridge}</g>`;
  }
  if (kind === 'square') {
    return `<g>${arms}<rect x="31" y="42" width="18" height="16" rx="3.5" fill="none" stroke="${fr}" stroke-width="2.4"/>
      <rect x="51" y="42" width="18" height="16" rx="3.5" fill="none" stroke="${fr}" stroke-width="2.4"/>${bridge}</g>`;
  }
  // Sunglasses: tinted but TRANSLUCENT so the eye colour beneath still shows.
  return `<g>${arms}
    <rect x="30" y="43" width="19" height="14" rx="4.5" fill="rgba(38,38,66,0.40)" stroke="${fr}" stroke-width="2"/>
    <rect x="51" y="43" width="19" height="14" rx="4.5" fill="rgba(38,38,66,0.40)" stroke="${fr}" stroke-width="2"/>${bridge}
    <path d="M33,45 l4,0 M55,45 l4,0" stroke="rgba(255,255,255,0.6)" stroke-width="1.5" stroke-linecap="round"/></g>`;
}

function facialHair(kind, c) {
  switch (kind) {
    case 'mustache':
      return `<path d="M41,60 Q50,66 59,60 Q54,64 50,64 Q46,64 41,60 Z" fill="${c}" ${OL(1.2)}/>`;
    case 'beard':
      return `<path d="M27,51 C27,79 40,89 50,89 C60,89 73,79 73,51 C69,68 61,74 50,74
              C39,74 31,68 27,51 Z" fill="${c}" ${OL(1.6)}/>`;
    case 'goatee':
      return `<path d="M41,60 Q50,66 59,60 Q54,64 50,64 Q46,64 41,60 Z" fill="${c}" ${OL(1.2)}/>
              <path d="M45,70 Q50,82 55,70 Q50,74 45,70 Z" fill="${c}" ${OL(1.2)}/>`;
    default:
      return '';
  }
}

function hat(kind) {
  switch (kind) {
    case 'cap':
      return `<path d="M25,32 C25,13 37,7 50,7 C63,7 75,13 75,32 Z" fill="#e8503a" ${OL()}/>
              <path d="M49,32 C70,31 87,32 85,41 C68,36 49,36 49,35 Z" fill="#bd3c2b" ${OL(1.4)}/>
              <circle cx="50" cy="11" r="2.4" fill="#bd3c2b"/>`;
    case 'beanie':
      return `<path d="M24,35 C24,15 37,8 50,8 C63,8 76,15 76,35 Z" fill="#8e63d4" ${OL()}/>
              <rect x="22" y="32" width="56" height="9" rx="4.5" fill="#6f49b0" ${OL(1.4)}/>
              <circle cx="50" cy="6" r="4" fill="#cdb6ef" ${OL(1.2)}/>`;
    case 'tophat':
      return `<rect x="21" y="31" width="58" height="6" rx="3" fill="#2c2c38" ${OL(1.4)}/>
              <rect x="32" y="4" width="36" height="28" rx="4" fill="#2c2c38" ${OL()}/>
              <rect x="32" y="23" width="36" height="6" fill="#e8503a"/>`;
    case 'crown':
      return `<path d="M29,33 L29,15 L38,24 L44,10 L50,21 L56,10 L62,24 L71,15 L71,33 Z" fill="#f4c430" ${OL()}/>
              <circle cx="44" cy="18" r="2.2" fill="#e8503a"/><circle cx="56" cy="18" r="2.2" fill="#3f8ee0"/>
              <circle cx="50" cy="28" r="2" fill="#e8503a"/>`;
    case 'party':
      return `<path d="M50,1 L36,32 L64,32 Z" fill="#18b8a8" ${OL()}/>
              <path d="M42,20 L58,20 M45,26 L55,26" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>
              <circle cx="50" cy="2" r="4" fill="#f4c430" ${OL(1.2)}/>`;
    default:
      return '';
  }
}

function accessoryNeck(kind) {
  switch (kind) {
    case 'bowtie':
      return `<path d="M50,85 L40,80 L40,90 Z" fill="#e8503a" ${OL(1.2)}/>
              <path d="M50,85 L60,80 L60,90 Z" fill="#e8503a" ${OL(1.2)}/>
              <circle cx="50" cy="85" r="3" fill="#bd3c2b"/>`;
    case 'necklace':
      return `<path d="M37,80 Q50,95 63,80" stroke="#f4c430" stroke-width="2.6" fill="none"/>
              <circle cx="50" cy="92" r="3.4" fill="#f4c430" ${OL(1)}/>`;
    case 'scarf':
      return `<path d="M31,81 Q50,91 69,81 L69,91 Q50,99 31,91 Z" fill="#e84393" ${OL(1.4)}/>
              <path d="M61,89 L69,100 L59,98 Z" fill="#c81e78" ${OL(1.2)}/>`;
    default:
      return '';
  }
}

function accessoryFace(kind) {
  switch (kind) {
    case 'earrings':
      return `<circle cx="26" cy="60" r="2.8" fill="#f4c430" ${OL(1)}/><circle cx="74" cy="60" r="2.8" fill="#f4c430" ${OL(1)}/>`;
    case 'freckles':
      return `<g fill="rgba(150,90,55,0.5)">
        <circle cx="34" cy="57" r="1.4"/><circle cx="38" cy="60" r="1.4"/><circle cx="41" cy="56" r="1.3"/>
        <circle cx="59" cy="56" r="1.3"/><circle cx="62" cy="60" r="1.4"/><circle cx="66" cy="57" r="1.4"/>
      </g>`;
    default:
      return '';
  }
}

/* -------------------------- avatar renderer ------------------------- */

export function renderAvatar(ch, index = 0) {
  const skin = SKIN[ch.skin];
  const hair = HAIR[ch.hair];
  const eye = EYE[ch.eye];
  const shirt = SHIRT[ch.shirt];
  const bg = BG[index % BG.length];
  const skinShade = shade(skin, 0.14);

  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" class="avatar" role="img" aria-label="${ch.name}">
    <rect x="0" y="0" width="100" height="100" rx="16" fill="${bg}"/>
    <circle cx="50" cy="46" r="33" fill="rgba(255,255,255,0.42)"/>
    <!-- shoulders + neck -->
    <path d="M16,100 C16,83 30,77 50,77 C70,77 84,83 84,100 Z" fill="${shirt}" ${OL()}/>
    <path d="M16,100 C16,83 30,77 40,77 C33,86 33,94 34,100 Z" fill="${shade(shirt, 0.12)}"/>
    <path d="M43,66 h14 v11 q-7,4.5 -14,0 Z" fill="${skinShade}" ${OL(1.5)}/>
    ${hairBack(ch.style, hair)}
    <!-- ears -->
    <circle cx="26" cy="53" r="5.4" fill="${skin}" ${OL(1.5)}/>
    <circle cx="74" cy="53" r="5.4" fill="${skin}" ${OL(1.5)}/>
    <!-- head -->
    <ellipse cx="50" cy="49" rx="24" ry="26" fill="${skin}" ${OL()}/>
    ${hairFront(ch.style, hair)}
    <!-- cheeks -->
    <circle cx="37" cy="57" r="4.6" fill="#ff8fa3" opacity="0.35"/>
    <circle cx="63" cy="57" r="4.6" fill="#ff8fa3" opacity="0.35"/>
    ${eyebrows(hair)}
    ${eyes(eye)}
    ${glasses(ch.glasses)}
    <path d="M50,53 q-3,6 -0.5,8 q2.5,1.6 5,0" fill="none" stroke="${skinShade}" stroke-width="2" stroke-linecap="round"/>
    <path d="M43,62 Q50,69 57,62" fill="none" stroke="#a83b52" stroke-width="3" stroke-linecap="round"/>
    ${facialHair(ch.beard, hair)}
    ${accessoryFace(ch.acc)}
    ${hat(ch.hat)}
    ${accessoryNeck(ch.acc)}
  </svg>`;
}

/* ------------------------------ roster ------------------------------ */
// A fixed cast of 30 names. Their looks are randomised fresh every game, so no
// two matches share the same faces. Both players use the identical roster: the
// host generates it once and sends it to the guest.

const RAW_NAMES = [
  'shilpa', 'karan', 'asif', 'ritu', 'rekha', 'mohit', 'pradeep', 'Jyoti', 'manoj', 'arabind',
  'mansi', 'brajesh', 'Usha', 'alka', 'prajanya', 'nidhi', 'ayush', 'jamal', 'dilip', 'ruchi',
  'Anjali', 'Richie', 'jannat', 'aafi', 'rudra', 'harshit', 'benisha', 'bhuvik', 'diya', 'baati',
];
export const NAMES = RAW_NAMES.map((n) => n.charAt(0).toUpperCase() + n.slice(1));

// Trait pools. "none" is repeated for glasses/hat/beard/acc so most faces stay
// clean and the standout features feel special — like the classic board.
const POOL = {
  skin:    ['light', 'tan', 'brown', 'deep'],
  hair:    ['black', 'brown', 'blonde', 'red', 'gray', 'blue', 'pink', 'green'],
  style:   ['bald', 'short', 'long', 'curly', 'spiky', 'bun', 'mohawk', 'afro'],
  eye:     ['brown', 'blue', 'green'],
  glasses: ['none', 'none', 'none', 'none', 'round', 'square', 'sun'],
  hat:     ['none', 'none', 'none', 'none', 'cap', 'beanie', 'tophat', 'crown', 'party'],
  beard:   ['none', 'none', 'none', 'none', 'none', 'mustache', 'beard', 'goatee'],
  acc:     ['none', 'none', 'earrings', 'bowtie', 'necklace', 'scarf', 'freckles'],
  shirt:   ['red', 'blue', 'green', 'purple', 'orange', 'teal', 'pink', 'yellow'],
};

// Generate a fresh, random roster. Each character is a unique trait combination
// so no two look identical (which would make deduction impossible).
export function generateRoster() {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const seen = new Set();
  return NAMES.map((name, i) => {
    let ch, key, tries = 0;
    do {
      ch = {
        id: i + 1, name,
        skin: pick(POOL.skin), hair: pick(POOL.hair), style: pick(POOL.style), eye: pick(POOL.eye),
        glasses: pick(POOL.glasses), hat: pick(POOL.hat), beard: pick(POOL.beard),
        acc: pick(POOL.acc), shirt: pick(POOL.shirt),
      };
      key = [ch.skin, ch.hair, ch.style, ch.eye, ch.glasses, ch.hat, ch.beard, ch.acc].join('|');
      tries++;
    } while (seen.has(key) && tries < 40);
    seen.add(key);
    return ch;
  });
}

// Human-readable labels for every trait category + value. Drives the hover
// tooltip and the in-play filter rail. Keys match the character property names.
export const TRAIT_LABELS = {
  hair:    { name: 'Hair colour', values: { black: 'Black', brown: 'Brown', blonde: 'Blonde', red: 'Red', gray: 'Gray', blue: 'Blue', pink: 'Pink', green: 'Green' } },
  style:   { name: 'Hair style',  values: { bald: 'Bald', short: 'Short', long: 'Long', curly: 'Curly', spiky: 'Spiky', bun: 'Bun', mohawk: 'Mohawk', afro: 'Afro' } },
  eye:     { name: 'Eye colour',  values: { brown: 'Brown', blue: 'Blue', green: 'Green' } },
  skin:    { name: 'Skin tone',   values: { light: 'Light', tan: 'Tan', brown: 'Brown', deep: 'Deep' } },
  glasses: { name: 'Glasses',     values: { none: 'None', round: 'Round', square: 'Square', sun: 'Sunglasses' } },
  hat:     { name: 'Headwear',    values: { none: 'None', cap: 'Cap', beanie: 'Beanie', tophat: 'Top hat', crown: 'Crown', party: 'Party hat' } },
  beard:   { name: 'Facial hair', values: { none: 'None', mustache: 'Mustache', beard: 'Beard', goatee: 'Goatee' } },
  acc:     { name: 'Accessory',   values: { none: 'None', earrings: 'Earrings', bowtie: 'Bow tie', necklace: 'Necklace', scarf: 'Scarf', freckles: 'Freckles' } },
};

// A section-by-section breakdown of a character's traits, for hover tooltips.
export function traitRows(ch) {
  const T = TRAIT_LABELS;
  return [
    { label: T.hair.name,    value: T.hair.values[ch.hair] },
    { label: T.style.name,   value: T.style.values[ch.style] },
    { label: T.eye.name,     value: T.eye.values[ch.eye] },
    { label: T.skin.name,    value: T.skin.values[ch.skin] },
    { label: T.glasses.name, value: T.glasses.values[ch.glasses] },
    { label: T.hat.name,     value: T.hat.values[ch.hat] },
    { label: T.beard.name,   value: T.beard.values[ch.beard] },
    { label: T.acc.name,     value: T.acc.values[ch.acc] },
  ];
}
