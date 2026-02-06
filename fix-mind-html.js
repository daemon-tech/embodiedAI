const fs = require('fs');
const p = 'src/renderer/index.html';
let s = fs.readFileSync(p, 'utf8');
const apostrophe = '\u2019';
s = s.replace(
  />Laura's thoughts appear here as she thinks\. You see everything\.</,
  '><strong>No thoughts yet</strong>Thoughts appear here as Laura thinks. Each shows time, action type, and the thought.</'
);
s = s.replace(
  new RegExp('>Laura' + apostrophe + 's thoughts appear here[^<]+<'),
  '><strong>No thoughts yet</strong>Thoughts appear here as Laura thinks. Each shows time, action type, and the thought.</'
);
s = s.replace(
  /<div class="goals-head" style="margin-bottom:8px;">Laura's inner voice — her reasoning<\/div>/,
  '<div class="mind-section-title">Inner voice (reasoning stream)</div>'
);
s = s.replace(
  new RegExp('<div class="goals-head" style="margin-bottom:8px;">Laura' + apostrophe + 's inner voice[^<]+</div>'),
  '<div class="mind-section-title">Inner voice (reasoning stream)</div>'
);
s = s.replace(
  new RegExp('>Laura' + apostrophe + 's inner voice—what she actually thinks—appears here\\. Completely transparent\\.<'),
  '><strong>No inner thoughts yet</strong>Her raw reasoning stream appears here.</'
);
fs.writeFileSync(p, s);
console.log('Done');
