#!/usr/bin/env node
import fs from 'node:fs';
import { addListing, addMany, checkAll, load, removeListing } from './src/store.js';
import { updateVca } from './src/wltp.js';

const [cmd, ...args] = process.argv.slice(2);
const fmt = (n) => (n == null ? '?' : n.toLocaleString('pl-PL'));

const commands = {
  async add() {
    if (!args.length) throw new Error('Użycie: node cli.js add <link> [link...]  albo  add --file linki.txt');
    let inputs = args;
    if (args[0] === '--file') inputs = fs.readFileSync(args[1], 'utf8').split(/\s+/).filter(Boolean);
    if (inputs.length === 1) {
      const { entry, existed } = await addListing(inputs[0]);
      console.log(existed ? `Już obserwowane: ${entry.title}` : `Dodano: ${entry.title} — ${fmt(entry.history.at(-1)?.price)} ${entry.currency}`);
    } else {
      const r = await addMany(inputs, console.log);
      console.log(`Dodano ${r.added.length}, pominięto ${r.skipped.length}, błędy ${r.failed.length}`);
    }
  },

  async remove() {
    console.log(removeListing(args[0]) ? 'Usunięto.' : 'Nie ma takiego ogłoszenia (podaj klucz z `list`).');
  },

  async list() {
    const items = Object.values(load().listings);
    if (!items.length) return console.log('Brak obserwowanych ogłoszeń. Dodaj: node cli.js add <link>');
    for (const e of items) {
      const first = e.history[0]?.price, last = e.history.at(-1)?.price;
      const diff = first != null && last != null ? last - first : 0;
      const d = diff ? ` (${diff > 0 ? '+' : ''}${fmt(diff)})` : '';
      console.log(`${e.key.padEnd(10)} ${fmt(last).padStart(10)} ${e.currency ?? ''}${d}  ${e.status === 'ACTIVE' ? '' : `[${e.status}] `}${e.title}`);
    }
  },

  async wltp() {
    console.log('Pobieram oficjalne dane WLTP z VCA…');
    console.log(`Zapisano ${await updateVca()} wersji aut elektrycznych.`);
  },

  async check() {
    const changes = await checkAll(console.log);
    console.log(changes.length ? `\nZmiany cen: ${changes.length}` : '\nBrak zmian cen.');
  },
};

if (!commands[cmd]) {
  console.log(`Otomoto tracker
  node cli.js add <link> [link...]   dodaj ogłoszenie(a)
  node cli.js add --file linki.txt   dodaj linki z pliku (jeden na linię)
  node cli.js list                   pokaż obserwowane
  node cli.js check                  sprawdź aktualne ceny
  node cli.js remove <klucz>         przestań obserwować
  node cli.js wltp                   pobierz oficjalne dane WLTP (VCA)
  node server.js                     panel z wykresami: http://localhost:3000`);
  process.exit(cmd ? 1 : 0);
}

commands[cmd]().catch((e) => {
  console.error(e.message);
  process.exitCode = 1; // nie process.exit() — na Windows wywala asercję libuv przy otwartych połączeniach fetch
});
