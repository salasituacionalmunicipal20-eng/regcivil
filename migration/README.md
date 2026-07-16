# Migración clínica del Registro Civil

Este proceso migra la base histórica MySQL hacia Supabase sin renumerar actas.

## Controles incorporados

- Trabaja sobre una copia aislada de MySQL en el puerto `3310`.
- Conserva acta, año, folio y tomo cuando existen.
- Usa una huella SHA-256 y un contador de ocurrencia para conservar duplicados históricos sin crear duplicados accidentales.
- Carga primero en `rc_tramites_migracion` y valida las cantidades antes del reemplazo.
- Archiva las 29 tablas MyISAM legibles en `rc_legacy_rows`.
- No copia las contraseñas antiguas de `usuarios`; conserva los demás campos y marca la contraseña como no migrada.
- Registra la ejecución y el manifiesto en `rc_migration_runs`.
- No guarda el token ni las llaves de Supabase en archivos.

## Verificación local

```powershell
$env:MIGRATION_DRY_RUN='1'
node .\migration\migrate-legacy.mjs
```

## Ejecución real

Defina `SUPABASE_ACCESS_TOKEN` solo en la sesión actual y ejecute:

```powershell
Remove-Item Env:MIGRATION_DRY_RUN -ErrorAction SilentlyContinue
node .\migration\migrate-legacy.mjs
Remove-Item Env:SUPABASE_ACCESS_TOKEN -ErrorAction SilentlyContinue
```

Los respaldos y manifiestos se guardan fuera del repositorio, en la carpeta local `outputs`.
