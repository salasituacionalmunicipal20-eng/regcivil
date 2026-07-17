import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "hcokzgmvoatmnmiefffv";
const MYSQL_EXE = process.env.MYSQL_EXE || "C:\\AppServ\\MySQL\\bin\\mysql.exe";
const MYSQL_HOST = process.env.MYSQL_HOST || "localhost";
const MYSQL_PORT = process.env.MYSQL_PORT || "3310";
const DRY_RUN = process.env.MIGRATION_DRY_RUN === "1";
const BATCH_SIZE = Number(process.env.MIGRATION_BATCH_SIZE || 250);
const SOURCE_NAME = "registro_mysql_2026-07-06";
const OUTPUT_ROOT = process.env.MIGRATION_OUTPUT_DIR ||
  "C:\\Users\\PC\\Documents\\Codex\\2026-07-16\\ne\\outputs";
const RUN_ID = randomUUID();
const RUN_DIR = path.join(OUTPUT_ROOT, `migration-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(RUN_DIR, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stableJson = (value) => JSON.stringify(value);
const formatDuration = (seconds) => {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  return `${minutes}m ${String(safe % 60).padStart(2, "0")}s`;
};

function badEncodingScore(value) {
  return (value.match(/[ÃÂâð�]/g) || []).length;
}

function fixText(value) {
  if (value == null || typeof value !== "string") return value;
  const clean = value.replace(/\u0000/g, "").trim();
  if (!badEncodingScore(clean)) return clean;
  const candidate = Buffer.from(clean, "latin1").toString("utf8");
  if (candidate.includes("�")) return clean;
  return badEncodingScore(candidate) < badEncodingScore(clean) ? candidate : clean;
}

function decodeMysqlCell(value) {
  if (value === "NULL") return null;
  return fixText(value.replace(/\\([0btnrZ\\])/g, (_, code) => ({
    "0": "\0", b: "\b", t: "\t", n: "\n", r: "\r", Z: "\x1a", "\\": "\\",
  })[code]));
}

function mysqlQuery(sql) {
  const result = spawnSync(MYSQL_EXE, [
    "--protocol=tcp", `--host=${MYSQL_HOST}`, `--port=${MYSQL_PORT}`,
    "--user=root", "--default-character-set=utf8", "--batch", "--skip-column-names", "-e", sql,
  ], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0) throw new Error(`MySQL falló: ${(result.stderr || "").trim()}`);
  const text = (result.stdout || "").replace(/\r/g, "").replace(/\n$/, "");
  if (!text) return [];
  return text.split("\n").map((line) => line.split("\t").map(decodeMysqlCell));
}

function tableColumns(schema, table) {
  return mysqlQuery(`SHOW COLUMNS FROM \`${schema}\`.\`${table}\``).map((row) => row[0]);
}

function tableRows(schema, table) {
  const columns = tableColumns(schema, table);
  return mysqlQuery(`SELECT * FROM \`${schema}\`.\`${table}\``).map((values) =>
    Object.fromEntries(columns.map((column, index) => [column, values[index] ?? null]))
  );
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith("0000-");
}

