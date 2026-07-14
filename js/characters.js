// characters.js
// 30 colorful "Guess Who" characters, rendered procedurally as inline SVG.
// Every character is a unique combination of shared, askable traits so the
// deduction essence of Guess Who is preserved.

/* ----------------------------- palettes ----------------------------- */

const SKIN = {
  light: '#ffd9b3',
  tan:   '#f0b985',
  brown: '#c98a52',
  deep:  '#8d5524',
};

const HAIR = {
  black:  '#2b2b34',
  brown:  '#6b4423',
  blonde: '#f4d06f',
  red:    '#d9552e',
  gray:   '#c9ccd4',
  blue:   '#3f8ee0',
  pink:   '#f06fb0',
  green:  '#4bb887',
};

const EYE = {
  brown: '#5b3a22',
  blue:  '#3a7bd5',
  green: '#3aa76d',
};

const SHIRT = {
  red:    '#e74c3c',
  blue:   '#3498db',
  green:  '#2ecc71',
  purple: '#9b59b6',
  orange: '#e67e22',
  teal:   '#1abc9c',
  pink:   '#ff7eb9',
  yellow: '#f7c948',
};

// Cheerful background tints, chosen per-character index for variety.
const BG = [
  '#fef3c7', '#dbeafe', '#dcfce7', '#fae8ff',
  '#ffe4e6', '#e0f2fe', '#fef9c3', '#f0fdfa',
];

/* ---------------------------- utilities ----------------------------- */

// Darken a hex colour by `amt` (0..1) for shadows / bands.
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.round(r * (1 - amt));
  g = Math.round(g * (1 - amt));
  b = Math.round(b * (1 - amt));
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/* ------------------------- SVG part builders ------------------------ */

function hairBack(style, c) {
  switch (style) {
    case 'long':
      return `<path d="M20,44 C18,18 33,11 50,11 C67,11 82,18 80,44 L80,76 C80,67 74,63 70,63 L70,44 C70,29 61,25 50,25 C39,25 30,29 30,44 L30,63 C26,63 20,67 20,76 Z" fill="${c}"/>`;
    case 'afro':
      return `<circle cx="50" cy="40" r="35" fill="${c}"/>
              <circle cx="24" cy="34" r="12" fill="${shade(c,0.08)}"/>
              <circle cx="76" cy="34" r="12" fill="${shade(c,0.08)}"/>`;
    default:
      return '';
  }
}

function hairFront(style, c) {
  const dip = `C40,26 30,30 24,45 C22,20 34,14 50,14 C66,14 78,20 76,45 C70,30 60,26 50,26`;
  switch (style) {
    case 'bald':
      return '';
    case 'short':
      return `<path d="M24,45 ${dip} Z" fill="${c}"/>`;
    case 'long':
      return `<path d="M24,45 ${dip} Z" fill="${c}"/>`;
    case 'curly':
      return `<g fill="${c}">
        <circle cx="30" cy="27" r="10"/><circle cx="43" cy="20" r="11"/>
        <circle cx="57" cy="20" r="11"/><circle cx="70" cy="27" r="10"/>
        <circle cx="36" cy="33" r="9"/><circle cx="64" cy="33" r="9"/>
        <path d="M24,42 C24,26 36,22 50,22 C64,22 76,26 76,42 C70,32 60,30 50,30 C40,30 30,32 24,42 Z"/>
      </g>`;
    case 'spiky':
      return `<path d="M24,42 L28,17 L35,33 L41,13 L47,31 L50,11 L53,31 L59,13 L65,33 L72,17 L76,42
              C70,30 60,26 50,26 C40,26 30,30 24,42 Z" fill="${c}"/>`;
    case 'bun':
      return `<circle cx="50" cy="14" r="9" fill="${c}"/>
              <rect x="45" y="20" width="10" height="6" rx="3" fill="${shade(c,0.12)}"/>
              <path d="M24,45 ${dip} Z" fill="${c}"/>`;
    case 'mohawk':
      return `<path d="M43,46 C40,18 46,9 50,9 C54,9 60,18 57,46 Z" fill="${c}"/>
              <path d="M50,9 L45,20 L50,17 L55,20 Z" fill="${shade(c,0.15)}"/>`;
    case 'afro':
      return '';
    default:
      return '';
  }
}

