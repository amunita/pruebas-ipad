# Pruebas en iPad

App web (PWA) para que Javier (5º básico) y Lourdes (2º básico) respondan en el iPad las pruebas semanales y el examen de nov-dic 2026. Lourdes y Javier sólo ven las sesiones que el adulto habilita.

- **Niño:** elige su nombre → materia → sesión. Marca las alternativas tocándolas y escribe con el Apple Pencil (la palma no raya). Hay «Hoja extra» para tener más espacio. «Guardar prueba» la cierra.
- **Administración** (PIN): habilita sesiones, ve cada prueba respondida junto a la pauta, pone el puntaje de lo escrito y lo oral (las alternativas se corrigen solas), y «Guardar en libreta» registra puntaje, total, %, nota y observaciones. La nota usa la escala 2,0–7,0 con 60 % de exigencia. La nota del período es 40 % el promedio de las semanales y 60 % el examen.
- **Datos:** sólo en el iPad (IndexedDB). En Ajustes se descarga o restaura un respaldo JSON y se cambia el PIN. El PIN inicial no está en este repo.
- **Sin conexión:** después de abrirla una vez, funciona sin internet. Se instala con Compartir → «Agregar a pantalla de inicio».

## Actualizar las pruebas

Todas las sesiones (S1–S5 y Examen de las 6 materias) ya están cargadas; «súbete la S3» = habilitarla en Administración. Si cambia el contenido fuente (`.md`):

```
uv venv .venv && uv pip install --python .venv/bin/python markdown==3.7
.venv/bin/python tools/convertir.py          # lee las pruebas y pautas, escribe data/ y sw-archivos.js
.venv/bin/python tools/revisar_claves.py     # revisa las claves de Matemática que se pueden calcular
git add -A && git commit -m "pruebas: …" && git push   # GitHub Pages publica solo
```

El conversor es determinista (sin IA). Avisa si la suma de los ítems no coincide con el puntaje total o si falta un ítem en la pauta.

Los ítems que se responden eligiendo (ordenar o numerar con desplegable, completar con palabras de un recuadro, marcar una X en una matriz, tocar ☐ o una palabra) están en `tools/selecciones.json`, con la respuesta y la regla de puntaje de la pauta. No llevan recuadro de lápiz y se corrigen solos. Si se agrega un ítem así a una prueba, se agrega su línea ahí. El conversor se detiene si el número de espacios, las respuestas o el puntaje no cuadran con la pauta.

**Errores de pauta.** `fuentes/` no se edita: la corrección va en `tools/correcciones-pauta.json`, con lo que dice la fuente, lo correcto y quién lo detectó. El conversor la aplica al ítem y a la pauta completa, y se detiene si la fuente cambió. En el iPad, las notas ya guardadas en la libreta se recalculan solas con las respuestas guardadas; la libreta muestra cuál era la nota anterior. La versión nueva se aplica al volver a la portada, nunca en medio de una prueba.

`tools/revisar_claves.py` revisa sin IA las claves de alternativas de Matemática que se pueden calcular: operaciones, problemas de suma, resta y multiplicación, porcentajes, ecuaciones, promedios, áreas, volúmenes, fracciones, secuencias y el mayor o menor. Se corre después del conversor y sale con error si una clave no calza.

## Respaldos

Los datos (respuestas, libreta, PIN y pruebas habilitadas) viven sólo en el iPad. En Administración → Ajustes:

- **Guardar en Drive / Restaurar desde Drive**: usa Google Identity Services con el scope `drive.file`, así que la app sólo ve los archivos que crea. Guarda `pruebas-ipad-respaldo.json` (el último) y `pruebas-ipad-respaldo-AAAA-MM-DD.json` (uno por día). El client ID de OAuth es público y es el mismo de `amunita/curso-guitarra`; su origen autorizado, `https://amunita.github.io`, sirve para las dos apps. No hay secretos.
- **Descargar / Restaurar respaldo**: el mismo JSON, en un archivo.
- **Recordatorio**: si hay datos y pasan más de N días (7 por defecto; 3, 7, 14 o 30) sin respaldo, Administración muestra un aviso con «Guardar en Drive».

## Sincronización entre iPads

Para que los niños den las pruebas en cualquier iPad y el avance se vea en todos. Se activa en cada iPad (Administración → Ajustes → «Activar en este iPad»), entrando con la misma cuenta de Google. Usa el mismo client ID y el scope `drive.file` del respaldo, con un archivo aparte: `pruebas-ipad-sync.json`.

- **Cuándo**: al abrir la app y al volver a ella, al tocar el nombre de un niño, al abrir una prueba (espera hasta 8 s a traer lo de Drive), al guardarla, al salir de ella, al moverse por Administración (cada 30 s como mucho) y al tocar el indicador ☁️ («Sincronizado HH:MM», «Sin sincronizar · tocar»). El permiso de Google dura una hora y se recuerda en el iPad; cuando vence, Safari sólo deja pedirlo dentro de un toque (nombre del niño, «Guardar prueba» o ☁️).
- **Fusión, sin pisar resultados** (`fusionar` en `app.js`):
  - *Config*: campo a campo (`mods`): gana el cambio más reciente del PIN, de la escritura y de cada habilitación.
  - *Libreta*: por prueba, la nota guardada más tarde.
  - *Respuestas*: cada intento tiene id. Del mismo intento queda una copia: lo respondido de la que manda (la entregada gana a la empezada, salvo que se haya reabierto después; si no, la respondida más tarde) y los puntajes y observaciones de la corrección más reciente. Si son intentos distintos (la misma prueba hecha en dos iPads sin conexión), uno queda como principal y el otro en `otros`; en Corregir aparece «Hay otro intento…» con «Usar ese intento».
  - Si dos iPads suben a la vez y uno pisa al otro, lo perdido sigue en ese iPad y sube en la sincronización siguiente: repetir la fusión no cambia el resultado.
- **Claves propias del iPad**: `respaldo` y `sync` no viajan ni en la sincronización ni en los respaldos.
- Restaurar un respaldo con la sincronización activa reemplaza este iPad, pero en la próxima sincronización vuelve lo que sea más reciente en Drive.
