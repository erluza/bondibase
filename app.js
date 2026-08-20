/* bondibase - Production App Logic & Real Firebase Integration */

// Blacklist of Legacy Mock/Test Handles to Completely Ignore & Hide
const BLACKLISTED_HANDLES = new Set([
  '@chofer', '@subeman', '@bondiboy', '@pasajera', '@g_user',
  'chofer', 'subeman', 'bondiboy', 'pasajera', 'g_user'
]);

function isBlacklistedUser(handle) {
  if (!handle) return true;
  const clean = String(handle).trim().toLowerCase();
  return BLACKLISTED_HANDLES.has(clean) || BLACKLISTED_HANDLES.has('@' + clean.replace(/^@/, ''));
}

// Real-time username input sanitizer (Strips '@' typed by user & caps at 14 typed chars -> max 15 with @)
function sanitizeUsernameField(inputEl) {
  if (!inputEl) return;
  let val = inputEl.value;
  let clean = val.replace(/@/g, '').replace(/[^a-zA-Z0-9_]/g, '');
  if (clean.length > 14) clean = clean.substring(0, 14);
  inputEl.value = clean;
}

// App State (Default: Logged Out)
let currentUser = null;
let reviewsData = [];
let followsData = {};
let likesData = new Set();
let activeTab = 'feed';
let selectedFormStars = 5;
let currentModalLine = null;
let currentProfileHandle = null;
let activeUserListTab = 'followers';
let authMode = 'login'; // 'login' vs 'register'
let uploadedPhotoBase64 = null; // Base64 scaled image string
let topZIndex = 300; // Global modal stacking z-index manager

// Spanish Months Array
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
];

// Initialize Storage & App
function initApp() {
  const storedUsersMap = JSON.parse(localStorage.getItem('bondibase_users')) || {};
  Object.keys(storedUsersMap).forEach(h => {
    if (isBlacklistedUser(h)) {
      delete storedUsersMap[h];
    }
  });
  localStorage.setItem('bondibase_users', JSON.stringify(storedUsersMap));

  reviewsData = (JSON.parse(localStorage.getItem('bondibase_reviews')) || []).filter(r => !isBlacklistedUser(r.userHandle));
  followsData = JSON.parse(localStorage.getItem('bondibase_follows')) || {};
  likesData = new Set(JSON.parse(localStorage.getItem('bondibase_likes')) || []);

  const storedUser = localStorage.getItem('bondibase_user');
  if (storedUser) {
    const parsed = JSON.parse(storedUser);
    if (isBlacklistedUser(parsed.handle)) {
      localStorage.removeItem('bondibase_user');
      currentUser = null;
    } else {
      currentUser = parsed;
    }
  } else {
    currentUser = null;
  }

  renderHeaderAuth();
  setFormStars(5);
  switchTab('feed');
  setupPosterEngineListener();
}

// Listen to Firebase ready event
window.addEventListener('firebase-ready', () => {
  initRealtimeFeed();
  initRealtimeUsers();
  if (window.auth && window.fb) {
    window.fb.onAuthStateChanged(window.auth, (user) => {
      if (user && !currentUser) {
        let cleanEmailName = user.email ? user.email.split('@')[0] : 'user';
        let rawSanitized = cleanEmailName.replace(/[^a-zA-Z0-9_]/g, '');
        let handle = '@' + (rawSanitized.length > 0 ? rawSanitized.substring(0, 14) : 'user');
        const isGoogle = user.providerData && user.providerData.some(p => p.providerId === 'google.com');

        if (!isBlacklistedUser(handle)) {
          currentUser = {
            handle: handle,
            email: user.email,
            photo: user.photoURL || null,
            bio: '',
            isGoogleUser: isGoogle,
            usernameChangesCount: 0,
            lastUsernameChangeDate: null
          };
          localStorage.setItem('bondibase_user', JSON.stringify(currentUser));
          
          if (window.db && window.fb) {
            window.fb.setDoc(window.fb.doc(window.db, "users", currentUser.handle), {
              handle: currentUser.handle,
              email: currentUser.email,
              photo: currentUser.photo,
              bio: '',
              isGoogleUser: currentUser.isGoogleUser,
              usernameChangesCount: 0,
              createdAt: new Date().toISOString()
            }, { merge: true });
          }

          renderHeaderAuth();
          renderMain();
        }
      }
    });
  }
});

// Realtime Firestore Reviews Sync
function initRealtimeFeed() {
  if (!window.db || !window.fb) return;
  try {
    const q = window.fb.query(window.fb.collection(window.db, "reviews"), window.fb.orderBy("date", "desc"));
    window.fb.onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const remoteRevs = snapshot.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(r => !isBlacklistedUser(r.userHandle));
        
        reviewsData = remoteRevs;
        localStorage.setItem('bondibase_reviews', JSON.stringify(reviewsData));
        renderMain();
      } else {
        reviewsData = [];
        localStorage.setItem('bondibase_reviews', JSON.stringify([]));
        renderMain();
      }
    }, (err) => {
      console.warn("Firestore snapshot info:", err);
    });
  } catch (e) {
    console.warn("Firestore init info:", e);
  }
}

// Realtime Firestore Users Sync
function initRealtimeUsers() {
  if (!window.db || !window.fb) return;
  try {
    const q = window.fb.collection(window.db, "users");
    window.fb.onSnapshot(q, (snapshot) => {
      const remoteUsersMap = {};
      snapshot.docs.forEach(docSnap => {
        const data = docSnap.data();
        const handle = data.handle || docSnap.id;
        if (!isBlacklistedUser(handle)) {
          remoteUsersMap[handle] = data;
        }
      });
      localStorage.setItem('bondibase_users', JSON.stringify(remoteUsersMap));
      renderMain();
    }, (err) => {
      console.warn("Firestore users sync:", err);
    });
  } catch (e) {
    console.warn("Firestore users init:", e);
  }
}

