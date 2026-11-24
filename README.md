# Telegram Media Extractor (extensión Chrome/Edge/Brave)

Descarga imágenes, videos, GIFs, audios/notas de voz y stickers desde **Telegram Web** (`web.telegram.org/k/` y `/a/`).

## Instalación
1. Abrí `chrome://extensions` (o `edge://extensions`).
2. Activá **Modo de desarrollador**.
3. **Cargar descomprimida** → elegí la carpeta `telegram-extractor`.
4. Abrí (o recargá) https://web.telegram.org.

## Uso
- **Botón ⬇ flotante**: pasá el mouse sobre una foto/video/audio en el chat y hacé clic.
- **Popup**: clic en el ícono de la extensión → *Escanear* → filtrá por tipo → descargá uno o *Descargar seleccionados*.
- **Backup de todo el chat**: abrí el grupo, popup → *Backup de todo el chat*. Abre el medio más reciente en el visor y va hacia atrás hasta el primero, descargando cada foto/video con el botón nativo de Telegram. Abajo aparece el progreso y un botón *Detener*. Dejá la pestaña visible mientras corre.
- Para la **máxima calidad**, abrí el medio en el visor de Telegram antes de escanear/descargar.

## Limitaciones
- Solo detecta lo que Telegram Web ya cargó en pantalla: hacé scroll para cargar más mensajes.
- Videos largos se cargan por streaming; si una descarga falla, reproducilo un momento en el visor y reintentá.
- Chrome puede pedir permiso para "descargar varios archivos" la primera vez.
- Canales con contenido protegido (descarga deshabilitada por el admin) pueden no exponer el archivo; respetá los derechos del contenido.
