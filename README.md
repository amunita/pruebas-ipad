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
git add -A && git commit -m "pruebas: …" && git push   # GitHub Pages publica solo
```

El conversor es determinista (sin IA). Avisa si la suma de los ítems no coincide con el puntaje total o si falta un ítem en la pauta.