function eyebrows(c) {
  return `<g stroke="${c}" stroke-width="2.4" stroke-linecap="round" fill="none">
    <path d="M32,39 Q39,35 46,39"/><path d="M54,39 Q61,35 68,39"/>
  </g>`;
}

function eyes(eyeColor) {
  const eye = (cx) => `
    <ellipse cx="${cx}" cy="47" rx="6.5" ry="7.5" fill="#fff" stroke="#e2e2ea" stroke-width="0.8"/>
    <circle cx="${cx}" cy="48" r="3.4" fill="${eyeColor}"/>
    <circle cx="${cx}" cy="48" r="1.5" fill="#1a1a22"/>
    <circle cx="${cx - 1.4}" cy="46" r="1" fill="#fff"/>`;
  return eye(39) + eye(61);
}

function glasses(kind) {
  if (kind === 'none') return '';
  const arms = `<path d="M25,47 L15,44 M75,47 L85,44" stroke="#3a3a44" stroke-width="2" fill="none"/>`;
  const bridge = `<line x1="46" y1="47" x2="54" y2="47" stroke="#3a3a44" stroke-width="2.2"/>`;
  if (kind === 'round') {
    return `<g>${arms}<circle cx="39" cy="47" r="9" fill="none" stroke="#3a3a44" stroke-width="2.4"/>
      <circle cx="61" cy="47" r="9" fill="none" stroke="#3a3a44" stroke-width="2.4"/>${bridge}</g>`;
  }
  if (kind === 'square') {
    return `<g>${arms}<rect x="30" y="39" width="18" height="16" rx="3" fill="none" stroke="#3a3a44" stroke-width="2.4"/>
      <rect x="52" y="39" width="18" height="16" rx="3" fill="none" stroke="#3a3a44" stroke-width="2.4"/>${bridge}</g>`;
  }
  // sunglasses
  return `<g>${arms}<rect x="29" y="40" width="19" height="14" rx="4" fill="#2b2b33"/>
    <rect x="52" y="40" width="19" height="14" rx="4" fill="#2b2b33"/>
    <line x1="48" y1="43" x2="52" y2="43" stroke="#2b2b33" stroke-width="3"/>
    <path d="M32,43 l5,0 M55,43 l5,0" stroke="#5a5a6a" stroke-width="1.6" stroke-linecap="round"/></g>`;
}

function facialHair(kind, c) {
  switch (kind) {
    case 'mustache':
      return `<path d="M41,59 Q50,65 59,59 Q54,63 50,63 Q46,63 41,59 Z" fill="${c}"/>`;
    case 'beard':
      return `<path d="M25,49 C25,80 39,90 50,90 C61,90 75,80 75,49
              C71,67 62,73 50,73 C38,73 29,67 25,49 Z" fill="${c}"/>`;
    case 'goatee':
      return `<path d="M41,59 Q50,65 59,59 Q54,63 50,63 Q46,63 41,59 Z" fill="${c}"/>
              <path d="M44,69 Q50,82 56,69 Q50,74 44,69 Z" fill="${c}"/>`;
    default:
      return '';
  }
}

function hat(kind) {
  switch (kind) {
    case 'cap':
      return `<path d="M24,31 C24,13 37,8 50,8 C63,8 76,13 76,31 Z" fill="#e74c3c"/>
              <path d="M50,31 Q88,31 86,39 Q66,34 50,34 Z" fill="#c0392b"/>
              <circle cx="50" cy="12" r="2.4" fill="#c0392b"/>`;
    case 'beanie':
      return `<path d="M23,35 C23,14 37,8 50,8 C63,8 77,14 77,35 Z" fill="#8e44ad"/>
              <rect x="21" y="32" width="58" height="8" rx="4" fill="#6c3483"/>
              <circle cx="50" cy="7" r="4" fill="#d2b4de"/>`;
    case 'tophat':
      return `<rect x="21" y="29" width="58" height="6" rx="3" fill="#2c2c34"/>
              <rect x="32" y="3" width="36" height="28" rx="3" fill="#2c2c34"/>
              <rect x="32" y="22" width="36" height="6" fill="#c0392b"/>`;
    case 'crown':
      return `<path d="M29,32 L29,15 L38,24 L44,10 L50,21 L56,10 L62,24 L71,15 L71,32 Z"
              fill="#f4c430" stroke="#d4a017" stroke-width="1.4"/>
              <circle cx="44" cy="17" r="2" fill="#e74c3c"/>
              <circle cx="56" cy="17" r="2" fill="#3498db"/>`;
    case 'party':
      return `<path d="M50,1 L37,31 L63,31 Z" fill="#1abc9c"/>
              <path d="M50,1 L44,15 M50,1 L56,15" stroke="#fff" stroke-width="2"/>
              <circle cx="50" cy="1" r="4" fill="#f7c948"/>`;
    default:
      return '';
  }
}

