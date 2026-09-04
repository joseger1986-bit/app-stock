const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

const supabaseUrl = process.env.APP_STOCK_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey =
  process.env.APP_STOCK_SUPABASE_PUBLISHABLE_KEY ||
  process.env.APP_STOCK_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error(
    "Faltan variables de entorno: APP_STOCK_SUPABASE_URL y APP_STOCK_SUPABASE_PUBLISHABLE_KEY."
  );
  process.exit(1);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const file of ["index.html", "styles.css", "app.js"]) {
  fs.copyFileSync(path.join(root, file), path.join(dist, file));
}

const config = `window.APP_CONFIG = ${JSON.stringify(
  {
    supabaseUrl,
    supabaseAnonKey: supabaseKey
  },
  null,
  2
)};\n`;

fs.writeFileSync(path.join(dist, "config.js"), config, "utf8");

console.log("Build listo en dist/");
