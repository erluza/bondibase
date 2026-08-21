# Bondibase

> *esta todo realmente emparchado y atado con alambre, lo hice en joda pero se viralizo, cualquiera es libre de forkearlo, colaborar, usarlo libremente o lo que sea!*

---

## 🚌 Acerca del Proyecto

**Bondibase** es la bitácora social de colectivos del AMBA (Área Metropolitana de Buenos Aires). Es una plataforma al estilo *Letterboxd* donde los pasajeros pueden buscar líneas de colectivo, calificarlas con estrellas, publicar reseñas, consultar alertas de servicio en tiempo real y generar tarjetas visuales coleccionables para compartir en redes.

---

## 🛠️ Tecnologías Utilizadas

- **Frontend Core**: Vanilla HTML5, CSS3 (Glassmorphism, CSS Grid, Flexbox, Responsive Design) y JavaScript ES6+. No requiere frameworks ni configuraciones complejas de build.
- **Backend & Base de Datos**: [Firebase Web SDK v10](https://firebase.google.com/) (Firebase Authentication con Google/Email y Firestore Realtime Database).
- **Generador de Portadas**: Motor de renderizado en cliente sobre HTML5 Canvas para exportar imágenes coleccionables de reseñas.
- **Iconografía y Tipografía**: Font Awesome 6.x y Google Fonts (Inter, Krona One, Bellota Text).

---

## 📁 Estructura del Proyecto

```text
.
├── index.html        # Estructura principal SPA, modales, vistas y configuración de Firebase
├── app.js            # Lógica principal de la app, estado, sincronización Firestore, seguridad y motor Canvas
├── data.js           # Base de datos de líneas de colectivo del AMBA (operadoras, administraciones, colores)
├── style.css         # Sistema de diseño, tokens CSS, temas oscuros y adaptabilidad mobile
└── README.md         # Documentación para desarrolladores y colaboradores
```

---

## 🚀 Guía de Inicio Rápido (Local Development)

### 1. Clonar el repositorio
```bash
git clone https://github.com/merluzadefilet/bondibase.git
cd bondibase
```

### 2. Servir la aplicación localmente
Como la aplicación utiliza módulos JS nativos de ES6 (`type="module"`), requiere servirse mediante un servidor HTTP local estático:

- **Usando Python 3**:
  ```bash
  python3 -m http.server 8000
  ```
- **Usando Node.js / npx**:
  ```bash
  npx serve .
  ```
- **Usando VS Code**: Abrir `index.html` con la extensión **Live Server**.

Abrí tu navegador en `http://localhost:8000`.

---

## 🤝 Cómo Colaborar

¡Toda contribución es bienvenida! Si querés sumar nuevas funciones, corregir errores o sugerir mejoras:

1. **Forkeá el proyecto** en GitHub.
2. **Creá una rama para tu aporte**:
   ```bash
   git checkout -b mi-nueva-mejora
   ```
3. **Guardá y confirmá tus cambios**:
   ```bash
   git commit -m "Agrega funcionalidad X"
   ```
4. **Enviá tus cambios a tu fork**:
   ```bash
   git push origin mi-nueva-mejora
   ```
5. **Abrí un Pull Request (PR)** explicando la mejora.

---

## 💬 Comunidad y Canales Oficiales

- 🐙 **Repositorio de GitHub**: [github.com/merluzadefilet/bondibase](https://github.com/merluzadefilet/bondibase)
- ✈️ **Comunidad de Telegram**: [Grupo de Organización en Telegram](https://t.me/+oFoEmnEwRngyMDNh)

---

## 📄 Licencia

Este proyecto es abierto y de libre uso. Cualquiera es libre de forkearlo, modificarlo o distribuirlo.