function accessoryNeck(kind) {
  switch (kind) {
    case 'bowtie':
      return `<path d="M50,85 L40,80 L40,90 Z" fill="#e74c3c"/>
              <path d="M50,85 L60,80 L60,90 Z" fill="#e74c3c"/>
              <circle cx="50" cy="85" r="3" fill="#c0392b"/>`;
    case 'necklace':
      return `<path d="M37,80 Q50,95 63,80" stroke="#f4c430" stroke-width="2.6" fill="none"/>
              <circle cx="50" cy="92" r="3.2" fill="#f4c430"/>`;
    case 'scarf':
      return `<path d="M30,80 Q50,90 70,80 L70,90 Q50,99 30,90 Z" fill="#e84393"/>
              <path d="M62,88 L70,100 L60,98 Z" fill="#c81e78"/>`;
    default:
      return '';
  }
}

function accessoryFace(kind) {
  switch (kind) {
    case 'earrings':
      return `<circle cx="23" cy="58" r="3" fill="#f4c430"/><circle cx="77" cy="58" r="3" fill="#f4c430"/>`;
    case 'freckles':
      return `<g fill="rgba(180,110,70,0.55)">
        <circle cx="34" cy="55" r="1.4"/><circle cx="38" cy="58" r="1.4"/><circle cx="41" cy="54" r="1.3"/>
        <circle cx="59" cy="54" r="1.3"/><circle cx="62" cy="58" r="1.4"/><circle cx="66" cy="55" r="1.4"/>
      </g>`;
    default:
      return '';
  }
}

/* -------------------------- avatar renderer ------------------------- */