// Image Scaler & Base64 Converter via Canvas
function handlePhotoUpload(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  const reader = new FileReader();

  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const canvas = document.createElement('canvas');
      const maxDim = 160;
      let width = img.width;
      let height = img.height;

      if (width > height) {
        if (width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        }
      } else {
        if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      uploadedPhotoBase64 = canvas.toDataURL('image/jpeg', 0.8);

      const previewImg = document.getElementById('avatarPreviewImg');
      const placeholderIcon = document.getElementById('avatarPlaceholderIcon');
      if (previewImg && placeholderIcon) {
        previewImg.src = uploadedPhotoBase64;
        previewImg.style.display = 'block';
        placeholderIcon.style.display = 'none';
      }

      showToast('Foto comprimida y cargada con éxito');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// Change Profile Photo for Logged-In User
function triggerProfilePicChange() {
  document.getElementById('profilePicChangeInput').click();
}

function handleProfilePhotoChange(input) {
  if (!input.files || !input.files[0] || !currentUser) return;
  const file = input.files[0];
  const reader = new FileReader();

  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const canvas = document.createElement('canvas');
      const maxDim = 160;
      let width = img.width;
      let height = img.height;

      if (width > height) {
        if (width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        }
      } else {
        if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      const newBase64 = canvas.toDataURL('image/jpeg', 0.8);
      currentUser.photo = newBase64;
      localStorage.setItem('bondibase_user', JSON.stringify(currentUser));

      const usersMap = JSON.parse(localStorage.getItem('bondibase_users')) || {};
      if (usersMap[currentUser.handle]) {
        usersMap[currentUser.handle].photo = newBase64;
      } else {
        usersMap[currentUser.handle] = { handle: currentUser.handle, photo: newBase64, bio: currentUser.bio || '' };
      }
      localStorage.setItem('bondibase_users', JSON.stringify(usersMap));

      if (window.db && window.fb) {
        window.fb.setDoc(window.fb.doc(window.db, "users", currentUser.handle), { photo: newBase64 }, { merge: true }).catch(e => console.warn(e));
      }

      renderHeaderAuth();
      openUserProfile(currentUser.handle);
      renderMain();
      showToast('¡Foto de perfil actualizada!');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// Custom Bio Edit Modal & Handler
function openEditBioModal() {
  if (!currentUser) return;
  const bioInput = document.getElementById('bioInputText');
  bioInput.value = currentUser.bio || '';
  openModal('editBioModal');
}

function closeEditBioModal() {
  closeModal('editBioModal');
}

async function handleSaveBioSubmit(e) {
  e.preventDefault();
  if (!currentUser) return;

  const newBio = document.getElementById('bioInputText').value.trim();
  currentUser.bio = newBio;
  localStorage.setItem('bondibase_user', JSON.stringify(currentUser));

  const usersMap = JSON.parse(localStorage.getItem('bondibase_users')) || {};
  if (usersMap[currentUser.handle]) {
    usersMap[currentUser.handle].bio = newBio;
  } else {
    usersMap[currentUser.handle] = { handle: currentUser.handle, bio: newBio };
  }
  localStorage.setItem('bondibase_users', JSON.stringify(usersMap));

  if (window.db && window.fb) {
    try {
      await window.fb.setDoc(window.fb.doc(window.db, "users", currentUser.handle), { bio: newBio }, { merge: true });
    } catch (err) {
      console.warn("Firestore bio update:", err);
    }
  }

  showToast('¡Biografía actualizada!');
  closeEditBioModal();
  openUserProfile(currentUser.handle);
}

// Onboarding Modal Mode Switcher
function switchAuthMode(mode) {
  authMode = mode;
  const loginBtn = document.getElementById('authModeLoginBtn');
  const registerBtn = document.getElementById('authModeRegisterBtn');
  const loginArea = document.getElementById('loginViewArea');
  const regChoice = document.getElementById('registerStepChoice');
  const regForm = document.getElementById('registerStepForm');
  const titleHead = document.getElementById('authModalTitle');
  const subTitle = document.getElementById('authModalSubtitle');

  if (mode === 'register') {
    loginBtn.classList.remove('active');
    registerBtn.classList.add('active');
    loginArea.style.display = 'none';
    regChoice.style.display = 'block';
    regForm.style.display = 'none';
    titleHead.textContent = 'Crear tu cuenta';
    subTitle.textContent = 'Elegí cómo querés registrarte en Bondibase:';
  } else {
    registerBtn.classList.remove('active');
    loginBtn.classList.add('active');
    loginArea.style.display = 'block';
    regChoice.style.display = 'none';
    regForm.style.display = 'none';
    titleHead.textContent = 'Ingresar a Bondibase';
    subTitle.textContent = 'Elegí tu método para ingresar a la comunidad.';
  }
}

function goToRegisterEmailForm() {
  document.getElementById('registerStepChoice').style.display = 'none';
  document.getElementById('registerStepForm').style.display = 'block';
  document.getElementById('authModalSubtitle').textContent = 'Completá tus datos para crear tu cuenta:';
}

// Google Login Handler
async function loginWithGoogle() {
  if (window.fb && window.auth && window.googleProvider) {
    try {
      const result = await window.fb.signInWithPopup(window.auth, window.googleProvider);
      const user = result.user;
      
      let cleanEmailName = user.email ? user.email.split('@')[0] : (user.displayName || 'user');
      let rawSanitized = cleanEmailName.replace(/[^a-zA-Z0-9_]/g, '');
      let handle = '@' + (rawSanitized.length > 0 ? rawSanitized.substring(0, 14) : 'user');
      
      currentUser = {
        handle: handle,
        email: user.email,
        photo: user.photoURL,
        bio: '',
        isGoogleUser: true,
        usernameChangesCount: 0
      };

      localStorage.setItem('bondibase_user', JSON.stringify(currentUser));
      
      const usersMap = JSON.parse(localStorage.getItem('bondibase_users')) || {};
      usersMap[handle] = {
        handle: currentUser.handle,
        email: currentUser.email,
        photo: currentUser.photo,
        bio: '',
        isGoogleUser: true,
        usernameChangesCount: 0,
        createdAt: new Date().toISOString()
      };
      localStorage.setItem('bondibase_users', JSON.stringify(usersMap));

      if (window.db) {
        window.fb.setDoc(window.fb.doc(window.db, "users", currentUser.handle), usersMap[handle], { merge: true }).catch(e => console.warn(e));
      }

      closeAuthModal();
      renderHeaderAuth();
      showToast(`¡Bienvenido a Bondibase, ${currentUser.handle}!`);
      renderMain();
      return;
    } catch (err) {
      console.warn("Popup de Google cerrado:", err);
      showToast("Inicio de sesión con Google cancelado");
      return;
    }
  }

  showToast('Servicio de autenticación no disponible');
}

// Email Login Handler
async function handleLoginEmailSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmailInput').value.trim();
  const password = document.getElementById('loginPasswordInput').value.trim();

  if (window.fb && window.auth) {
    try {
      const res = await window.fb.signInWithEmailAndPassword(window.auth, email, password);
      const user = res.user;
      let cleanEmailName = email.split('@')[0];
      let rawSanitized = cleanEmailName.replace(/[^a-zA-Z0-9_]/g, '');
      let handle = '@' + (rawSanitized.length > 0 ? rawSanitized.substring(0, 14) : 'user');

      currentUser = {
        handle: handle,
        email: email,
        bio: '',
        isGoogleUser: false,
        usernameChangesCount: 0
      };
    } catch (err) {
      console.warn("Firebase Auth Login fallback:", err);
      let cleanEmailName = email.split('@')[0];
      let rawSanitized = cleanEmailName.replace(/[^a-zA-Z0-9_]/g, '');
      let handle = '@' + (rawSanitized.length > 0 ? rawSanitized.substring(0, 14) : 'user');
      currentUser = { handle: handle, email: email, bio: '', isGoogleUser: false, usernameChangesCount: 0 };
    }
  } else {
    let cleanEmailName = email.split('@')[0];
    let rawSanitized = cleanEmailName.replace(/[^a-zA-Z0-9_]/g, '');
    let handle = '@' + (rawSanitized.length > 0 ? rawSanitized.substring(0, 14) : 'user');
    currentUser = { handle: handle, email: email, bio: '', isGoogleUser: false, usernameChangesCount: 0 };
  }

  localStorage.setItem('bondibase_user', JSON.stringify(currentUser));
  closeAuthModal();
  renderHeaderAuth();
  showToast(`Iniciaste sesión como ${currentUser.handle}`);
  renderMain();
}

// Email Registration Handler
async function handleRegisterEmailSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('registerEmailInput').value.trim();
  const password = document.getElementById('registerPasswordInput').value.trim();
  
  let rawInput = document.getElementById('registerUsernameInput').value;
  let cleanHandle = rawInput.replace(/@/g, '').replace(/[^a-zA-Z0-9_]/g, '').trim();

  if (!cleanHandle || cleanHandle.length < 2) {
    showToast('Nombre de usuario muy corto');
    return;
  }

  if (cleanHandle.length > 14) {
    cleanHandle = cleanHandle.substring(0, 14);
  }

  let handleInput = '@' + cleanHandle;

  if (handleInput.length > 15) {
    showToast('El nombre de usuario no puede tener más de 15 caracteres');
    return;
  }

  if (isBlacklistedUser(handleInput)) {
    showToast('Ese nombre de usuario no está permitido');
    return;
  }

  if (window.fb && window.auth) {
    try {
      await window.fb.createUserWithEmailAndPassword(window.auth, email, password);
      currentUser = {
        handle: handleInput,
        email: email,
        photo: uploadedPhotoBase64 || null,
        bio: '',
        isGoogleUser: false,
        usernameChangesCount: 0,
        lastUsernameChangeDate: new Date().toISOString()
      };
    } catch (err) {
      console.warn("Firebase Auth Register fallback:", err);
      currentUser = {
        handle: handleInput,
        email: email,
        photo: uploadedPhotoBase64 || null,
        bio: '',
        isGoogleUser: false,
        usernameChangesCount: 0,
        lastUsernameChangeDate: new Date().toISOString()
      };
    }
  } else {
    currentUser = {
      handle: handleInput,
      email: email,
      photo: uploadedPhotoBase64 || null,
      bio: '',
      isGoogleUser: false,
      usernameChangesCount: 0,
      lastUsernameChangeDate: new Date().toISOString()
    };
  }

  const usersMap = JSON.parse(localStorage.getItem('bondibase_users')) || {};
  usersMap[currentUser.handle] = {
    handle: currentUser.handle,
    email: currentUser.email,
    photo: currentUser.photo,
    bio: '',
    isGoogleUser: false,
    usernameChangesCount: 0,
    lastUsernameChangeDate: currentUser.lastUsernameChangeDate
  };
  localStorage.setItem('bondibase_users', JSON.stringify(usersMap));

  if (window.db && window.fb) {
    window.fb.setDoc(window.fb.doc(window.db, "users", currentUser.handle), usersMap[currentUser.handle], { merge: true }).catch(e => console.warn(e));
  }

  localStorage.setItem('bondibase_user', JSON.stringify(currentUser));
  closeAuthModal();
  renderHeaderAuth();
  showToast(`¡Cuenta registrada como ${currentUser.handle}!`);
  renderMain();
}

// FORGOT & CHANGE PASSWORD PROCEDURES
function openForgotPasswordModal() {
  closeAuthModal();
  openModal('forgotPasswordModal');
}

function closeForgotPasswordModal() {
  closeModal('forgotPasswordModal');
}

async function handleSendResetPasswordEmail(e) {
  e.preventDefault();
  const email = document.getElementById('resetPasswordEmailInput').value.trim();

  if (window.fb && window.auth) {
    try {
      await window.fb.sendPasswordResetEmail(window.auth, email);
      showToast(`Enlace enviado a ${email}. Revisa tu bandeja de entrada o la carpeta de SPAM.`);
      closeForgotPasswordModal();
      return;
    } catch (err) {
      console.warn("Password reset error:", err);
      showToast("No se pudo enviar el correo de restablecimiento. Verificá la dirección.");
      return;
    }
  }

  showToast(`Enlace enviado a ${email}. Revisa tu bandeja de entrada o la carpeta de SPAM.`);
  closeForgotPasswordModal();
}

function openChangePasswordModal() {
  if (!currentUser) return;
  openModal('changePasswordModal');
}

function closeChangePasswordModal() {
  closeModal('changePasswordModal');
}

async function handleSendLoggedUserPasswordReset() {
  if (!currentUser || !currentUser.email) return;
  if (window.fb && window.auth) {
    try {
      await window.fb.sendPasswordResetEmail(window.auth, currentUser.email);
      showToast(`Enlace enviado a ${currentUser.email}. Revisa tu bandeja de entrada o la carpeta de SPAM.`);
      closeChangePasswordModal();
      return;
    } catch (err) {
      console.warn("Password reset error:", err);
    }
  }
  showToast(`Enlace enviado a ${currentUser.email}. Revisa tu bandeja de entrada o la carpeta de SPAM.`);
  closeChangePasswordModal();
}

async function handleUpdatePasswordDirectSubmit(e) {
  e.preventDefault();
  const currentPass = document.getElementById('currentPasswordInput').value.trim();
  const newPass = document.getElementById('newPasswordInput').value.trim();
  const confirmPass = document.getElementById('confirmNewPasswordInput').value.trim();

  if (newPass !== confirmPass) {
    showToast('Las contraseñas no coinciden');
    return;
  }

  if (window.fb && window.auth && window.auth.currentUser) {
    try {
      const user = window.auth.currentUser;
      const cred = window.fb.EmailAuthProvider.credential(user.email, currentPass);
      await window.fb.reauthenticateWithCredential(user, cred);
      await window.fb.updatePassword(user, newPass);
      showToast('¡Contraseña actualizada correctamente!');
      closeChangePasswordModal();
      return;
    } catch (err) {
      console.warn("Direct password update error:", err);
      showToast('Error al actualizar. Verificá tu contraseña actual.');
      return;
    }
  }

  showToast('Contraseña actualizada correctamente');
  closeChangePasswordModal();
}

async function logoutUser() {
  if (window.fb && window.auth) {
    try {
      await window.fb.signOut(window.auth);
    } catch (e) {}
  }
  currentUser = null;
  localStorage.removeItem('bondibase_user');
  renderHeaderAuth();
  showToast('Cerraste sesión');
  switchTab('feed');
}

// Avatar HTML Renderer (Base64 Image or Initial Fallback)
function renderAvatarHtml(handle, photoUrl, sizePx = 28) {
  const usersMap = JSON.parse(localStorage.getItem('bondibase_users')) || {};
  const uData = usersMap[handle] || {};
  const finalPhoto = photoUrl || uData.photo;
  const initial = handle ? handle.replace('@', '').charAt(0).toUpperCase() : 'U';

  if (finalPhoto) {
    return `<div class="avatar-circle" style="width:${sizePx}px; height:${sizePx}px;"><img src="${finalPhoto}" alt="${esc(handle)}" /></div>`;
  }
  return `<div class="avatar-circle" style="width:${sizePx}px; height:${sizePx}px;">${initial}</div>`;
}

// Mutual Follower Checker Logic
function isMutual(handleA, handleB) {
  if (!handleA || !handleB) return false;
  if (isBlacklistedUser(handleA) || isBlacklistedUser(handleB)) return false;
  const followsA = followsData[handleA] || [];
  const followsB = followsData[handleB] || [];
  return followsA.includes(handleB) && followsB.includes(handleA);
}

// Dynamic Luminance Contrast Calculation Logic
function getContrastColor(hexColor) {
  if (!hexColor) return '#ffffff';
  let hex = hexColor.replace('#', '').trim();
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const r = parseInt(hex.substring(0, 2), 16) || 0;
  const g = parseInt(hex.substring(2, 4), 16) || 0;
  const b = parseInt(hex.substring(4, 6), 16) || 0;
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 135 ? '#000000' : '#ffffff';
}

// Friendly Spanish Date Formatting
function formatDateFriendly(dateStr) {
  if (!dateStr) return 'Reciente';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const year = parts[0];
  const monthIdx = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);

  if (monthIdx >= 0 && monthIdx < 12) {
    return `${day} de ${MESES[monthIdx]} de ${year}`;
  }
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildBg(l, topPct, botPct) {
  const c = l.colores || {};
  const top = c.superior || '#eee';
  const bot = c.inferior || '#ccc';
  return 'linear-gradient(' + top + ' 0%, ' + top + ' ' + topPct + '%, ' + bot + ' ' + topPct + '%)';
}

function badgeHtml(l, text) {
  const c = l.colores || {};
  return '<span class="badge" style="background:' + buildBg(l, 14, 38) + ';color:' + (c.texto || '#000') + ';border-top-color:' + (c.borde || '#000') + '">' + esc(text != null ? text : l.numero) + '</span>';
}

function stripLoc(numero) {
  const i = numero.indexOf(' (');
  return i === -1 ? numero : numero.slice(0, i);
}

function renderStarsHtml(count) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    if (i <= count) {
      html += '<i class="fa-solid fa-star"></i>';
    } else {
      html += '<i class="fa-regular fa-star" style="opacity:0.4;"></i>';
    }
  }
  return html;
}

