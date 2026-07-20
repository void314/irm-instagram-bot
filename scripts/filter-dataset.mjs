import { readdirSync, readFileSync, mkdirSync, copyFileSync, existsSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';

const SRC = resolve('C:/Users/artie/Desktop/irm-assistant-ai-v2/dataset');
const DST = resolve('C:/Users/artie/Desktop/irm-instagram-bot/dataset');

function classify(filename, content) {
  const name = filename.toLowerCase();
  const firstLine = content.split('\n')[0]?.toLowerCase() || '';

  // Extract Type from frontmatter (**Type:** in bold markdown)
  const typeMatch = content.match(/\*\*Type:\*\*\s*(.+)$/m);
  const type = typeMatch ? typeMatch[1].trim().toLowerCase() : '';

  // --- EXCLUSION RULES ---

  // Price/promotion/internal content
  if (type === 'price' || type === 'vacancy') return 'exclude';

  // File naming patterns for exclusion
  const excludePatterns = [
    /^aktsiya/i, /^aktsii/i,                    // promotions
    /^raspisanie/i,                               // schedules
    /^price/i, /^prajse/i, /^tseny/i,             // prices
    /^izmenenie-tsen/i, /^izmeneniya-v-prajse/i,  // price changes
    /^povyshenie-tsen/i,                          // price increases
    /^s-1-/, /^s-5-/, /^s-6-/, /^s-14-/, /^s-15-/, /^s-16-/, /^s-28-/, // date announcements
    /^vakansii/i, /^rekvizity/i,                  // internal
    /^pravila-vnutrennego/i,                      // internal rules
    /^prikaz/i,                                   // orders
    /^dopolnitelnye-kvoty/i,                      // quotas
    /^gosudarstvennye-zakupki/i,                  // gov procurement
    /^raspredelenie-kvot/i,                       // quota distribution
    /^provedenie-programm/i, /^provedenie-eko/i,  // program announcements
    /^priem-s-1/i, /^priem-novogo/i,              // new doctor intake announcements (not profiles)
    /^kvoty/i, /^kvotnye/i,                       // quotas
    /^otbor-patsientov/i,                         // patient selection
    /^onlajn-otbor/i,                             // online selection
    /^nabiraem/i,                                 // recruitment
    /^uvazhaemye-patsienty/i,                     // patient notices
    /^uvazhaemye-kollegi/i,                       // colleague notices
    /^vnimaniyu/i,                                // attention notices
    /^soblyudenie-mer/i,                          // safety measures
    /^profilaktika-koronavirusa/i,                // covid
    /^o-situatsii-s-tsenami/i,                    // price situation
    /^vnedrenie/i,                                // implementation notices
    /^perehod-na/i,                               // transition notices
    /^sm?ena-nomera/i,                            // number change
    /^prikaz-po/i,                                // orders
    /^zabota-o-vas/i,                             // care notices
    /^spravki/i, /^vydacha-spravok/i,            // certificates
    /^marshruty/i,                                // transport routes
    /^prozhivanie/i,                              // accommodation
    /^sluzhba-podderzhki/i,                       // support service
    /^inogorodnim/i,                              // non-residents
    /^otdel-kontroliya/i,                         // quality control dept
    /^konsultirovanie-v/i,                        // consultation announcement in city
    /^besplatnye/i, /^besplatnaya/i, /^besplatnoe/i, // free events
    /^11-fevralya/i, /^12-/, /^13-/, /^14-/, /^15-/, /^16-/, /^17-/, /^18-/, /^19-/,
    /^20-/, /^21-/, /^22-/, /^23-/, /^24-/, /^25-/, /^26-/, /^27-/, /^28-/, /^29-/, /^30-/,
    /^31-/, /^1-/, /^2-/, /^3-/, /^4-/, /^5-/, /^6-/, /^7-/, /^8-/, /^9-/,
    /^10-/, /^11-/,
    /^\d+-/,
    /^letnyaya-aktsiya/i,
    /^vesennyaya-aktsiya/i,
    /^prazdnichnaya-aktsiya/i,
    /^aktsiya-v-chest/i,
    /^aktsiya-ko-dnyu/i,
    /^aktsiya-s-1/i,
    /^novogodnie-treningi/i,
    /^prednovogodnie/i, /^prednovogodnyaya/i,
    /^treningi-v-mae/i,
    /^osennij-marafon/i,
    /^schastlivyj-noyabr/i,
    /^den-rozhdeniya/i,
    /^pozdravlyaem/i,
    /^s-dnem/i, /^s-mezhdunarodnim/i, /^s-nastupayushhim/i,
    /^vypusk/i,
    /^v-irm-projdet/i,
    /^obuchayushhie-tsikly/i,
    /^tematika-tsiklov/i,
    /^sovershenstvuem/i,
    /^konkurs/i,
    /^seminar-ot/i,
    /^fotootchet/i,
    /^videozapisi/i,
    /^webinars/i,
    /^anons/i,
    /^nauryzdy/i, /^nauryz-ajynda/i,
    /^t-uelsizdik/i,
    /^r-t-ysh-prezidenti/i,
    /^muzykalnyj-podarok/i,
    /^podarochnye-sertifikaty/i,
    /^novaya-usluga/i,
    /^novoe-naznachenie/i,
    /^novoe-raspisanie/i,
    /^vozobnovlenie-zanyatij/i,
    /^s-1-aprelya/i, /^s-1-fevralya/i, /^s-1-iyulya/i, /^s-1-marta/i, /^s-1-sentyabrya/i,
    /^vozobnovlenie-zanyatij/i,
    /^vstrecha-s-direktorom/i,
    /^eti[ck]heskij-kodeks/i, /^etikaly-kodeks/i,
    /^kompaniyany-filosofiyasy/i,
    /^rmi-kompaniyasyny-sayasaty/i,
    /^rmi-ishyndegy/i, /^rmetti-shymkent/i,
    /^rmi-diagnostic/i, /^rmi-diagnostikalyk/i,
    /^missiyamyz/i, /^mission-and-goals/i,
    /^tematika-tsiklov/i,
    /^v-irm-projdet/i,
    /^m-lik/i,
    /^memlekettik-tapsyrys/i,
    /^ma-ystau-oblsyny/i,
    /^\d{4,6}/,                              // numeric-only filenames (IDs)
    /^\d+-2\.md$/,                            // duplicate numbered files
    /-za-\d+-tenge/,                          // price in filename
    /aktsiyu$/, /aktsiya-v-chest/, /aktsiya-ko-dnyu/, /aktsiya-s-/, /aktsii-v-/,
    /prazdnichnaya-aktsiya/, /letnyaya-aktsiya/, /vesennyaya-aktsiya/,
    /s-dnem-/, /s-mezhdunarodnim/, /s-nastupayushhim/,
    /godovoj-otchet/,                           // annual reports
    /glavnaya-2/,                               // duplicate main pages
    /izyameneniya-po-vyplatam/,                 // donor payment changes
    /master-klass-na-temu-pessarii/,            // pessary workshop events
    /konsultirovanie-po-voprosam-besplodiya-v-g/,  // free consultation events
    /tegin-ke-es/,                              // free consultation (kazakh)
    /besplatnoe-konsultirovanie-v-g/,           // free consultation in city
    /skemen-alasynda/,                          // consultation event (kazakh)
    /vhod-v-kliniku/,                           // entrance info
    /zony-dostupa/,                             // wi-fi zones
    /s-zabotoj-o-vas/,                          // marketing post
    /pochemu-trogatelno/,                       // odd content
    /vesennyaya-fotosessiya/,                   // photoshoot
    /zimnee-volshebstvo/,                       // winter magic event
    /vizit-vek-naar/,                           // company visit
    /priem-novyh-spetsialistov/,                // new specialist intake
    /pervichnyj-priem-reproduktologa/,          // initial consultation promotion
    /uvelichenie-kolichestva-kvot/,             // quota increase
    /eko-v-estestvennom-tsikle-\d/,             // IVF in natural cycle with price
    /^den-edinstva/,                             // Unity day greeting
    /^sila-v-edinstve/,                          // political solidarity post
    /^pozdravlyaem-s/,                           // congratulations
    /^klinika-irm-pozdravlyaet/,                 // clinic congratulations
  ];

  for (const p of excludePatterns) {
    if (p.test(name)) return 'exclude';
  }

  // --- INCLUSION RULES ---

  // Doctor profiles
  if (type === 'doctors') return 'keep';

  // Journal issues
  if (type === 'journal') return 'keep';

  // Knowledge base / services / pages
  if (type === 'services') return 'keep';
  if (type === 'page') return 'keep';

  // Gallery, contacts, etc.
  if (type === 'contacts') return 'keep';
  if (type === 'gallery') return 'keep';

  // Check for knowledge content by first line
  const keepTitlePatterns = [
    /^#\s*(эко|экстракорпоральное|ирм|бесплодие|эндометриоз|миома|андрология|урология|гинекология|диагностика|лапароскопия|гистероскопия|донорство|суррогатное|сперма|яйцеклетк|эмбрион|генетик|инсеминация|беременность|менопауза|криобанк|витрификация|репродуктив|вспомогательн|преимплантацион|пгд|икси|пекси|имси|зимот|хетчинг|фаллопротезир|интимн|маммологи|эндокринологи|проктологи|анатом|фимоз|циркумцизи|госпитализац|биопси|онкофертильность|донорств)/i,
  ];

  for (const p of keepTitlePatterns) {
    if (p.test(firstLine)) return 'keep';
  }

  // Doctor names (cyrillic surname + name + patronymic pattern) 
  const doctorNamePattern = /^#[А-Я][а-я]+\s+[А-Я][а-я]+(?:\s+[А-Я][а-я]+)?/;
  if (doctorNamePattern.test(firstLine)) return 'keep';

  // IRM clinic name
  const clinicPattern = /^#\s*(ирм|irm|институт репродуктивной|о нас|контакты|вакан|отделение|история|миссия|аккредитац)/i;
  if (clinicPattern.test(firstLine)) return 'keep';

  // Default: exclude if it looks like a date-based event announcement
  if (/^\d{1,2}\s/.test(name)) return 'exclude';

  // If type was not matched and no exclusion caught it, keep by default
  return 'keep';
}

// Main
const files = readdirSync(SRC).filter(f => f.endsWith('.md'));

const classified = { keep: [], exclude: [] };
const typeStats = {};

for (const f of files) {
  const fullPath = join(SRC, f);
  const content = readFileSync(fullPath, 'utf-8');
  const result = classify(f, content);
  classified[result].push(f);

  const typeMatch = content.match(/\*\*Type:\*\*\s*(.+)$/m);
  const type = typeMatch ? typeMatch[1].trim().toLowerCase() : 'unknown';
  typeStats[type] = (typeStats[type] || 0) + 1;
}

// Print stats
console.log('=== Type Distribution ===');
const sorted = Object.entries(typeStats).sort((a, b) => b[1] - a[1]);
for (const [t, c] of sorted) {
  console.log(`  ${t}: ${c}`);
}

console.log(`\n=== Classification ===`);
console.log(`  Keep: ${classified.keep.length}`);
console.log(`  Exclude: ${classified.exclude.length}`);

// Clean output directory
if (existsSync(DST)) {
  const existing = readdirSync(DST).filter(f => f.endsWith('.md'));
  for (const f of existing) rmSync(join(DST, f));
} else {
  mkdirSync(DST, { recursive: true });
}

// Copy kept files
let copied = 0;
for (const f of classified.keep) {
  const src = join(SRC, f);
  const dst = join(DST, f);
  copyFileSync(src, dst);
  copied++;
}
console.log(`\nCopied ${copied} files to ${DST}`);

// Write summary log
const summaryPath = join(DST, '_summary.txt');
const summary = [
  `Total source files: ${files.length}`,
  `Kept: ${classified.keep.length}`,
  `Excluded: ${classified.exclude.length}`,
  ``,
  `=== Excluded files ===`,
  ...classified.exclude.sort(),
  ``,
  `=== Kept files ===`,
  ...classified.keep.sort(),
].join('\n');
writeFileSync(summaryPath, summary, 'utf-8');
console.log(`Summary written to ${summaryPath}`);