function isoFromLegacyDate(value) {
  if (validDate(value)) return value;
  const match = String(value || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

function simplify(value) {
  return fixText(String(value || ""))
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function mapLegacyType(value) {
  const key = simplify(value);
  if (!key) return "legacy_sin_tipo";
  if (key.includes("disolucion") && key.includes("concubinato")) return "disolucion";
  if (key.includes("concubinato")) return "union_estable";
  if (key.includes("matrimonio")) return "matrimonio";
  if (key.includes("defuncion")) return "defuncion";
  if (key.includes("naturalizacion")) return "naturalizacion";
  if (key.includes("nacimiento") || key.includes("reconocimiento") || key === "insercion") return "nacimiento";
  if (key.includes("residencia")) return "residencia";
  if (key.includes("fe de vida")) return "fe_vida";
  if (key.includes("buena conducta")) return "buena_conducta";
  if (key.includes("perdida")) return "perdida";
  if (key.includes("solter")) return "solteria";
  if (key.includes("manutencion")) return "manutencion";
  if (key.includes("expensa")) return "expensa";
  if (key.includes("viudez")) return "viudez";
  if (key.includes("cremacion") || key.includes("enterramiento") || key.includes("exhumacion")) return "permiso";
  if (key.includes("mudanza")) return "mudanza";
  if (key.includes("asistencia")) return "asistencia";
  if (key.includes("traslado")) return "traslado";
  return "legacy_otro";
}

const NUMBERED_TYPES = new Set([
  "nacimiento", "matrimonio", "defuncion", "union_estable", "disolucion",
  "naturalizacion", "permiso", "traslado",
]);

function asPositiveInt(value) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function cedulaNumber(value) {
  const digits = String(value || "").replace(/[^0-9]/g, "");
  return digits ? Number.parseInt(digits, 10) : null;
}

function yearFromDate(value) {
  return validDate(value) ? Number(value.slice(0, 4)) : null;
}

function occurrenceFingerprints(rows, tableName) {
  const seen = new Map();
  return rows.map((row) => {
    const base = sha256(`${tableName}\0${stableJson(row)}`);
    const occurrence = (seen.get(base) || 0) + 1;
    seen.set(base, occurrence);
    return { row, sourceId: `${base}:${occurrence}` };
  });
}

function indexBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key == null) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function firstMatch(map, key) {
  return map?.get(key)?.[0] || null;
}

function loadEnrichment() {
  const selected = [
    "libro", "nacimientos", "defunciones", "defunciones_n", "defunciones_nu",
    "dis_c", "naturalizacion", "residencia", "buena_conducta", "perdida",
    "manutencion", "expensa", "viudez", "mudanza", "permisos", "copias_actas", "traslado",
  ];
  const tables = Object.fromEntries(selected.map((table) => [table, tableRows("registro", table)]));
  const peopleSql = `
    SELECT d.cedula, d.nombres, d.fecha_nacimiento
    FROM datos.datos_personales d
    INNER JOIN (
      SELECT DISTINCT CAST(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(UPPER(cedula_soli),'V',''),'E',''),'-',''),'.',''),' ',''),',','') AS UNSIGNED) AS cedula_num
      FROM recover.tramite WHERE cedula_soli <> ''
    ) x ON x.cedula_num = d.cedula
    GROUP BY d.cedula`;
  const people = new Map(mysqlQuery(peopleSql).map(([cedula, nombres, fecha]) => [
    Number(cedula), { nombres: fixText(nombres), fecha_nacimiento: isoFromLegacyDate(fecha) },
  ]));
  return { tables, people };
}

function buildDetailIndexes(tables) {
  return {
    libro: indexBy(tables.libro, (r) => `${mapLegacyType(r.tipo_tramite)}|${asPositiveInt(r.acta)}|${asPositiveInt(r.ano)}`),
    nacimiento: indexBy(tables.nacimientos, (r) => `${asPositiveInt(r.acta)}|${asPositiveInt(r.ano)}`),
    defunciones: ["defunciones_nu", "defunciones_n", "defunciones"].map((name) =>
      indexBy(tables[name], (r) => `${asPositiveInt(r.acta)}|${asPositiveInt(r.ano)}`)),
    disolucion: indexBy(tables.dis_c, (r) => `${asPositiveInt(r.acta_dis)}|${asPositiveInt(r.ano_dis)}`),
    naturalizacion: indexBy(tables.naturalizacion, (r) => `${asPositiveInt(r.acta)}|${asPositiveInt(r.ano)}`),
    residencia: indexBy(tables.residencia, (r) => asPositiveInt(r.cod_residencia)),
    buena_conducta: indexBy(tables.buena_conducta, (r) => asPositiveInt(r.cod_buena)),
    perdida: indexBy(tables.perdida, (r) => asPositiveInt(r.cod_perdida)),
    manutencion: indexBy(tables.manutencion, (r) => asPositiveInt(r.cod_manutencion)),
    expensa: indexBy(tables.expensa, (r) => asPositiveInt(r.cod_expensa)),
    viudez: indexBy(tables.viudez, (r) => asPositiveInt(r.cod_viudez)),
    mudanza: indexBy(tables.mudanza, (r) => asPositiveInt(r.cod_mudanza)),
    permiso: indexBy(tables.permisos, (r) => asPositiveInt(r.codigo_permiso)),
    traslado: indexBy(tables.traslado, (r) => asPositiveInt(r.acta)),
  };
}

function detailFor(type, acta, year, constancia, indexes) {
  const actKey = `${acta}|${year}`;
  if (type === "nacimiento") return firstMatch(indexes.nacimiento, actKey);
  if (type === "defuncion") {
    for (const map of indexes.defunciones) {
      const match = firstMatch(map, actKey);
      if (match) return match;
    }
    return null;
  }
  if (type === "disolucion") return firstMatch(indexes.disolucion, actKey);
  if (type === "naturalizacion") return firstMatch(indexes.naturalizacion, actKey);
  return firstMatch(indexes[type], constancia);
}

function personFields(type, person, cedula) {
  if (!person && !cedula) return {};
  const name = person?.nombres || "";
  const birth = person?.fecha_nacimiento || null;
  if (type === "nacimiento") return { nombres_m: name, cedula_m: cedula, fecha_nac_m: birth };
  if (["matrimonio", "union_estable", "disolucion"].includes(type)) return { nombres_a: name, cedula_a: cedula, fecha_nac_a: birth };
  if (type === "defuncion") return { dec_nombres: name, dec_cedula: cedula };
  return { nombres: name, cedula, fecha_nac: birth };
}

function buildCoreRows(enrichment) {
  const sourceRows = tableRows("recover", "tramite");
  const fingerprints = occurrenceFingerprints(sourceRows, "registro.tramite");
  const indexes = buildDetailIndexes(enrichment.tables);
  const result = [];
  for (const { row, sourceId } of fingerprints) {
    const legacyType = fixText(row.tipo_tramite || "");
    const type = mapLegacyType(legacyType);
    const date = validDate(row.fecha_tramite) ? row.fecha_tramite : null;
    const rawActa = asPositiveInt(row.acta);
    const constancia = asPositiveInt(row.cod_constancia);
    let year = yearFromDate(date);
    let acta = NUMBERED_TYPES.has(type) ? rawActa : null;
    if ((type === "permiso" || type === "traslado") && !acta) acta = constancia;
    const book = acta && year ? firstMatch(indexes.libro, `${type}|${acta}|${year}`) : null;
    if (book?.ano) year = asPositiveInt(book.ano) || year;
    const cedula = fixText(row.cedula_soli || "");
    const person = enrichment.people.get(cedulaNumber(cedula)) || null;
    const detail = detailFor(type, rawActa, year, constancia, indexes);
    const data = {
      ...personFields(type, person, cedula), fecha_acto: date,
      _legacy: {
        source: "registro.tramite", source_id: sourceId, tipo_original: legacyType,
        acta_original: rawActa, constancia_original: constancia,
        fecha_original: row.fecha_tramite, hora_original: row.hora_tramite,
        funcionario: fixText(row.funcionario), autoridad: fixText(row.autoridad),
        nombre_enriquecido: person?.nombres || null, detalle_tabla: detail || null, libro: book || null,
      },
    };
    const core = {
      tipo: type, numero_acta: acta, folio: asPositiveInt(book?.folio), tomo: asPositiveInt(book?.tomo), ano: year,
      titular: person?.nombres || "Registro histórico", cedula_titular: cedula || null,
      fecha: date, estado: "Registrado", datos: data, owner: null,
      owner_usuario: fixText(row.funcionario) || "Migración PHP", legacy: true,
      pdf_path: null, legacy_source_id: sourceId,
    };
    if (date) {
      const time = /^\d{2}:\d{2}:\d{2}$/.test(row.hora_tramite || "") ? row.hora_tramite : "12:00:00";
      core.created_at = `${date}T${time}-04:00`;
      core.updated_at = core.created_at;
    }
    result.push(core);
  }
  for (const { row, sourceId } of occurrenceFingerprints(enrichment.tables.copias_actas, "registro.copias_actas")) {
    const date = validDate(row.fecha_entrega) ? row.fecha_entrega : null;
    result.push({
      tipo: "copia_acta", numero_acta: null, folio: null, tomo: null, ano: asPositiveInt(row.ano_acta),
      titular: "Entrega de copia histórica", cedula_titular: fixText(row.cedula_solicitante || "") || null,
      fecha: date, estado: "Registrado", owner: null, owner_usuario: "Migración PHP", legacy: true,
      pdf_path: null, legacy_source_id: sourceId,
      datos: {
        tipo_copia: fixText(row.tipo_acta), n_acta: asPositiveInt(row.numero_acta),
        ano_acta: asPositiveInt(row.ano_acta), copias: asPositiveInt(row.numero_copias),
        cedula_solicitante: fixText(row.cedula_solicitante || ""),
        _legacy: { source: "registro.copias_actas", source_id: sourceId, row },
      },
      ...(date ? { created_at: `${date}T12:00:00-04:00`, updated_at: `${date}T12:00:00-04:00` } : {}),
    });
  }
  return result;
}

function sourceTableInventory() {
  return mysqlQuery("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='registro' AND ENGINE IS NOT NULL ORDER BY TABLE_NAME").map((row) => row[0]);
}

function redactPasswords(table, rows) {
  if (table !== "usuarios") return rows;
  return rows.map((row) => {
    const copy = { ...row };
    for (const key of Object.keys(copy)) if (key.toLowerCase().includes("password")) copy[key] = "[NO MIGRADO POR SEGURIDAD]";
    return copy;
  });
}

function auditSource(coreRows) {
  const tableAudit = sourceTableInventory().map((table) => {
    const rows = redactPasswords(table, tableRows("registro", table));
    return { table, rows: rows.length, sha256: sha256(stableJson(rows)) };
  });
  const byType = {};
  const numbering = {};
  for (const row of coreRows) {
    byType[row.tipo] = (byType[row.tipo] || 0) + 1;
    if (row.numero_acta && row.ano) {
      const key = `${row.tipo}|${row.ano}`;
      numbering[key] = Math.max(numbering[key] || 0, row.numero_acta);
    }
  }
  return {
    run_id: RUN_ID, source: SOURCE_NAME, generated_at: new Date().toISOString(),
    mysql: { host: MYSQL_HOST, port: MYSQL_PORT, core_rows: coreRows.length, tables: tableAudit },
    core_sha256: sha256(stableJson(coreRows.map((row) => row.legacy_source_id))),
    by_type: byType, max_acta_by_type_year: numbering,
    unrecoverable_innodb_tables: ["apoderados", "concubinato", "datos_personales", "datos_presentado", "hijos_def", "hijos_mat", "matrimonios", "padres_def", "padres_mat", "testigos"],
    security: { legacy_passwords_migrated: false },
  };
}

async function management(pathname, options = {}) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error("Falta SUPABASE_ACCESS_TOKEN.");
  const response = await fetch(`https://api.supabase.com${pathname}`, {
    ...options, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase Management ${response.status}: ${text.slice(0, 1000)}`);
  return text ? JSON.parse(text) : null;
}

async function runSql(query) {
  return management(`/v1/projects/${PROJECT_REF}/database/query`, { method: "POST", body: JSON.stringify({ query, read_only: false }) });
}

async function getServiceKey() {
  const keys = await management(`/v1/projects/${PROJECT_REF}/api-keys`);
  const key = keys.find((item) => item.name === "service_role" && item.api_key)?.api_key;
  if (!key) throw new Error("No se obtuvo service_role.");
  return key;
}

async function rest(serviceKey, table, rows, { upsert = false } = {}) {
  const query = upsert ? "?on_conflict=source_table,source_row_id" : "";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`https://${PROJECT_REF}.supabase.co/rest/v1/${table}${query}`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: upsert ? "resolution=merge-duplicates,missing=default,return=minimal" : "missing=default,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (response.ok) return;
    const text = await response.text();
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 5) throw new Error(`PostgREST ${table} ${response.status}: ${text.slice(0, 1000)}`);
    await sleep(1000 * (2 ** attempt));
  }
}

async function insertBatches(serviceKey, table, rows, options = {}) {
  const started = Date.now();
  const groups = new Map();
  for (const row of rows) {
    const signature = Object.keys(row).sort().join("|");
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(row);
  }
  let completed = 0;
  for (const group of groups.values()) {
    for (let index = 0; index < group.length; index += BATCH_SIZE) {
      const batch = group.slice(index, index + BATCH_SIZE);
      await rest(serviceKey, table, batch, options);
      completed += batch.length;
      if (completed <= BATCH_SIZE || completed % 5000 < batch.length || completed === rows.length) {
        const elapsed = (Date.now() - started) / 1000;
        const eta = completed ? (elapsed / completed) * (rows.length - completed) : 0;
        console.log(`${table}: ${completed}/${rows.length} · ${((completed / rows.length) * 100).toFixed(1)}% · transcurrido ${formatDuration(elapsed)} · restante ${formatDuration(eta)}`);
      }
    }
  }
}

const PREPARE_SQL = `
alter table public.rc_tramites add column if not exists legacy_source_id text;
create table if not exists public.rc_legacy_rows (
  id bigint generated by default as identity primary key, source_table text not null,
  source_row_id text not null, source_data jsonb not null, migration_source text not null,
  migration_run uuid not null, imported_at timestamptz not null default now(), unique (source_table, source_row_id)
);
revoke all on public.rc_legacy_rows from anon, authenticated; grant all on public.rc_legacy_rows to service_role;
create table if not exists public.rc_migration_runs (
  id uuid primary key, source text not null, status text not null, source_core_rows bigint not null,
  source_archive_rows bigint not null, manifest jsonb not null, started_at timestamptz not null default now(), completed_at timestamptz
);
revoke all on public.rc_migration_runs from anon, authenticated; grant all on public.rc_migration_runs to service_role;
drop table if exists public.rc_tramites_migracion;
create table public.rc_tramites_migracion (like public.rc_tramites including defaults);
grant all on public.rc_tramites_migracion to service_role;
notify pgrst, 'reload schema';`;

async function migrate(coreRows, manifest) {
  const serviceKey = await getServiceKey();
  await runSql(PREPARE_SQL);
  await sleep(2500);
  const archiveTotal = manifest.mysql.tables.reduce((sum, table) => sum + table.rows, 0);
  await runSql(`truncate table public.rc_tramites_migracion; delete from public.rc_legacy_rows where migration_source='${SOURCE_NAME}'; insert into public.rc_migration_runs(id,source,status,source_core_rows,source_archive_rows,manifest) values ('${RUN_ID}','${SOURCE_NAME}','loading',${coreRows.length},${archiveTotal},'${JSON.stringify(manifest).replaceAll("'", "''")}'::jsonb) on conflict (id) do update set status='loading', manifest=excluded.manifest;`);
  for (const table of sourceTableInventory()) {
    const rows = redactPasswords(table, tableRows("registro", table));
    const payload = occurrenceFingerprints(rows, `registro.${table}`).map(({ row, sourceId }) => ({
      source_table: `registro.${table}`, source_row_id: sourceId, source_data: row,
      migration_source: SOURCE_NAME, migration_run: RUN_ID,
    }));
    await insertBatches(serviceKey, "rc_legacy_rows", payload, { upsert: true });
  }
  await insertBatches(serviceKey, "rc_tramites_migracion", coreRows);
  const validation = await runSql(`select (select count(*) from public.rc_tramites_migracion) as staged_core, (select count(distinct legacy_source_id) from public.rc_tramites_migracion) as staged_distinct, (select count(*) from public.rc_legacy_rows where migration_source='${SOURCE_NAME}') as archived;`);
  const row = Array.isArray(validation) ? validation[0] : validation;
  if (Number(row.staged_core) !== coreRows.length || Number(row.staged_distinct) !== coreRows.length || Number(row.archived) !== archiveTotal) throw new Error(`Validación de staging falló: ${JSON.stringify(row)}`);
  await runSql(`begin; delete from public.rc_tramites where legacy=true; insert into public.rc_tramites select * from public.rc_tramites_migracion; create unique index if not exists rc_tramites_legacy_source_id_uq on public.rc_tramites(legacy_source_id) where legacy_source_id is not null; update public.rc_migration_runs set status='completed',completed_at=now() where id='${RUN_ID}'; commit; notify pgrst, 'reload schema';`);
  const finalValidation = await runSql("select count(*) as migrated,count(distinct legacy_source_id) as distinct_sources,min(fecha) as first_date,max(fecha) as last_date from public.rc_tramites where legacy_source_id is not null;");
  return { staging: row, final: Array.isArray(finalValidation) ? finalValidation[0] : finalValidation };
}

async function main() {
  console.log("Extrayendo y normalizando el origen MySQL...");
  const enrichment = loadEnrichment();
  const coreRows = buildCoreRows(enrichment);
  const manifest = auditSource(coreRows);
  const manifestPath = path.join(RUN_DIR, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`Origen validado: ${coreRows.length} registros operativos.`);
  console.log(`Manifiesto: ${manifestPath}`);
  if (DRY_RUN) return;
  const result = await migrate(coreRows, manifest);
  const resultPath = path.join(RUN_DIR, "supabase-result.json");
  writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");
  console.log(`Migración completada. Resultado: ${resultPath}`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