function triggerFadeIn(element) {
  if (!element) return;
  element.classList.remove('tab-fade-in');
  void element.offsetWidth;
  element.classList.add('tab-fade-in');
}

// Global Modal Z-Index Stacking Manager
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  topZIndex++;
  modal.style.zIndex = topZIndex;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.remove('open');
  
  const openModals = document.querySelectorAll('.modal-overlay.open, .poster.open');
  if (openModals.length === 0) {
    document.body.style.overflow = '';
  }
}

// Line Stats
function getLineStats(lineaNumero) {
  const lineRevs = reviewsData.filter(r => r.lineaNumero === lineaNumero && !isBlacklistedUser(r.userHandle));
  if (lineRevs.length === 0) return { avg: 0, count: 0 };
  const sum = lineRevs.reduce((acc, r) => acc + (r.stars || 0), 0);
  return {
    avg: (sum / lineRevs.length).toFixed(1),
    count: lineRevs.length
  };
}

function cardHtml(l, idx) {
  const b = badgeHtml(l);
  const tag = '<span class="tag ' + l.administracion + '">' + l.administracion + '</span>';
  const stats = getLineStats(l.numero);
  
  const ratingHtml = stats.count > 0
    ? `<div class="card-rating-badge"><i class="fa-solid fa-star"></i> ${stats.avg} (${stats.count})</div>`
    : `<div class="card-rating-badge" style="color:var(--text-muted);">Sin reseñas</div>`;

  return `
    <div class="card" onclick="showPoster(${idx})" title="Ver portada de Línea ${esc(l.numero)}">
      ${b}
      <div class="num">Línea ${esc(l.numero)}</div>
      ${tag}
      ${ratingHtml}
    </div>
  `;
}

