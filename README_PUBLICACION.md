# Pásalo — Sitio web preparado para Render + MySQL Aiven

## Archivos
- `public/`: páginas HTML originales, hojas de estilo y `pasalo.js`.
- `server.js`: servidor Express que entrega las páginas y la API `/api` desde el mismo dominio.
- `.env.example`: nombres de variables privadas (sin valores reales).
- `database/pasalo_base_datos_corregida.sql`: estructura de nueve tablas para importar en una base vacía.
- `package.json` y `package-lock.json`: dependencias y comandos.

## 1. Probar localmente (una vez que la base pasalo esté creada)
1. Instalar Node.js 20+.
2. Copiar `.env.example` a `.env` y completar la conexión MySQL local.
3. `npm ci`
4. `npm start`
5. Abrir `http://localhost:3000/`.

## 2. Configurar MySQL en Aiven
1. Crear un servicio MySQL y crear la base `pasalo` (a través del panel de Aiven).
2. Importar el SQL corregido con MySQL Workbench apuntando a la conexión de Aiven.
3. Descargar el certificado CA de Aiven (no subirlo a GitHub).

## 3. Publicar en Render (en el siguiente paso de la guía)
1. Subir esta carpeta a un repositorio GitHub nuevo.
2. En Render: New > Web Service > GitHub > conectar el repositorio.
3. Runtime: Node; Build Command: `npm ci`; Start Command: `npm start`.
4. Root directory: dejar vacío (el directorio raíz del repositorio debe contener `server.js`).
5. Variables de Render:
   - `NODE_ENV=production`
   - `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME=pasalo` (credenciales de Aiven)
   - `DB_SSL_CA` = **contenido PEM completo del certificado CA de Aiven** con sus líneas BEGIN/END
   - `JWT_SECRET` = una cadena aleatoria de al menos 32 caracteres, guardada en secreto
   - `PORT` = **no es necesario definirla** (Render la configura)
6. Al desplegar, comprobar `https://TU-SERVICIO.onrender.com/` y `/api/health`.

## Administrador
El rol de administrador se determina desde MySQL, **no desde un correo codificado**.
Registrar el usuario normalmente en la web y luego, desde una cuenta MySQL autorizada, ejecutar:

```sql
UPDATE usuarios SET rol = 'Admin' WHERE email = 'correo-del-administrador@ejemplo.com';
```

Cierra sesión y vuelve a entrar para abrir `admin.html`.

## Limitaciones pendientes
- La recuperación de contraseñas no era funcional en la versión original; se deshabilitó su falsa confirmación hasta añadir un servicio de correo con tokens temporales.
- Las imágenes se guardan como Base64 en MySQL; para tráfico alto conviene migrarlas a almacenamiento de objetos.
- El limitador de intentos es local a cada proceso, no distribuido.
- El registro actual marca `verificado` inmediatamente: hace falta verificación de correo real si se exigirá condición estudiantil.
- Las pruebas de API que requieren datos deben realizarse contra MySQL real. La validación local del proyecto no demuestra conectividad a Aiven.