// Build a full inline SVG string for a character.
export function renderAvatar(ch, index = 0) {
  const skin = SKIN[ch.skin];
  const hair = HAIR[ch.hair];
  const eye = EYE[ch.eye];
  const shirt = SHIRT[ch.shirt];
  const bg = BG[index % BG.length];
  const skinShade = shade(skin, 0.12);

  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" class="avatar" role="img" aria-label="${ch.name}">
    <rect x="0" y="0" width="100" height="100" rx="14" fill="${bg}"/>
    <circle cx="50" cy="40" r="30" fill="rgba(255,255,255,0.35)"/>
    <path d="M15,100 Q15,82 34,79 L66,79 Q85,82 85,100 Z" fill="${shirt}"/>
    <path d="M15,100 Q15,82 34,79 L40,79 Q34,90 34,100 Z" fill="${shade(shirt,0.12)}"/>
    <rect x="43" y="70" width="14" height="15" rx="6" fill="${skinShade}"/>
    ${hairBack(ch.style, hair)}
    <circle cx="24" cy="52" r="6" fill="${skin}"/>
    <circle cx="76" cy="52" r="6" fill="${skin}"/>
    <ellipse cx="50" cy="48" rx="26" ry="29" fill="${skin}"/>
    <ellipse cx="50" cy="48" rx="26" ry="29" fill="none" stroke="${skinShade}" stroke-width="0.8"/>
    ${hairFront(ch.style, hair)}
    ${eyebrows(hair)}
    ${eyes(eye)}
    ${glasses(ch.glasses)}
    <path d="M50,50 q-4,7 -1,10 q3,2 6,0" fill="none" stroke="${skinShade}" stroke-width="2" stroke-linecap="round"/>
    ${facialHair(ch.beard, hair)}
    <path d="M42,63 Q50,71 58,63" stroke="#b23a48" stroke-width="3" fill="none" stroke-linecap="round"/>
    ${accessoryFace(ch.acc)}
    ${hat(ch.hat)}
    ${accessoryNeck(ch.acc)}
  </svg>`;
}

/* ------------------------------ roster ------------------------------ */
// Each character: unique visual combination of askable traits.

export const CHARACTERS = [
  { id: 1,  name: 'Bella',   skin: 'light', hair: 'blonde', style: 'long',   eye: 'blue',  glasses: 'none',   hat: 'none',   beard: 'none',     acc: 'earrings', shirt: 'pink' },
  { id: 2,  name: 'Marcus',  skin: 'brown', hair: 'black',  style: 'short',  eye: 'brown', glasses: 'square', hat: 'none',   beard: 'beard',    acc: 'none',     shirt: 'blue' },
  { id: 3,  name: 'Zara',    skin: 'tan',   hair: 'pink',   style: 'bun',    eye: 'green', glasses: 'none',   hat: 'none',   beard: 'none',     acc: 'necklace', shirt: 'purple' },
  { id: 4,  name: 'Leo',     skin: 'light', hair: 'brown',  style: 'spiky',  eye: 'brown', glasses: 'none',   hat: 'cap',    beard: 'none',     acc: 'none',     shirt: 'green' },
  { id: 5,  name: 'Nina',    skin: 'deep',  hair: 'black',  style: 'curly',  eye: 'brown', glasses: 'round',  hat: 'none',   beard: 'none',     acc: 'earrings', shirt: 'teal' },
  { id: 6,  name: 'Oscar',   skin: 'tan',   hair: 'red',    style: 'short',  eye: 'blue',  glasses: 'none',   hat: 'none',   beard: 'mustache', acc: 'bowtie',   shirt: 'yellow' },
  { id: 7,  name: 'Priya',   skin: 'brown', hair: 'black',  style: 'long',   eye: 'brown', glasses: 'none',   hat: 'none',   beard: 'none',     acc: 'scarf',    shirt: 'orange' },
  { id: 8,  name: 'Finn',    skin: 'light', hair: 'blonde', style: 'mohawk', eye: 'green', glasses: 'none',   hat: 'none',   beard: 'none',     acc: 'none',     shirt: 'red' },
  { id: 9,  name: 'Ruby',    skin: 'light', hair: 'red',    style: 'curly',  eye: 'green', glasses: 'round',  hat: 'none',   beard: 'none',     acc: 'freckles', shirt: 'pink' },
  { id: 10, name: 'Kwame',   skin: 'deep',  hair: 'black',  style: 'bald',   eye: 'brown', glasses: 'none',   hat: 'none',   beard: 'beard',    acc: 'none',     shirt: 'blue' },
  { id: 11, name: 'Ivy',     skin: 'tan',   hair: 'green',  style: 'long',   eye: 'blue',  glasses: 'square', hat: 'none',   beard: 'none',     acc: 'necklace', shirt: 'green' },
  { id: 12, name: 'Sam',     skin: 'light', hair: 'brown',  style: 'short',  eye: 'brown', glasses: 'none',   hat: 'beanie', beard: 'goatee',   acc: 'none',     shirt: 'purple' },
  { id: 13, name: 'Tara',    skin: 'brown', hair: 'black',  style: 'afro',   eye: 'brown', glasses: 'none',   hat: 'none',   beard: 'none',     acc: 'earrings', shirt: 'yellow' },
  { id: 14, name: 'Hugo',    skin: 'tan',   hair: 'gray',   style: 'short',  eye: 'blue',  glasses: 'round',  hat: 'none',   beard: 'mustache', acc: 'bowtie',   shirt: 'teal' },
  { id: 15, name: 'Lola',    skin: 'light', hair: 'pink',   style: 'long',   eye: 'green', glasses: 'sun',    hat: 'none',   beard: 'none',     acc: 'none',     shirt: 'pink' },
  { id: 16, name: 'Deshawn', skin: 'deep',  hair: 'black',  style: 'spiky',  eye: 'brown', glasses: 'none',   hat: 'cap',    beard: 'none',     acc: 'none',     shirt: 'orange' },
  { id: 17, name: 'Mei',     skin: 'light', hair: 'black',  style: 'bun',    eye: 'brown', glasses: 'none',   hat: 'none',   beard: 'none',     acc: 'necklace', shirt: 'red' },
  { id: 18, name: 'Gus',     skin: 'tan',   hair: 'brown',  style: 'bald',   eye: 'green', glasses: 'square', hat: 'none',   beard: 'beard',    acc: 'none',     shirt: 'blue' },
  { id: 19, name: 'Amara',   skin: 'brown', hair: 'blue',   style: 'curly',  eye: 'brown', glasses: 'none',   hat: 'none',   beard: 'none',     acc: 'freckles', shirt: 'teal' },
  { id: 20, name: 'Theo',    skin: 'light', hair: 'blonde', style: 'short',  eye: 'blue',  glasses: 'none',   hat: 'tophat', beard: 'mustache', acc: 'bowtie',   shirt: 'purple' },
  { id: 21, name: 'Freya',   skin: 'light', hair: 'gray',   style: 'long',   eye: 'blue',  glasses: 'none',   hat: 'none',   beard: 'none',     acc: 'scarf',    shirt: 'green' },
  { id: 22, name: 'Jamal',   skin: 'deep',  hair: 'black',  style: 'short',  eye: 'brown', glasses: 'sun',    hat: 'none',   beard: 'goatee',   acc: 'none',     shirt: 'yellow' },
  { id: 23, name: 'Cleo',    skin: 'tan',   hair: 'pink',   style: 'afro',   eye: 'green', glasses: 'none',   hat: 'none',   beard: 'none',     acc: 'earrings', shirt: 'pink' },
  { id: 24, name: 'Rex',     skin: 'light', hair: 'red',    style: 'spiky',  eye: 'brown', glasses: 'none',   hat: 'none',   beard: 'beard',    acc: 'none',     shirt: 'red' },
  { id: 25, name: 'Suki',    skin: 'light', hair: 'blue',   style: 'bun',    eye: 'brown', glasses: 'round',  hat: 'none',   beard: 'none',     acc: 'necklace', shirt: 'teal' },
  { id: 26, name: 'Bruno',   skin: 'tan',   hair: 'brown',  style: 'curly',  eye: 'brown', glasses: 'none',   hat: 'beanie', beard: 'mustache', acc: 'none',     shirt: 'orange' },
  { id: 27, name: 'Elsa',    skin: 'light', hair: 'blonde', style: 'long',   eye: 'blue',  glasses: 'none',   hat: 'crown',  beard: 'none',     acc: 'none',     shirt: 'blue' },
  { id: 28, name: 'Nico',    skin: 'brown', hair: 'black',  style: 'short',  eye: 'green', glasses: 'square', hat: 'none',   beard: 'none',     acc: 'bowtie',   shirt: 'purple' },
  { id: 29, name: 'Willow',  skin: 'light', hair: 'green',  style: 'long',   eye: 'green', glasses: 'none',   hat: 'none',   beard: 'none',     acc: 'freckles', shirt: 'green' },
  { id: 30, name: 'Pip',     skin: 'light', hair: 'brown',  style: 'short',  eye: 'brown', glasses: 'none',   hat: 'party',  beard: 'none',     acc: 'none',     shirt: 'yellow' },
];

// Human-readable labels for the trait legend shown during play.
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

export const CHAR_BY_ID = Object.fromEntries(CHARACTERS.map((c) => [c.id, c]));

// A short human-readable summary of a character's traits, for hover tooltips.
export function describeTraits(ch) {
  const T = TRAIT_LABELS;
  const parts = [];
  parts.push(ch.style === 'bald' ? 'Bald' : `${T.hair.values[ch.hair]} ${T.style.values[ch.style].toLowerCase()} hair`);
  parts.push(`${T.eye.values[ch.eye]} eyes`);
  parts.push(`${T.skin.values[ch.skin]} skin`);
  if (ch.glasses !== 'none') parts.push(`${T.glasses.values[ch.glasses]} glasses`);
  if (ch.hat !== 'none') parts.push(T.hat.values[ch.hat]);
  if (ch.beard !== 'none') parts.push(T.beard.values[ch.beard]);
  if (ch.acc !== 'none') parts.push(T.acc.values[ch.acc]);
  return parts.join(' · ');
}