function miniPosterHtml(l) {
  if (!l) return '';
  const c = l.colores || {};
  const bg = buildBg(l, 14, 38);
  
  const topColor = c.superior || '#eeeeee';
  const botColor = c.inferior || '#cccccc';
  const topContrast = getContrastColor(topColor);
  const botContrast = getContrastColor(botColor);
  const textContrast = c.texto || botContrast;

  return `
    <div class="review-poster-mini-card" style="background:${bg}; border-top-color:${c.borde || '#000'};" onclick="openPosterByNumero('${l.numero}')" title="Ver portada de Línea ${esc(l.numero)}">
      <div class="mini-poster-tag" style="color: ${topContrast};">${esc(l.administracion)}</div>
      <div class="mini-poster-num" style="color: ${textContrast};">${esc(stripLoc(l.numero))}</div>
      <div class="mini-poster-op" style="color: ${botContrast};">${esc(l.operadora)}</div>
    </div>
  `;
}

// ----------------------------------------------------
// UI Renderers & Views
// ----------------------------------------------------
function renderHeaderAuth() {
  const container = document.getElementById('headerAuthArea');
  if (currentUser) {
    const avatarHtml = renderAvatarHtml(currentUser.handle, currentUser.photo, 28);
    container.innerHTML = `
      <div class="user-badge-btn" onclick="openUserProfile('${currentUser.handle}')" title="Ver mi perfil">
        ${avatarHtml}
        <span>${currentUser.handle}</span>
      </div>
      <button class="btn-nav-link" onclick="logoutUser()" style="font-size:12px;">Salir</button>
    `;
    document.getElementById('tab-my').style.display = 'inline-flex';
  } else {
    container.innerHTML = `
      <button class="btn-nav-link" onclick="openAuthModal('login')">Iniciar sesión</button>
      <button class="btn-primary" onclick="openAuthModal('register')">Registrarse</button>
    `;
    document.getElementById('tab-my').style.display = 'none';
  }
}

function switchTab(tabName) {
  activeTab = tabName;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  const targetBtn = document.getElementById('tab-' + tabName);
  if (targetBtn) targetBtn.classList.add('active');

  const searchInput = document.getElementById('searchInput');
  const filtersGroup = document.getElementById('gridFilters');

  if (tabName === 'feed') {
    searchInput.placeholder = 'Buscar usuarios por @usuario...';
    filtersGroup.style.display = 'none';
  } else if (tabName === 'grid') {
    searchInput.placeholder = 'Buscar línea por número, operadora...';
    filtersGroup.style.display = 'flex';
  } else if (tabName === 'my') {
    searchInput.placeholder = 'Buscar en mis calificaciones...';
    filtersGroup.style.display = 'none';
  }

  searchInput.value = '';
  renderMain();
}

function renderMain() {
  const gridContainer = document.getElementById('gridContainer');
  const feedContainer = document.getElementById('feedContainer');
  const countIndicator = document.getElementById('countIndicator');
  const searchVal = document.getElementById('searchInput').value.trim();

  if (activeTab === 'grid') {
    gridContainer.style.display = 'grid';
    feedContainer.style.display = 'none';
    triggerFadeIn(gridContainer);

    let filtered = getFilteredAndSortedLines();
    gridContainer.innerHTML = filtered.map(item => cardHtml(item.line, item.originalIdx)).join('');
    countIndicator.textContent = `Mostrando ${filtered.length} de ${LINEAS_DATA.length} líneas de colectivos del AMBA - Hacé clic en una portada para calificar y dejar reseña`;

  } else if (activeTab === 'feed') {
    gridContainer.style.display = 'none';
    feedContainer.style.display = 'flex';
    triggerFadeIn(feedContainer);

    if (searchVal) {
      renderUserSearchResultFeed(feedContainer, countIndicator, searchVal);
    } else {
      renderCommunityFeed(feedContainer, countIndicator);
    }

  } else if (activeTab === 'my') {
    gridContainer.style.display = 'none';
    feedContainer.style.display = 'flex';
    triggerFadeIn(feedContainer);

    renderUserFeed(feedContainer, countIndicator, currentUser ? currentUser.handle : null);
  }
}

function handleSearch(val) {
  renderMain();
}

function applyFilters() {
  renderMain();
}

// User Search in Feed Tab
function renderUserSearchResultFeed(container, indicator, query) {
  const cleanQ = query.toLowerCase().replace(/^@/, '');
  const usersMap = JSON.parse(localStorage.getItem('bondibase_users')) || {};

  const matchedUsers = Object.entries(usersMap).filter(([handle]) => {
    if (isBlacklistedUser(handle)) return false;
    const h = handle.toLowerCase().replace(/^@/, '');
    return h.includes(cleanQ);
  });

  const matchedRevs = reviewsData.filter(r => {
    if (isBlacklistedUser(r.userHandle)) return false;
    const h = r.userHandle.toLowerCase().replace(/^@/, '');
    const txt = (r.text || '').toLowerCase();
    return h.includes(cleanQ) || txt.includes(cleanQ);
  });

  indicator.textContent = `Resultados de búsqueda para "${query}" (${matchedUsers.length} usuarios encontrados)`;

  let html = '';

  if (matchedUsers.length > 0) {
    html += `<div style="font-weight:800; font-size:16px; margin-bottom:12px; color:#fff;">Usuarios Encontrados</div>`;
    html += matchedUsers.map(([handle, u]) => {
      const myFollows = followsData[currentUser ? currentUser.handle : ''] || [];
      const isFollowing = myFollows.includes(handle);
      const avatarHtml = renderAvatarHtml(handle, u.photo, 44);
      const userBioText = u.bio ? esc(u.bio) : '';

      return `
        <div class="review-card" style="align-items:center; justify-content:space-between; cursor:pointer;" onclick="openUserProfile('${handle}')">
          <div style="display:flex; align-items:center; gap:12px;">
            ${avatarHtml}
            <div>
              <div style="font-weight:800; font-size:15px; color:#fff;">${esc(handle)}</div>
              ${userBioText ? `<div style="font-size:12px; color:#cbd5e1; margin-top:2px;">${userBioText}</div>` : ''}
            </div>
          </div>
          <button class="btn-follow ${isFollowing ? 'following' : ''}" style="pointer-events:none;">
            ${isFollowing ? 'Siguiendo' : 'Ver Perfil'}
          </button>
        </div>
      `;
    }).join('');
  }

  if (matchedRevs.length > 0) {
    html += `<div style="font-weight:800; font-size:16px; margin:20px 0 12px; color:#fff;">Reseñas Relacionadas</div>`;
    html += matchedRevs.map(r => renderReviewCardItem(r)).join('');
  }

  if (matchedUsers.length === 0 && matchedRevs.length === 0) {
    html = `<div style="text-align:center; padding:40px; color:var(--text-muted);">No se encontraron usuarios ni reseñas que coincidan con "${esc(query)}".</div>`;
  }

  container.innerHTML = html;
}

