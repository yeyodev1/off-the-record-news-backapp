/**
 * Carga las fuentes de la mesa de redacción. Idempotente: hace upsert por nombre.
 * Cada feed RSS se prueba en vivo; el que no responde con un feed válido queda
 * inactivo con el error anotado, para no gastar tiempo del ciclo en él.
 * Uso: pnpm seed:sources
 */
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env";
import { Source, SourceCategory } from "../models/source.model";
import { fetchFeed } from "../services/rss.service";

interface Seed {
  name: string;
  kind: "rss" | "perplexity";
  category: SourceCategory;
  url?: string;
  query?: string;
  weight: number;
}

// Feeds verificados con curl (responden XML RSS válido). Las categorías de El
// Universo responden XML pero vacío. Primicias, Ecuavisa,
// Teleamazonas, GK, La Hora, Vistazo, El Telégrafo y Edición Médica no exponen
// un feed accesible (404/403 o HTML); se cubren con consultas de Perplexity.
const SOURCES: Seed[] = [
  {
    name: "El Universo",
    kind: "rss",
    category: "medio",
    url: "https://www.eluniverso.com/arc/outboundfeeds/rss/?outputType=xml",
    weight: 1.3,
  },
  {
    name: "Expreso",
    kind: "rss",
    category: "medio",
    url: "https://www.expreso.ec/rss",
    weight: 1.2,
  },
  {
    name: "El Comercio",
    kind: "rss",
    category: "medio",
    url: "https://www.elcomercio.com/feed/",
    weight: 1.2,
  },
  { name: "Extra", kind: "rss", category: "medio", url: "https://www.extra.ec/rss", weight: 0.7 },
  {
    name: "Plan V",
    kind: "rss",
    category: "medio",
    url: "https://www.planv.com.ec/feed/",
    weight: 1.2,
  },
  {
    name: "Metro Ecuador",
    kind: "rss",
    category: "medio",
    url: "https://www.metroecuador.com.ec/arc/outboundfeeds/rss/?outputType=xml",
    weight: 0.9,
  },
  {
    name: "Radio Pichincha",
    kind: "rss",
    category: "medio",
    url: "https://www.radiopichincha.com/feed/",
    weight: 1,
  },
  {
    name: "La República",
    kind: "rss",
    category: "medio",
    url: "https://www.larepublica.ec/feed/",
    weight: 0.9,
  },
  {
    name: "El Diario Manabí",
    kind: "rss",
    category: "medio",
    url: "https://www.eldiario.ec/feed/",
    weight: 0.8,
  },
  {
    name: "El Norte",
    kind: "rss",
    category: "medio",
    url: "https://www.elnorte.ec/feed/",
    weight: 0.7,
  },
  {
    name: "Últimas Noticias",
    kind: "rss",
    category: "medio",
    url: "https://www.ultimasnoticias.ec/feed/",
    weight: 0.7,
  },
  {
    name: "Ecuador Chequea",
    kind: "rss",
    category: "medio",
    url: "https://www.ecuadorchequea.com/feed/",
    weight: 1,
  },
  {
    name: "Asamblea Nacional",
    kind: "rss",
    category: "institucion",
    url: "https://www.asambleanacional.gob.ec/es/rss.xml",
    weight: 1.2,
  },

  {
    name: "Perplexity · Asamblea Nacional",
    kind: "perplexity",
    category: "institucion",
    query: "Asamblea Nacional Ecuador hoy: votaciones, leyes, juicios políticos",
    weight: 1.3,
  },
  {
    name: "Perplexity · Presidencia",
    kind: "perplexity",
    category: "politico",
    query: "Presidencia de Ecuador Daniel Noboa anuncios y decretos",
    weight: 1.4,
  },
  {
    name: "Perplexity · Economía",
    kind: "perplexity",
    category: "institucion",
    query: "economía Ecuador riesgo país, deuda, FMI, precios de combustibles",
    weight: 1.3,
  },
  {
    name: "Perplexity · Seguridad",
    kind: "perplexity",
    category: "institucion",
    query: "seguridad Ecuador Guayaquil violencia, operativos y estado de excepción",
    weight: 1.1,
  },
  {
    name: "Perplexity · Corte Constitucional",
    kind: "perplexity",
    category: "institucion",
    query: "Corte Constitucional Ecuador fallos y dictámenes",
    weight: 1.2,
  },
  {
    name: "Perplexity · CNE",
    kind: "perplexity",
    category: "institucion",
    query: "CNE Ecuador elecciones seccionales 2027 calendario y candidatos",
    weight: 1.1,
  },
  {
    name: "Perplexity · Primicias",
    kind: "perplexity",
    category: "medio",
    query: "noticias de Primicias Ecuador más importantes de hoy",
    weight: 1.2,
  },
  {
    name: "Perplexity · Negocios",
    kind: "perplexity",
    category: "medio",
    query: "empresas y negocios en Ecuador: inversiones, empleo, exportaciones",
    weight: 1,
  },
  {
    name: "Perplexity · Justicia y corrupción",
    kind: "perplexity",
    category: "institucion",
    query: "Fiscalía Ecuador casos de corrupción, audiencias y detenciones de funcionarios",
    weight: 1.2,
  },
];

async function main() {
  console.log("Conectando a MongoDB...");
  await mongoose.connect(env.DB_URI);

  let active = 0;
  const failed: string[] = [];

  for (const seed of SOURCES) {
    let isActive = true;
    let lastError = "";
    if (seed.kind === "rss" && seed.url) {
      try {
        const items = await fetchFeed(seed.url, 50);
        if (!items.length) throw new Error("feed sin items");
        console.log(`  ✔ ${seed.name}: ${items.length} items`);
      } catch (error) {
        isActive = false;
        lastError = error instanceof Error ? error.message : String(error);
        failed.push(`${seed.name} (${lastError})`);
        console.log(`  ✖ ${seed.name}: ${lastError}`);
      }
    }
    await Source.updateOne(
      { name: seed.name },
      {
        $set: {
          kind: seed.kind,
          category: seed.category,
          url: seed.url ?? "",
          query: seed.query ?? "",
          weight: seed.weight,
          isActive,
          lastError,
        },
      },
      { upsert: true },
    );
    if (isActive) active++;
  }

  console.log(`\n✔ ${SOURCES.length} fuentes cargadas, ${active} activas.`);
  if (failed.length) console.log(`✖ RSS inactivos: ${failed.join(", ")}`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("✖ Falló el seed de fuentes:", error);
  process.exit(1);
});