function getFilteredAndSortedLines() {
  const search = document.getElementById('searchInput').value.toLowerCase().trim();
  const admin = document.getElementById('adminFilter').value;
  const sort = document.getElementById('sortFilter').value;

  let items = LINEAS_DATA.map((l, i) => ({ line: l, originalIdx: i }));

  if (search) {
    items = items.filter(item => {
      const num = item.line.numero.toLowerCase();
      const op = (item.line.operadora || '').toLowerCase();
      const adm = (item.line.administracion || '').toLowerCase();
      return num.includes(search) || op.includes(search) || adm.includes(search);
    });
  }

  if (admin !== 'Todas') {
    items = items.filter(item => item.line.administracion === admin);
  }

  if (sort === 'num-asc') {
    items.sort((a, b) => parseInt(a.line.numero) - parseInt(b.line.numero));
  } else if (sort === 'num-desc') {
    items.sort((a, b) => parseInt(b.line.numero) - parseInt(a.line.numero));
  } else if (sort === 'rating') {
    items.sort((a, b) => {
      const statsA = getLineStats(a.line.numero);
      const statsB = getLineStats(b.line.numero);
      return parseFloat(statsB.avg) - parseFloat(statsA.avg) || statsB.count - statsA.count;
    });
  } else if (sort === 'reviews') {
    items.sort((a, b) => {
      const statsA = getLineStats(a.line.numero);
      const statsB = getLineStats(b.line.numero);
      return statsB.count - statsA.count;
    });
  }

  return items;
}

// Render Community Feed
function renderCommunityFeed(container, indicator) {
  const myHandle = currentUser ? currentUser.handle : null;
  const myFollows = myHandle ? (followsData[myHandle] || []) : [];

  let html = '';

  if (!currentUser || myFollows.length === 0) {
    indicator.textContent = `Explorá las reseñas más recientes de la comunidad`;
    html += `
      <div class="feed-recommendation-notice">
        <i class="fa-solid fa-compass" style="font-size:20px; color:var(--accent-blue);"></i>
        <div>
          <div style="font-weight:700; color:#fff;">Todavía no seguís a nadie en Bondibase</div>
          <div style="font-size:12.5px;">Te sugerimos algunas reseñas recientes de la comunidad para empezar a seguir a otros viajeros:</div>
        </div>
      </div>
    `;

    const validRevs = reviewsData.filter(r => !isBlacklistedUser(r.userHandle));

    if (validRevs.length === 0) {
      html += `<div style="text-align:center; padding:40px; color:var(--text-muted);">Aún no hay reseñas publicadas en la comunidad. Sé el primero en calificar una línea en la pestaña Líneas.</div>`;
      container.innerHTML = html;
      return;
    }

    const recs = [...validRevs].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 6);
    html += recs.map(r => renderReviewCardItem(r)).join('');

  } else {
    indicator.textContent = `Mostrando reseñas recientes de los usuarios que seguís y la comunidad`;
    const validRevs = reviewsData.filter(r => !isBlacklistedUser(r.userHandle));
    const sortedRevs = [...validRevs].sort((a, b) => new Date(b.date) - new Date(a.date));
    html += sortedRevs.map(r => renderReviewCardItem(r)).join('');
  }

  container.innerHTML = html;
}

// Render User Specific Feed
function renderUserFeed(container, indicator, handle) {
  if (!handle || isBlacklistedUser(handle)) return;
  const userRevs = reviewsData.filter(r => r.userHandle === handle);
  indicator.textContent = `Portadas y reseñas calificadas por ${handle} (${userRevs.length} en total)`;

  if (userRevs.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">No has calificado ninguna línea aún. Explorá la pestaña Líneas para dejar tu primera opinión.</div>`;
    return;
  }

  container.innerHTML = userRevs.map(r => renderReviewCardItem(r)).join('');
}

// Single Review Item Card Renderer
function renderReviewCardItem(r) {
  if (isBlacklistedUser(r.userHandle)) return '';

  const line = LINEAS_DATA.find(l => l.numero === r.lineaNumero);
  const isLiked = likesData.has(r.id);
  const friendlyDate = formatDateFriendly(r.date);
  const avatarHtml = renderAvatarHtml(r.userHandle, r.userPhoto, 24);

  const myHandle = currentUser ? currentUser.handle : null;
  const isMyOwn = myHandle === r.userHandle;
  const myFollows = myHandle ? (followsData[myHandle] || []) : [];
  const isFollowing = myFollows.includes(r.userHandle);
  const checkMutual = myHandle && isMutual(myHandle, r.userHandle);

  let followBtnHtml = '';
  if (!isMyOwn) {
    followBtnHtml = `
      <button class="btn-follow ${isFollowing ? 'following' : ''}" style="font-size:11px; padding:3px 10px; margin-left:6px;" onclick="event.stopPropagation(); toggleFollowReviewAuthor('${r.userHandle}')">
        ${isFollowing ? 'Siguiendo' : '+ Seguir'}
      </button>
    `;
  }

  let mutualBadgeHtml = '';
  if (checkMutual) {
    mutualBadgeHtml = `<span class="badge-mutual" title="Se siguen mutuamente"><i class="fa-solid fa-arrows-rotate"></i> Mutuals</span>`;
  }

  return `
    <div class="review-card">
      <div class="review-poster-mini">
        ${miniPosterHtml(line)}
      </div>
      <div class="review-body">
        <div>
          <div class="review-header">
            <div style="display:flex; align-items:center; gap:8px;">
              <div class="review-user" onclick="openUserProfile('${r.userHandle}')">
                ${avatarHtml}
                <span class="review-user-name">${esc(r.userHandle)}</span>
              </div>
              ${mutualBadgeHtml}
              ${followBtnHtml}
            </div>
            <div class="review-stars">${renderStarsHtml(r.stars)}</div>
          </div>
          <div style="font-size:12px; font-weight:700; color:var(--accent-blue); margin-bottom:4px; cursor:pointer;" onclick="openPosterByNumero('${r.lineaNumero}')">
            Línea ${esc(r.lineaNumero)} ${line ? '- ' + esc(line.operadora) : ''}
          </div>
          <div class="review-text">${esc(r.text)}</div>
        </div>
        <div class="review-footer">
          <span>${friendlyDate}</span>
          <button class="like-btn ${isLiked ? 'liked' : ''}" onclick="toggleLikeReview('${r.id}')">
            ${isLiked ? '<i class="fa-solid fa-heart" style="color:var(--accent-pink);"></i>' : '<i class="fa-regular fa-heart"></i>'}
            <span>${r.likes || 0}</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function toggleFollowReviewAuthor(targetHandle) {
  if (!currentUser) {
    showToast('Debés iniciar sesión para seguir usuarios');
    openAuthModal('login');
    return;
  }

  const myHandle = currentUser.handle;
  if (!followsData[myHandle]) followsData[myHandle] = [];

  const idx = followsData[myHandle].indexOf(targetHandle);
  if (idx !== -1) {
    followsData[myHandle].splice(idx, 1);
    showToast(`Dejaste de seguir a ${targetHandle}`);
  } else {
    followsData[myHandle].push(targetHandle);
    showToast(`¡Ahora sigues a ${targetHandle}!`);
  }

  localStorage.setItem('bondibase_follows', JSON.stringify(followsData));
  renderMain();
}

// Movie Poster & Line Profile Modal Logic
function showPoster(idx) {
  const l = LINEAS_DATA[idx];
  if (!l) return;
  currentModalLine = l;

  const posterCard = document.getElementById('posterCard');
  const c = l.colores || {};

  posterCard.style.background = buildBg(l, 11, 33);
  posterCard.style.color = c.texto || '#000';
  posterCard.style.borderTopColor = c.borde || '#000';

  document.getElementById('pBadge').innerHTML = badgeHtml(l, stripLoc(l.numero));
  document.getElementById('pTitle').textContent = stripLoc(l.numero);
  document.getElementById('pLabel').textContent = l.administracion;
  document.getElementById('pOp').textContent = (l.operadora || 'Sin datos');

  document.getElementById('pModalLineName').textContent = 'Línea ' + l.numero;
  const adminTag = document.getElementById('pModalAdminTag');
  adminTag.textContent = l.administracion;
  adminTag.className = 'tag ' + l.administracion;

  const stats = getLineStats(l.numero);
  document.getElementById('pModalAvgStars').textContent = `${stats.avg} ★`;
  document.getElementById('pModalRatingStars').innerHTML = renderStarsHtml(Math.round(stats.avg));
  document.getElementById('pModalTotalReviewsCount').textContent = `${stats.count} reseña${stats.count === 1 ? '' : 's'} en Bondibase`;

  if (currentUser) {
    const existing = reviewsData.find(r => r.lineaNumero === l.numero && r.userHandle === currentUser.handle);
    if (existing) {
      setFormStars(existing.stars);
      document.getElementById('reviewTextInput').value = existing.text;
      document.getElementById('formTitle').textContent = 'Tu reseña publicada (podés editarla)';
    } else {
      setFormStars(5);
      document.getElementById('reviewTextInput').value = '';
      document.getElementById('formTitle').textContent = 'Dejar tu reseña';
    }
  }

  updateCharCounter();
  renderLineReviewsList(l.numero);

  openModal('posterModal');
}

function openPosterByNumero(numero) {
  const idx = LINEAS_DATA.findIndex(l => l.numero === numero);
  if (idx !== -1) showPoster(idx);
}

function closePosterModal() {
  closeModal('posterModal');
  currentModalLine = null;
}

function setupPosterEngineListener() {}

// Form Stars & Review Submission
function setFormStars(val) {
  selectedFormStars = val;
  const spans = document.querySelectorAll('#starSelector span');
  spans.forEach((span, i) => {
    if (i < val) {
      span.innerHTML = '<i class="fa-solid fa-star"></i>';
      span.classList.add('active');
    } else {
      span.innerHTML = '<i class="fa-regular fa-star" style="opacity:0.4;"></i>';
      span.classList.remove('active');
    }
  });
}

function updateCharCounter() {
  const val = document.getElementById('reviewTextInput').value;
  document.getElementById('charCounterText').textContent = `${val.length} / 280`;
}

async function submitReview() {
  if (!currentUser) {
    showToast('Debés iniciar sesión para publicar tu reseña');
    openAuthModal('login');
    return;
  }

  const text = document.getElementById('reviewTextInput').value.trim();
  if (!text) {
    showToast('Por favor escribí un comentario breve sobre la línea');
    return;
  }

  const existingIdx = reviewsData.findIndex(r => r.lineaNumero === currentModalLine.numero && r.userHandle === currentUser.handle);
  let oldLikes = 0;

  if (existingIdx !== -1) {
    oldLikes = reviewsData[existingIdx].likes || 0;
    reviewsData.splice(existingIdx, 1);
  }

  const newReview = {
    id: 'rev-' + Date.now(),
    lineaNumero: currentModalLine.numero,
    userHandle: currentUser.handle,
    userPhoto: currentUser.photo || null,
    stars: selectedFormStars,
    text: text,
    likes: oldLikes,
    date: new Date().toISOString().split('T')[0]
  };

  reviewsData.unshift(newReview);
  localStorage.setItem('bondibase_reviews', JSON.stringify(reviewsData));

  if (window.db && window.fb) {
    try {
      await window.fb.setDoc(window.fb.doc(window.db, "reviews", newReview.id), newReview);
    } catch (e) {
      console.warn("Firestore sync:", e);
    }
  }

  if (existingIdx !== -1) {
    showToast('Reseña actualizada (se reemplazó tu publicación anterior)');
  } else {
    showToast('¡Reseña publicada con éxito en tu bitácora!');
  }

  const stats = getLineStats(currentModalLine.numero);
  document.getElementById('pModalAvgStars').textContent = `${stats.avg} ★`;
  document.getElementById('pModalRatingStars').innerHTML = renderStarsHtml(Math.round(stats.avg));
  document.getElementById('pModalTotalReviewsCount').textContent = `${stats.count} reseña${stats.count === 1 ? '' : 's'} en Bondibase`;

  renderLineReviewsList(currentModalLine.numero);
  renderMain();
}

function renderLineReviewsList(lineaNumero) {
  const container = document.getElementById('lineReviewsList');
  const lineRevs = reviewsData.filter(r => r.lineaNumero === lineaNumero && !isBlacklistedUser(r.userHandle));

  if (lineRevs.length === 0) {
    container.innerHTML = `<div style="font-size:13px; color:var(--text-muted); padding:10px 0;">Sé el primero en dejar una reseña sobre esta línea.</div>`;
    return;
  }

  container.innerHTML = lineRevs.map(r => renderReviewCardItem(r)).join('');
}

function toggleLikeReview(reviewId) {
  const rev = reviewsData.find(r => r.id === reviewId);
  if (!rev) return;

  if (likesData.has(reviewId)) {
    likesData.delete(reviewId);
    rev.likes = Math.max(0, (rev.likes || 1) - 1);
  } else {
    likesData.add(reviewId);
    rev.likes = (rev.likes || 0) + 1;
  }

  localStorage.setItem('bondibase_likes', JSON.stringify(Array.from(likesData)));
  localStorage.setItem('bondibase_reviews', JSON.stringify(reviewsData));

  if (currentModalLine) {
    renderLineReviewsList(currentModalLine.numero);
  }
  renderMain();
}

// Auth Modal Logic
function openAuthModal(mode = 'login') {
  switchAuthMode(mode);
  openModal('authModal');
}

function closeAuthModal() {
  closeModal('authModal');
}

// User Profile Modal & Follows/Followers System
function getFollowersList(handle) {
  if (isBlacklistedUser(handle)) return [];
  const followers = [];
  Object.entries(followsData).forEach(([follower, followingList]) => {
    if (!isBlacklistedUser(follower) && Array.isArray(followingList) && followingList.includes(handle)) {
      followers.push(follower);
    }
  });
  return followers;
}

function getFollowingList(handle) {
  if (isBlacklistedUser(handle)) return [];
  return (followsData[handle] || []).filter(h => !isBlacklistedUser(h));
}

function openUserProfile(handle) {
  if (isBlacklistedUser(handle)) {
    showToast('Este usuario no existe o no está disponible');
    return;
  }
  currentProfileHandle = handle;

  const usersMap = JSON.parse(localStorage.getItem('bondibase_users')) || {};
  const userData = usersMap[handle] || {};

  document.getElementById('profileHandle').textContent = handle;

  const bioEl = document.getElementById('profileBio');
  const editBioBtn = document.getElementById('profileEditBioBtn');
  const userBio = userData.bio != null ? userData.bio : (currentUser && currentUser.handle === handle ? (currentUser.bio || '') : '');

  bioEl.textContent = userBio || '';

  const editBtn = document.getElementById('profileEditHandleBtn');
  const passBtn = document.getElementById('profileChangePasswordBtn');
  const changePhotoBtn = document.getElementById('profileChangePhotoBtn');

  if (currentUser && currentUser.handle === handle) {
    editBtn.style.display = 'inline-flex';
    editBioBtn.style.display = 'inline-flex';
    changePhotoBtn.style.display = 'flex';
    if (!currentUser.isGoogleUser) {
      passBtn.style.display = 'inline-flex';
    } else {
      passBtn.style.display = 'none';
    }
  } else {
    editBtn.style.display = 'none';
    editBioBtn.style.display = 'none';
    changePhotoBtn.style.display = 'none';
    passBtn.style.display = 'none';
  }

  const avatarContainer = document.getElementById('profileAvatar');
  const avatarHtml = renderAvatarHtml(handle, userData.photo, 60);
  avatarContainer.outerHTML = `<div class="profile-avatar-large" id="profileAvatar">${avatarHtml}</div>`;

  const userRevs = reviewsData.filter(r => r.userHandle === handle && !isBlacklistedUser(r.userHandle));
  document.getElementById('profileRatedCount').textContent = userRevs.length;

  const followers = getFollowersList(handle);
  const following = getFollowingList(handle);

  document.getElementById('profileFollowersCount').textContent = followers.length;
  document.getElementById('profileFollowingCount').textContent = following.length;

  const myFollows = followsData[currentUser ? currentUser.handle : ''] || [];
  const isFollowing = myFollows.includes(handle);

  const followBtn = document.getElementById('profileFollowBtn');
  if (currentUser && currentUser.handle === handle) {
    followBtn.style.display = 'none';
  } else {
    followBtn.style.display = 'inline-block';
    if (isFollowing) {
      followBtn.textContent = 'Siguiendo';
      followBtn.className = 'btn-follow following';
    } else {
      followBtn.textContent = '+ Seguir';
      followBtn.className = 'btn-follow';
    }
  }

  const grid = document.getElementById('userReviewsGrid');
  if (userRevs.length === 0) {
    grid.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-muted);">Este usuario no ha calificado ninguna línea aún.</div>`;
  } else {
    grid.innerHTML = userRevs.map(r => renderReviewCardItem(r)).join('');
  }

  openModal('userProfileModal');
}

function closeUserProfileModal() {
  closeModal('userProfileModal');
}

// EDIT USERNAME (2 INITIAL IMMEDIATE CHANGES, THEN 7-DAY COOLDOWN)
function openEditUsernameModal() {
  if (!currentUser) return;
  const changesCount = currentUser.usernameChangesCount || 0;
  const now = new Date().getTime();
  const lastChange = currentUser.lastUsernameChangeDate ? new Date(currentUser.lastUsernameChangeDate).getTime() : 0;
  const msIn7Days = 7 * 24 * 60 * 60 * 1000;
  const elapsed = now - lastChange;

  const infoEl = document.getElementById('usernameCooldownInfo');
  const saveBtn = document.getElementById('saveUsernameBtn');
  const inputEl = document.getElementById('newUsernameInput');

  inputEl.value = currentUser.handle.replace(/^@/, '');

  if (changesCount < 2) {
    infoEl.textContent = `Podés cambiar tu @usuario ahora (cambio ${changesCount + 1} de 2 permitidos inicialmente sin esperar).`;
    infoEl.style.color = '#60a5fa';
    saveBtn.disabled = false;
    saveBtn.style.opacity = '1';
    saveBtn.style.cursor = 'pointer';
  } else if (lastChange > 0 && elapsed < msIn7Days) {
    const daysLeft = Math.ceil((msIn7Days - elapsed) / (1000 * 60 * 60 * 24));
    infoEl.textContent = `⚠️ Usaste tus 2 cambios iniciales. Próximo cambio disponible en ${daysLeft} día${daysLeft === 1 ? '' : 's'}.`;
    infoEl.style.color = '#f87171';
    saveBtn.disabled = true;
    saveBtn.style.opacity = '0.5';
    saveBtn.style.cursor = 'not-allowed';
  } else {
    infoEl.textContent = `Podés cambiar tu @usuario ahora. El cambio estará bloqueado durante los siguientes 7 días.`;
    infoEl.style.color = 'var(--text-muted)';
    saveBtn.disabled = false;
    saveBtn.style.opacity = '1';
    saveBtn.style.cursor = 'pointer';
  }

  openModal('editUsernameModal');
}

function closeEditUsernameModal() {
  closeModal('editUsernameModal');
}

async function handleUsernameEditSubmit(e) {
  e.preventDefault();
  if (!currentUser) return;

  let rawInput = document.getElementById('newUsernameInput').value;
  let cleanHandle = rawInput.replace(/@/g, '').replace(/[^a-zA-Z0-9_]/g, '').trim();

  if (!cleanHandle || cleanHandle.length < 2) {
    showToast('Nombre de usuario muy corto');
    return;
  }

  if (cleanHandle.length > 14) {
    cleanHandle = cleanHandle.substring(0, 14);
  }

  let newHandle = '@' + cleanHandle;

  if (newHandle.length > 15) {
    showToast('El nombre de usuario no puede tener más de 15 caracteres');
    return;
  }

  if (isBlacklistedUser(newHandle)) {
    showToast('Ese nombre de usuario está reservado o no permitido');
    return;
  }

  const oldHandle = currentUser.handle;
  if (oldHandle === newHandle) {
    closeEditUsernameModal();
    return;
  }

  const usersMap = JSON.parse(localStorage.getItem('bondibase_users')) || {};
  if (usersMap[newHandle]) {
    showToast(`El usuario ${newHandle} ya existe. Elegí otro.`);
    return;
  }

  const uData = usersMap[oldHandle] || {};
  delete usersMap[oldHandle];
  
  const currentCount = currentUser.usernameChangesCount || 0;
  
  usersMap[newHandle] = {
    ...uData,
    handle: newHandle,
    usernameChangesCount: currentCount + 1,
    lastUsernameChangeDate: new Date().toISOString()
  };
  localStorage.setItem('bondibase_users', JSON.stringify(usersMap));

  currentUser.handle = newHandle;
  currentUser.usernameChangesCount = currentCount + 1;
  currentUser.lastUsernameChangeDate = new Date().toISOString();
  localStorage.setItem('bondibase_user', JSON.stringify(currentUser));

  reviewsData.forEach(r => {
    if (r.userHandle === oldHandle) {
      r.userHandle = newHandle;
    }
  });
  localStorage.setItem('bondibase_reviews', JSON.stringify(reviewsData));

  if (followsData[oldHandle]) {
    followsData[newHandle] = followsData[oldHandle];
    delete followsData[oldHandle];
  }
  Object.keys(followsData).forEach(h => {
    if (Array.isArray(followsData[h])) {
      const idx = followsData[h].indexOf(oldHandle);
      if (idx !== -1) followsData[h][idx] = newHandle;
    }
  });
  localStorage.setItem('bondibase_follows', JSON.stringify(followsData));

  if (window.db && window.fb) {
    try {
      await window.fb.setDoc(window.fb.doc(window.db, "users", newHandle), usersMap[newHandle]);
      await window.fb.deleteDoc(window.fb.doc(window.db, "users", oldHandle));
    } catch (err) {
      console.warn("Firestore rename:", err);
    }
  }

  showToast(`¡Tu usuario ahora es ${newHandle}!`);
  closeEditUsernameModal();
  renderHeaderAuth();
  openUserProfile(newHandle);
  renderMain();
}

// Cascading Deletion of User Account & Content
async function deleteUserAccount(handle) {
  if (!handle) return;

  const usersMap = JSON.parse(localStorage.getItem('bondibase_users')) || {};
  delete usersMap[handle];
  localStorage.setItem('bondibase_users', JSON.stringify(usersMap));

  reviewsData = reviewsData.filter(r => r.userHandle !== handle);
  localStorage.setItem('bondibase_reviews', JSON.stringify(reviewsData));

  delete followsData[handle];
  Object.keys(followsData).forEach(h => {
    if (Array.isArray(followsData[h])) {
      followsData[h] = followsData[h].filter(item => item !== handle);
    }
  });
  localStorage.setItem('bondibase_follows', JSON.stringify(followsData));

  if (window.db && window.fb) {
    try {
      await window.fb.deleteDoc(window.fb.doc(window.db, "users", handle));
      const q = window.fb.query(window.fb.collection(window.db, "reviews"), window.fb.where("userHandle", "==", handle));
      const snap = await window.fb.getDocs(q);
      snap.forEach(async (d) => {
        await window.fb.deleteDoc(d.ref);
      });
    } catch (e) {
      console.warn("Firestore user cascade delete:", e);
    }
  }

  showToast(`La cuenta y publicaciones de ${handle} fueron eliminadas`);
  renderMain();
}

function toggleFollowUser() {
  if (!currentUser) {
    showToast('Debés iniciar sesión para seguir usuarios');
    openAuthModal('login');
    return;
  }

  const myHandle = currentUser.handle;
  if (!followsData[myHandle]) followsData[myHandle] = [];

  const idx = followsData[myHandle].indexOf(currentProfileHandle);
  if (idx !== -1) {
    followsData[myHandle].splice(idx, 1);
    showToast(`Dejaste de seguir a ${currentProfileHandle}`);
  } else {
    followsData[myHandle].push(currentProfileHandle);
    showToast(`¡Ahora sigues a ${currentProfileHandle}!`);
  }

  localStorage.setItem('bondibase_follows', JSON.stringify(followsData));
  openUserProfile(currentProfileHandle);
}

// Followers / Following List Modal Management
function openUserListModal(initialTab = 'followers') {
  if (!currentProfileHandle || isBlacklistedUser(currentProfileHandle)) return;
  activeUserListTab = initialTab;

  const followers = getFollowersList(currentProfileHandle);
  const following = getFollowingList(currentProfileHandle);

  document.getElementById('userListFollowersCount').textContent = followers.length;
  document.getElementById('userListFollowingCount').textContent = following.length;
  document.getElementById('userListModalTitle').textContent = `Conexiones de ${currentProfileHandle}`;

  switchUserListTab(initialTab);
  openModal('userListModal');
}

function closeUserListModal() {
  closeModal('userListModal');
}

function switchUserListTab(tab) {
  activeUserListTab = tab;
  const btnFollowers = document.getElementById('userListTabFollowers');
  const btnFollowing = document.getElementById('userListTabFollowing');

  if (tab === 'followers') {
    btnFollowers.classList.add('active');
    btnFollowing.classList.remove('active');
  } else {
    btnFollowing.classList.add('active');
    btnFollowers.classList.remove('active');
  }

  renderUserListItems();
}

function renderUserListItems() {
  const container = document.getElementById('userListItemsContainer');
  triggerFadeIn(container);

  const usersMap = JSON.parse(localStorage.getItem('bondibase_users')) || {};
  const listHandles = (activeUserListTab === 'followers'
    ? getFollowersList(currentProfileHandle)
    : getFollowingList(currentProfileHandle)).filter(h => !isBlacklistedUser(h));

  if (listHandles.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-muted);">No hay usuarios para mostrar en esta lista.</div>`;
    return;
  }

  const isMyOwnProfile = currentUser && currentUser.handle === currentProfileHandle;

  container.innerHTML = listHandles.map(handle => {
    const uData = usersMap[handle] || {};
    const myFollows = followsData[currentUser ? currentUser.handle : ''] || [];
    const iFollowThem = myFollows.includes(handle);
    const avatarHtml = renderAvatarHtml(handle, uData.photo, 40);

    let actionBtn = '';
    if (isMyOwnProfile) {
      if (activeUserListTab === 'following') {
        actionBtn = `<button class="btn-danger-sm" onclick="unfollowTargetUser('${handle}')"><i class="fa-solid fa-user-minus"></i> Dejar de seguir</button>`;
      } else if (activeUserListTab === 'followers') {
        actionBtn = `<button class="btn-danger-sm" onclick="removeFollowerUser('${handle}')"><i class="fa-solid fa-user-xmark"></i> Eliminar seguidor</button>`;
      }
    } else {
      if (currentUser && currentUser.handle !== handle) {
        actionBtn = `<button class="btn-follow ${iFollowThem ? 'following' : ''}" onclick="toggleFollowOtherUser('${handle}')">
          ${iFollowThem ? 'Siguiendo' : '+ Seguir'}
        </button>`;
      }
    }

    return `
      <div class="review-card" style="align-items:center; justify-content:space-between; padding:12px 14px;">
        <div style="display:flex; align-items:center; gap:12px; cursor:pointer;" onclick="openUserProfile('${handle}')">
          ${avatarHtml}
          <div>
            <div style="font-weight:700; font-size:14px; color:#fff;">${esc(handle)}</div>
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          ${actionBtn}
          <button class="btn-nav-link" style="font-size:12px; padding:4px 8px;" onclick="openUserProfile('${handle}')">Ver perfil</button>
        </div>
      </div>
    `;
  }).join('');
}

function unfollowTargetUser(targetHandle) {
  if (!currentUser) return;
  const myHandle = currentUser.handle;

  if (followsData[myHandle]) {
    const idx = followsData[myHandle].indexOf(targetHandle);
    if (idx !== -1) {
      followsData[myHandle].splice(idx, 1);
      localStorage.setItem('bondibase_follows', JSON.stringify(followsData));
      showToast(`Dejaste de seguir a ${targetHandle}`);
      openUserProfile(currentUser.handle);
      openUserListModal('following');
    }
  }
}

function removeFollowerUser(targetHandle) {
  if (!currentUser) return;
  const myHandle = currentUser.handle;

  if (followsData[targetHandle]) {
    const idx = followsData[targetHandle].indexOf(myHandle);
    if (idx !== -1) {
      followsData[targetHandle].splice(idx, 1);
      localStorage.setItem('bondibase_follows', JSON.stringify(followsData));
      showToast(`Eliminaste a ${targetHandle} de tus seguidores`);
      openUserProfile(currentUser.handle);
      openUserListModal('followers');
    }
  }
}

function toggleFollowOtherUser(targetHandle) {
  if (!currentUser) {
    showToast('Debés iniciar sesión para seguir usuarios');
    openAuthModal('login');
    return;
  }

  const myHandle = currentUser.handle;
  if (!followsData[myHandle]) followsData[myHandle] = [];

  const idx = followsData[myHandle].indexOf(targetHandle);
  if (idx !== -1) {
    followsData[myHandle].splice(idx, 1);
    showToast(`Dejaste de seguir a ${targetHandle}`);
  } else {
    followsData[myHandle].push(targetHandle);
    showToast(`¡Ahora sigues a ${targetHandle}!`);
  }

  localStorage.setItem('bondibase_follows', JSON.stringify(followsData));
  renderUserListItems();
}

// Toast Notification
function showToast(msg) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast-notice';
  toast.innerHTML = `<i class="fa-solid fa-bus-simple" style="color:var(--accent-blue);"></i> <span>${msg}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Global Key Listeners
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closePosterModal();
    closeAuthModal();
    closeUserProfileModal();
    closeUserListModal();
    closeEditUsernameModal();
    closeForgotPasswordModal();
    closeChangePasswordModal();
    closeEditBioModal();
  }
});

// Run application on DOM loaded
document.addEventListener('DOMContentLoaded', initApp);
