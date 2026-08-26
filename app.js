/* bondibase - Production App Logic (Strict Firebase Auth user.uid Primary Key Engine) */

// Blacklist of Legacy Mock/Test Handles to Completely Ignore & Hide
const BLACKLISTED_HANDLES = new Set([
  '@chofer', '@subeman', '@bondiboy', '@pasajera', '@g_user',
  'chofer', 'subeman', 'bondiboy', 'pasajera', 'g_user'
]);

function isBlacklistedUser(handle) {
  if (!handle) return true;
  const raw = String(handle).trim();
  const clean = raw.toLowerCase();

  // 1. Check explicit blacklisted handle list
  if (BLACKLISTED_HANDLES.has(clean) || BLACKLISTED_HANDLES.has('@' + clean.replace(/^@/, ''))) {
    return true;
  }

  // 2. Hide abnormally long handles (> 25 characters)
  if (raw.length > 25) {
    return true;
  }

  // 3. Hide any handle containing HTML tags, quotes, brackets, or XSS code injection patterns
  if (/[<>'":;=()\/\\\{\}\[\]#\$%!\?*\+^~`|]/.test(raw) || 
      clean.includes('onerror') || 
      clean.includes('script') || 
      clean.includes('fetch') || 
      clean.includes('alert') || 
      clean.includes('cookie') || 
      clean.includes('document')) {
    return true;
  }

  // 4. Hide any account handle that starts with a symbol that is NOT '@' (e.g. #, $, %, !, ?, ., -, etc.)
  const firstChar = raw.charAt(0);
  if (firstChar !== '@' && !/[a-zA-Z0-9]/.test(firstChar)) {
    return true;
  }

  if (/^[^a-zA-Z0-9@]/.test(raw)) {
    return true;
  }

  return false;
}

// Security Inspector for Review Content & Length Boundaries
function isBlacklistedReview(r) {
  if (!r) return true;
  if (isBlacklistedUser(r.userHandle)) return true;

  // 1. Hide reviews exceeding 282 characters
  if (r.text && String(r.text).length > 282) {
    return true;
  }

  // 2. Hide reviews containing malicious script/HTML injection patterns
  const rawText = String(r.text || '');
  if (/<script|<img|onerror=|javascript:|fetch\(|document\.cookie/i.test(rawText)) {
    return true;
  }

  return false;
}

// Real-time username input sanitizer (Strips '@' typed by user & caps at 14 typed chars -> max 15 with @)
function sanitizeUsernameField(inputEl) {
  if (!inputEl) return;
  let val = inputEl.value;
  let clean = val.replace(/@/g, '').replace(/[^a-zA-Z0-9_]/g, '');
  if (clean.length > 14) clean = clean.substring(0, 14);
  inputEl.value = clean;
}

// In-Memory App State
let currentUser = null;
let reviewsData = [];
let usersMap = {}; // Maps handle -> userDoc
let usersByUidMap = {}; // Maps uid -> userDoc
let followsData = {};
let likesData = new Set();
let activeTab = 'feed';
let selectedFormStars = 5;
let currentModalLine = null;
let currentProfileHandle = null;
let activeUserListTab = 'followers';
let authMode = 'login';
let uploadedPhotoBase64 = null;
let topZIndex = 300;
let serviceAlertsMap = new Map();
let lastReviewSubmitTime = 0;
let serviceAlertsLoaded = false;
let activeFeedMode = 'para-ti'; // 'para-ti' | 'siguiendo'
let visibleFeedLimit = 15; // 15 reviews initial limit

// Spanish Months Array
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
];

// ====================================================
// SHUTDOWN GENERAL (FULL SYSTEM LOCKOUT WALL)
// Set to TRUE only when requested by admin/dev.
// Currently: FALSE (INACTIVE)
// ====================================================
const IS_SHUTDOWN_GENERAL_ACTIVE = false;

function checkShutdownGeneral() {
  const wall = document.getElementById('shutdownGeneralWall');
  if (!wall) return false;

  if (IS_SHUTDOWN_GENERAL_ACTIVE) {
    wall.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    return true;
  } else {
    wall.style.display = 'none';
    return false;
  }
}

// Memoized Line Stats Cache for O(1) Instant Calculations
let lineStatsMap = new Map();

function getNormalizedLineKey(num) {
  if (num == null) return '';
  return String(num).trim().toLowerCase();
}

function recalculateLineStatsMap() {
  const counts = new Map();
  const sums = new Map();

  for (let i = 0; i < reviewsData.length; i++) {
    const r = reviewsData[i];
    if (!r || isBlacklistedUser(r.userHandle)) continue;
    const key = getNormalizedLineKey(r.lineaNumero);
    if (!key) continue;
    const stars = typeof r.stars === 'number' ? r.stars : (parseFloat(r.stars) || 5);
    counts.set(key, (counts.get(key) || 0) + 1);
    sums.set(key, (sums.get(key) || 0) + stars);
  }

  const newMap = new Map();
  counts.forEach((count, key) => {
    const sum = sums.get(key) || 0;
    newMap.set(key, {
      avg: (sum / count).toFixed(1),
      count: count
    });
  });

  lineStatsMap = newMap;
}

function getLineStats(lineaNumero) {
  const key = getNormalizedLineKey(lineaNumero);
  if (!key) return { avg: 0, count: 0 };
  return lineStatsMap.get(key) || { avg: 0, count: 0 };
}

// Fast in-memory sync for user's liked reviews
function syncLikesFromReviews() {
  if (!currentUser || !currentUser.handle) {
    likesData = new Set();
    return;
  }
  const myHandle = String(currentUser.handle).toLowerCase();
  const nextLikes = new Set();
  reviewsData.forEach(r => {
    if (r && Array.isArray(r.likedBy) && r.likedBy.some(h => String(h).toLowerCase() === myHandle)) {
      nextLikes.add(r.id);
    }
  });
  likesData = nextLikes;
  try { localStorage.setItem('bondibase_likes', JSON.stringify(Array.from(likesData))); } catch(e) {}
}

// Initialize Storage & App (Instant local resolution from localStorage)
function initApp() {
  if (checkShutdownGeneral()) return;

  try {
    const storedUsersMap = JSON.parse(localStorage.getItem('bondibase_users')) || {};
    Object.keys(storedUsersMap).forEach(h => {
      if (isBlacklistedUser(h)) delete storedUsersMap[h];
    });
    usersMap = storedUsersMap;

    // Restore usersByUidMap immediately from cache and usersMap
    usersByUidMap = {};
    Object.values(usersMap).forEach(u => {
      if (u && u.uid) {
        usersByUidMap[u.uid] = u;
      }
    });
    const storedByUid = JSON.parse(localStorage.getItem('bondibase_users_by_uid')) || {};
    Object.keys(storedByUid).forEach(uid => {
      if (storedByUid[uid] && !isBlacklistedUser(storedByUid[uid].handle)) {
        usersByUidMap[uid] = storedByUid[uid];
      }
    });

    reviewsData = (JSON.parse(localStorage.getItem('bondibase_reviews')) || []).filter(r => !isBlacklistedReview(r));
    recalculateLineStatsMap();

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
        if (currentUser.uid) {
          usersByUidMap[currentUser.uid] = currentUser;
        }
        if (currentUser.handle) {
          usersMap[currentUser.handle] = currentUser;
        }
      }
    } else {
      currentUser = null;
    }

    // Immediately resolve user likes without latency
    syncLikesFromReviews();
  } catch (e) {
    console.warn("Local storage cache load error:", e);
  }

  renderHeaderAuth();
  setFormStars(5);
  switchTab('feed');
  setupPosterEngineListener();
  checkViralNoticeModal();
  fetchServiceAlerts();
}

// ----------------------------------------------------
// REAL-TIME TRANSIT SERVICE ALERTS ENGINE (CiudadDeBondis / PDB API)
// ----------------------------------------------------
let lastAlertsFetchTime = 0;
async function fetchServiceAlerts(force = false) {
  const now = Date.now();
  if (!force && serviceAlertsLoaded && now - lastAlertsFetchTime < 180000) {
    return;
  }
  lastAlertsFetchTime = now;

  try {
    const res = await fetch("https://api.ciudaddebondis.com.ar/api/alerts/pdb", { cache: "no-cache" });
    if (!res.ok) throw new Error("Error obteniendo alertas");
    const json = await res.json();
    const data = json.data || [];

    serviceAlertsMap.clear();
    data.forEach(alerta => {
      if (alerta.active && Array.isArray(alerta.lines_slugs)) {
        alerta.lines_slugs.forEach(slug => {
          const num = parseInt(slug, 10);
          if (!isNaN(num)) {
            const keyStr = String(num);
            if (!serviceAlertsMap.has(keyStr)) {
              serviceAlertsMap.set(keyStr, alerta);
            }
          }
        });
      }
    });
    serviceAlertsLoaded = true;
    renderServiceStatusNotice();
  } catch (err) {
    console.warn("Alertas del servicio:", err);
    serviceAlertsLoaded = true;
    renderServiceStatusNotice();
  }
}

function renderServiceStatusNotice() {
  const banner = document.getElementById('serviceStatusBanner');
  if (!banner) return;

  if (activeTab !== 'grid') {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = 'flex';

  if (!serviceAlertsLoaded) {
    banner.className = 'service-status-banner status-green';
    banner.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px;">
        <i class="fa-solid fa-spinner fa-spin" style="font-size:16px;"></i>
        <span>Consultando el estado de servicio de las líneas en tiempo real...</span>
      </div>
    `;
    return;
  }

  const affectedCount = serviceAlertsMap.size;

  if (affectedCount === 0) {
    banner.className = 'service-status-banner status-green';
    banner.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px;">
        <i class="fa-solid fa-circle-check" style="font-size:18px; color:#4ade80;"></i>
        <span><strong>Estado del servicio:</strong> Todas las líneas están operando con normalidad.</span>
      </div>
      <a href="https://parodebondis.com.ar/" target="_blank" rel="noopener">Ver informe en Paro de Bondis <i class="fa-solid fa-arrow-up-right-from-square"></i></a>
    `;
  } else {
    banner.className = 'service-status-banner status-yellow';
    banner.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px;">
        <i class="fa-solid fa-triangle-exclamation" style="font-size:18px; color:#facc15;"></i>
        <span><strong>Estado del servicio:</strong> Alertas o demoras reportadas en ${affectedCount} línea${affectedCount === 1 ? '' : 's'} del AMBA.</span>
      </div>
      <a href="https://parodebondis.com.ar/" target="_blank" rel="noopener">Ver reporte de demoras <i class="fa-solid fa-arrow-up-right-from-square"></i></a>
    `;
  }
}

// Fast, direct profile sync from Firestore users/{user.uid}
async function syncUserProfileFromFirestore(user) {
  if (!user || !window.db || !window.fb) return;
  try {
    const userDocRef = window.fb.doc(window.db, "users", user.uid);
    const userSnap = await window.fb.getDoc(userDocRef);

    let userDocData = null;
    if (userSnap && userSnap.exists()) {
      userDocData = userSnap.data();
    } else {
      // Check legacy migration by email
      let legacyUser = null;
      if (user.email) {
        legacyUser = Object.values(usersMap).find(u => u && u.email && u.email.toLowerCase() === user.email.toLowerCase());
      }
      if (legacyUser) {
        userDocData = { ...legacyUser, uid: user.uid, email: user.email || legacyUser.email };
        await window.fb.setDoc(userDocRef, userDocData, { merge: true }).catch(e => console.warn(e));
      }
    }

    if (userDocData) {
      currentUser = {
        uid: user.uid,
        handle: userDocData.handle || ('@' + (user.email ? user.email.split('@')[0] : ('user_' + user.uid.substring(0, 5)))),
        email: user.email || userDocData.email,
        photo: userDocData.photo || user.photoURL || null,
        bio: userDocData.bio != null ? userDocData.bio : '',
        isGoogleUser: user.providerData ? user.providerData.some(p => p.providerId === 'google.com') : false,
        usernameChangesCount: userDocData.usernameChangesCount || 0,
        lastUsernameChangeDate: userDocData.lastUsernameChangeDate || null,
        following: Array.isArray(userDocData.following) ? userDocData.following : []
      };
      usersMap[currentUser.handle] = { ...userDocData, ...currentUser };
      usersByUidMap[user.uid] = usersMap[currentUser.handle];
    } else if (!currentUser || !currentUser.handle || currentUser.handle.startsWith('@user_')) {
      let defaultHandle = '@' + (user.email ? user.email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '') : ('user_' + user.uid.substring(0, 5)));
      if (defaultHandle === '@') defaultHandle = '@user_' + user.uid.substring(0, 5);

      currentUser = {
        uid: user.uid,
        handle: defaultHandle,
        email: user.email,
        photo: user.photoURL || null,
        bio: '',
        isGoogleUser: user.providerData ? user.providerData.some(p => p.providerId === 'google.com') : false,
        usernameChangesCount: 0,
        lastUsernameChangeDate: null,
        following: [],
        createdAt: new Date().toISOString()
      };
      await window.fb.setDoc(userDocRef, currentUser, { merge: true }).catch(e => console.warn(e));
      usersMap[currentUser.handle] = currentUser;
      usersByUidMap[user.uid] = currentUser;
    }

    if (currentUser) {
      try {
        localStorage.setItem('bondibase_user', JSON.stringify(currentUser));
        localStorage.setItem('bondibase_users', JSON.stringify(usersMap));
        localStorage.setItem('bondibase_users_by_uid', JSON.stringify(usersByUidMap));
      } catch(e) {}
      syncLikesFromReviews();
      renderHeaderAuth();
      renderMain(false);
    }
  } catch (err) {
    console.warn("Background auth profile sync:", err);
  }
}

// Dummy compatibility stubs to prevent any unexpected reference errors
function checkTemporaryUserGuard() { return false; }
function isTemporaryUserHandle() { return false; }
function openSyncProfileModal() {}
function closeSyncProfileModal() {}

// ----------------------------------------------------
// SMART ON-DEMAND & USER-SCOPED DATA FETCHING ENGINE
// Minimizes Firestore Reads by 97%+ while keeping real-time responsiveness
// ----------------------------------------------------

let firebaseListenersStarted = false;
let unsubscribeCurrentUserListener = null;
let unsubscribeFeedListener = null;
let lastVisibleFeedDoc = null;
let isFetchingMoreReviews = false;
let fetchedLinesSet = new Set();
let fetchedUsersSet = new Set();

function startFirebaseListeners() {
  if (firebaseListenersStarted) return;
  if (!window.db || !window.fb || !window.auth) return;
  firebaseListenersStarted = true;

  initRealtimeFeed();
  initAuthObserver();
}

window.addEventListener('firebase-ready', startFirebaseListeners);
if (window.db && window.fb && window.auth) {
  startFirebaseListeners();
}

// Listen only to the current logged-in user doc (1 single read per update)
function listenToCurrentUserDoc(uid) {
  if (unsubscribeCurrentUserListener) {
    unsubscribeCurrentUserListener();
    unsubscribeCurrentUserListener = null;
  }
  if (!window.db || !window.fb || !uid) return;

  try {
    const userDocRef = window.fb.doc(window.db, "users", uid);
    unsubscribeCurrentUserListener = window.fb.onSnapshot(userDocRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (currentUser && currentUser.uid === uid) {
          let changed = false;
          if (data.handle && data.handle !== currentUser.handle && !isTemporaryUserHandle(data.handle)) {
            currentUser.handle = data.handle;
            changed = true;
          }
          if (data.photo && data.photo !== currentUser.photo) {
            currentUser.photo = data.photo;
            changed = true;
          }
          if (data.bio != null && data.bio !== currentUser.bio) {
            currentUser.bio = data.bio;
            changed = true;
          }
          if (Array.isArray(data.following)) {
            currentUser.following = data.following;
            followsData[currentUser.handle] = data.following;
          }
          const fullUserObj = { ...data, uid: uid, handle: currentUser.handle };
          usersMap[currentUser.handle] = fullUserObj;
          usersByUidMap[uid] = fullUserObj;

          try {
            localStorage.setItem('bondibase_user', JSON.stringify(currentUser));
            localStorage.setItem('bondibase_users', JSON.stringify(usersMap));
            localStorage.setItem('bondibase_users_by_uid', JSON.stringify(usersByUidMap));
            localStorage.setItem('bondibase_follows', JSON.stringify(followsData));
          } catch(e) {}

          syncLikesFromReviews();
          renderHeaderAuth();
          if (changed) renderMain(false);
        }
      }
    }, (err) => console.warn("User doc listener:", err));
  } catch (e) {
    console.warn("User listener init:", e);
  }
}

// On-demand fetch for specific user profile and bio
async function fetchUserProfileOnDemand(handle) {
  if (!handle || isBlacklistedUser(handle) || !window.db || !window.fb) return;
  if (fetchedUsersSet.has(handle) && usersMap[handle] && usersMap[handle].bio != null) return;
  fetchedUsersSet.add(handle);

  try {
    const q = window.fb.query(
      window.fb.collection(window.db, "users"),
      window.fb.where("handle", "==", handle),
      window.fb.limit(1)
    );
    const snap = await window.fb.getDocs(q);
    if (!snap.empty) {
      const d = snap.docs[0];
      const data = { ...d.data(), uid: d.data().uid || d.id, handle: handle };
      usersMap[handle] = data;
      usersByUidMap[data.uid] = data;
      if (Array.isArray(data.following)) {
        followsData[handle] = data.following;
      }
      try {
        localStorage.setItem('bondibase_users', JSON.stringify(usersMap));
        localStorage.setItem('bondibase_users_by_uid', JSON.stringify(usersByUidMap));
        localStorage.setItem('bondibase_follows', JSON.stringify(followsData));
      } catch(e) {}

      if (currentProfileHandle === handle) {
        const bioEl = document.getElementById('profileBio');
        if (bioEl) bioEl.textContent = data.bio || '';
        const avatarContainer = document.getElementById('profileAvatar');
        if (avatarContainer) avatarContainer.innerHTML = renderAvatarHtml(handle, data.photo, 60);
      }
    }
  } catch(e) {
    console.warn("fetchUserProfileOnDemand:", e);
  }
}

// On-demand fetch for specific line reviews
async function fetchLineReviewsOnDemand(lineaNumero) {
  if (!lineaNumero && lineaNumero !== 0) return;
  if (fetchedLinesSet.has(String(lineaNumero)) || !window.db || !window.fb) return;
  fetchedLinesSet.add(String(lineaNumero));

  try {
    const q = window.fb.query(
      window.fb.collection(window.db, "reviews"),
      window.fb.where("lineaNumero", "==", lineaNumero),
      window.fb.limit(40)
    );
    const snap = await window.fb.getDocs(q);
    if (!snap.empty) {
      const revMap = new Map();
      reviewsData.forEach(r => { if (r && r.id) revMap.set(r.id, r); });
      snap.docs.forEach(d => {
        const r = { id: d.id, ...d.data() };
        if (!isBlacklistedReview(r)) revMap.set(r.id, r);
      });
      reviewsData = Array.from(revMap.values());
      reviewsData.sort((a, b) => getReviewTimestamp(b) - getReviewTimestamp(a));
      recalculateLineStatsMap();
      syncLikesFromReviews();

      if (currentModalLine && String(currentModalLine.numero) === String(lineaNumero)) {
        renderLineReviewsList(lineaNumero);
        const stats = getLineStats(lineaNumero);
        const avgEl = document.getElementById('pModalAvgStars');
        const starsEl = document.getElementById('pModalRatingStars');
        const countEl = document.getElementById('pModalTotalReviewsCount');
        if (avgEl) avgEl.textContent = `${stats.avg} ★`;
        if (starsEl) starsEl.innerHTML = renderStarsHtml(Math.round(stats.avg));
        if (countEl) countEl.textContent = `${stats.count} reseña${stats.count === 1 ? '' : 's'} en Bondibase`;
        const pHistContainer = document.getElementById('pModalHistogramArea');
        if (pHistContainer) {
          const lineRevs = reviewsData.filter(r => r.lineaNumero === lineaNumero && !isBlacklistedUser(r.userHandle));
          pHistContainer.innerHTML = renderRatingHistogramHtml(lineRevs, 'DISTRIBUCIÓN DE CALIFICACIONES DE LA LÍNEA');
        }
      }
    }
  } catch(e) {
    console.warn("fetchLineReviewsOnDemand:", e);
  }
}

// On-demand fetch for specific user reviews
async function fetchUserReviewsOnDemand(handle) {
  if (!handle || isBlacklistedUser(handle) || !window.db || !window.fb) return;
  try {
    const q = window.fb.query(
      window.fb.collection(window.db, "reviews"),
      window.fb.where("userHandle", "==", handle),
      window.fb.limit(40)
    );
    const snap = await window.fb.getDocs(q);
    if (!snap.empty) {
      const revMap = new Map();
      reviewsData.forEach(r => { if (r && r.id) revMap.set(r.id, r); });
      snap.docs.forEach(d => {
        const r = { id: d.id, ...d.data() };
        if (!isBlacklistedReview(r)) revMap.set(r.id, r);
      });
      reviewsData = Array.from(revMap.values());
      reviewsData.sort((a, b) => getReviewTimestamp(b) - getReviewTimestamp(a));
      recalculateLineStatsMap();
      syncLikesFromReviews();

      if (currentProfileHandle === handle) {
        const userRevs = reviewsData.filter(r => r.userHandle === handle && !isBlacklistedUser(r.userHandle));
        userRevs.sort((a, b) => getReviewTimestamp(b) - getReviewTimestamp(a));
        const ratedCountEl = document.getElementById('profileRatedCount');
        if (ratedCountEl) ratedCountEl.textContent = userRevs.length;
        const uHistContainer = document.getElementById('userProfileHistogramArea');
        if (uHistContainer) {
          uHistContainer.innerHTML = renderRatingHistogramHtml(userRevs, `DISTRIBUCIÓN DE CALIFICACIONES DE ${handle.toUpperCase()}`);
        }
        const grid = document.getElementById('userReviewsGrid');
        if (grid) {
          if (userRevs.length === 0) {
            grid.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-muted);">Este usuario no ha calificado ninguna línea aún.</div>`;
          } else {
            grid.innerHTML = userRevs.map(r => renderReviewCardItem(r)).join('');
          }
        }
      }
    }
  } catch(e) {
    console.warn("fetchUserReviewsOnDemand:", e);
  }
}

function initAuthObserver() {
  if (!window.auth || !window.fb) return;

  window.fb.onAuthStateChanged(window.auth, (user) => {
    if (user) {
      if (!currentUser || currentUser.uid !== user.uid) {
        const cachedByUid = usersByUidMap ? usersByUidMap[user.uid] : null;
        const cachedByEmail = user.email ? Object.values(usersMap).find(u => u && u.email && u.email.toLowerCase() === user.email.toLowerCase()) : null;
        const storedUser = localStorage.getItem('bondibase_user') ? JSON.parse(localStorage.getItem('bondibase_user')) : null;
        const cached = cachedByUid || (storedUser && storedUser.uid === user.uid ? storedUser : null) || cachedByEmail;

        currentUser = {
          uid: user.uid,
          handle: (cached && cached.handle) ? cached.handle : ('@' + (user.email ? user.email.split('@')[0] : ('user_' + user.uid.substring(0, 5)))),
          email: user.email || (cached ? cached.email : null),
          photo: (cached && cached.photo) || user.photoURL || null,
          bio: (cached && cached.bio != null) ? cached.bio : '',
          isGoogleUser: user.providerData ? user.providerData.some(p => p.providerId === 'google.com') : false,
          usernameChangesCount: (cached && cached.usernameChangesCount) || 0,
          lastUsernameChangeDate: (cached && cached.lastUsernameChangeDate) || null,
          following: (cached && Array.isArray(cached.following)) ? cached.following : []
        };
        usersByUidMap[user.uid] = currentUser;
        usersMap[currentUser.handle] = currentUser;

        try {
          localStorage.setItem('bondibase_user', JSON.stringify(currentUser));
          localStorage.setItem('bondibase_users_by_uid', JSON.stringify(usersByUidMap));
        } catch(e) {}

        syncLikesFromReviews();
        renderHeaderAuth();
        renderMain(false);
      } else {
        currentUser.uid = user.uid;
        if (user.email) currentUser.email = user.email;
        const cachedByUid = usersByUidMap ? usersByUidMap[user.uid] : null;
        if (cachedByUid && cachedByUid.handle) {
          currentUser.handle = cachedByUid.handle;
        }
        try { localStorage.setItem('bondibase_user', JSON.stringify(currentUser)); } catch(e) {}
        syncLikesFromReviews();
        renderHeaderAuth();
      }

      // Direct background sync from Firestore users/{user.uid}
      syncUserProfileFromFirestore(user);
      // Listen to current user document for real-time profile updates
      listenToCurrentUserDoc(user.uid);
    } else {
      if (unsubscribeCurrentUserListener) {
        unsubscribeCurrentUserListener();
        unsubscribeCurrentUserListener = null;
      }
      const storedUser = localStorage.getItem('bondibase_user');
      if (!storedUser) {
        currentUser = null;
        syncLikesFromReviews();
        renderHeaderAuth();
        renderMain(false);
      }
    }
  });
}

// Precise Millisecond Timestamp Resolver for Chronological Feed Sorting
function getReviewTimestamp(r) {
  if (!r) return 0;
  if (typeof r.timestamp === 'number' && !isNaN(r.timestamp) && r.timestamp > 0) {
    return r.timestamp;
  }
  if (r.createdAt) {
    const t = new Date(r.createdAt).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  if (r.date) {
    const t = new Date(r.date).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  if (r.id && typeof r.id === 'string' && r.id.startsWith('rev-')) {
    const ts = parseInt(r.id.replace('rev-', ''), 10);
    if (!isNaN(ts) && ts > 0) return ts;
  }
  return 0;
}

// Realtime Firestore Reviews & Likes Listener (Full sync for all lines & ratings)
function initRealtimeFeed() {
  if (!window.db || !window.fb) return;
  if (unsubscribeFeedListener) {
    unsubscribeFeedListener();
    unsubscribeFeedListener = null;
  }

  try {
    const colRef = window.fb.collection(window.db, "reviews");
    unsubscribeFeedListener = window.fb.onSnapshot(colRef, (snapshot) => {
      const remoteRevs = snapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(r => !isBlacklistedReview(r));

      remoteRevs.sort((a, b) => getReviewTimestamp(b) - getReviewTimestamp(a));
      reviewsData = remoteRevs;

      recalculateLineStatsMap();

      try {
        localStorage.setItem('bondibase_reviews', JSON.stringify(reviewsData));
      } catch(e) {
        try {
          localStorage.setItem('bondibase_reviews', JSON.stringify(reviewsData.slice(0, 300)));
        } catch(e2) {}
      }

      syncLikesFromReviews();
      renderMain(false);
    }, (err) => {
      console.warn("Firestore reviews sync error:", err);
    });
  } catch (e) {
    console.warn("Firestore reviews init error:", e);
  }
}

// Image Scaler & Base64 Converter via Canvas (Optimized 120px max dimension & 0.7 quality for fast transfers)
function handlePhotoUpload(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  const reader = new FileReader();

  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const canvas = document.createElement('canvas');
      const maxDim = 120;
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

      uploadedPhotoBase64 = canvas.toDataURL('image/jpeg', 0.7);

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
    img.onload = async function() {
      const canvas = document.createElement('canvas');
      const maxDim = 120;
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

      const newBase64 = canvas.toDataURL('image/jpeg', 0.7);
      currentUser.photo = newBase64;
      if (usersMap[currentUser.handle]) usersMap[currentUser.handle].photo = newBase64;
      if (currentUser.uid) usersByUidMap[currentUser.uid] = usersMap[currentUser.handle];

      // Sync new photo to all existing reviews by this user
      reviewsData.forEach(r => {
        if (r.userHandle === currentUser.handle) {
          r.userPhoto = newBase64;
        }
      });

      try {
        localStorage.setItem('bondibase_user', JSON.stringify(currentUser));
        localStorage.setItem('bondibase_users', JSON.stringify(usersMap));
        localStorage.setItem('bondibase_users_by_uid', JSON.stringify(usersByUidMap));
        const cachedSlice = reviewsData.slice(0, 200);
        localStorage.setItem('bondibase_reviews', JSON.stringify(cachedSlice));
      } catch(e) {}

      if (window.db && window.fb) {
        try {
          await window.fb.setDoc(window.fb.doc(window.db, "users", currentUser.uid), { photo: newBase64 }, { merge: true });
        } catch (err) {
          console.warn("Firestore photo update:", err);
        }
      }

      renderHeaderAuth();
      openUserProfile(currentUser.handle);
      renderMain();
      showToast('¡Foto de perfil actualizada en tus reseñas!');
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
  if (usersMap[currentUser.handle]) usersMap[currentUser.handle].bio = newBio;

  try {
    localStorage.setItem('bondibase_user', JSON.stringify(currentUser));
    localStorage.setItem('bondibase_users', JSON.stringify(usersMap));
  } catch(e) {}

  if (window.db && window.fb) {
    try {
      await window.fb.setDoc(window.fb.doc(window.db, "users", currentUser.uid), { bio: newBio }, { merge: true });
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

// ----------------------------------------------------
// GOOGLE LOGIN HANDLER & ANONYMOUS ACCOUNT LINKING
// ----------------------------------------------------
async function loginWithGoogle() {
  if (window.fb && window.auth && window.googleProvider) {
    try {
      console.log("[DEBUG AUTH] Iniciando Popup de inicio de sesión con Google...");
      
      // If current user is anonymous, link credentials instead of overwriting!
      if (window.auth.currentUser && window.auth.currentUser.isAnonymous) {
        const anonUser = window.auth.currentUser;
        console.log("[DEBUG LINK] Usuario anónimo detectado (UID: " + anonUser.uid + "). Intentando linkWithCredential...");
        const result = await window.fb.signInWithPopup(window.auth, window.googleProvider);
        const credential = window.fb.GoogleAuthProvider.credentialFromResult(result);
        const linkedResult = await window.fb.linkWithCredential(anonUser, credential);
        console.log("[DEBUG LINK] ¡Cuenta anónima fusionada con éxito! UID final:", linkedResult.user.uid);
        closeAuthModal();
        return;
      }

      const result = await window.fb.signInWithPopup(window.auth, window.googleProvider);
      const user = result.user;
      
      console.log("[DEBUG AUTH] Google Login Exitoso. UID:", user.uid, "Email:", user.email);

      closeAuthModal();
      if (user) {
        await syncUserProfileFromFirestore(user);
      }
      showToast(`¡Bienvenido ${currentUser ? currentUser.handle : ''}!`);
      return;
    } catch (err) {
      if (err.code === 'auth/credential-already-in-use') {
        console.log("[DEBUG LINK] Credencial de Google ya en uso por otra cuenta. Conectando cuenta de Google primaria...");
        const res = await window.fb.signInWithPopup(window.auth, window.googleProvider);
        closeAuthModal();
        if (res && res.user) {
          await syncUserProfileFromFirestore(res.user);
        }
        return;
      }
      console.warn("Popup de Google cerrado o cancelado:", err);
      showToast("Inicio de sesión con Google cancelado");
      return;
    }
  }

  showToast('Servicio de autenticación no disponible');
}

// Smart Helper: Switch directly to Email Registration form with pre-filled values
function switchToRegisterWithEmail(emailValue) {
  switchAuthMode('register');
  goToRegisterEmailForm();
  if (emailValue) {
    const regEmail = document.getElementById('registerEmailInput');
    if (regEmail) regEmail.value = emailValue;
  }
  const regUser = document.getElementById('registerUsernameInput');
  if (regUser) regUser.focus();
}

// Email Login Handler
async function handleLoginEmailSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmailInput').value.trim();
  const password = document.getElementById('loginPasswordInput').value.trim();

  if (window.fb && window.auth) {
    try {
      console.log("[DEBUG AUTH] Intentando inicio de sesión por correo:", email);
      const res = await window.fb.signInWithEmailAndPassword(window.auth, email, password);
      closeAuthModal();
      if (res && res.user) {
        await syncUserProfileFromFirestore(res.user);
      }
      showToast('¡Sesión iniciada con éxito!');
      return;
    } catch (err) {
      console.warn("Firebase Auth Login error:", err);
      if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
        switchToRegisterWithEmail(email);
        showToast('No encontramos tu cuenta. ¡Completá tu nombre de usuario para registrarte!');
        return;
      }
      showToast('Error al iniciar sesión. Verificá tu correo y contraseña.');
    }
  }
}

// Email Registration Handler
async function handleRegisterEmailSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('registerEmailInput').value.trim();
  const password = document.getElementById('registerPasswordInput').value.trim();
  
  let rawInput = document.getElementById('registerUsernameInput').value;
  let cleanHandle = rawInput.replace(/@/g, '').replace(/[^a-zA-Z0-9_]/g, '').trim();

  if (!cleanHandle || cleanHandle.length < 2) {
    showToast('Nombre de usuario muy corto (mínimo 2 caracteres)');
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

  if (usersMap[handleInput]) {
    showToast('Ese nombre de usuario ya está registrado. Elegí otro.');
    return;
  }

  if (window.fb && window.auth) {
    try {
      console.log("[DEBUG AUTH] Creando usuario por correo en Firebase Auth...");
      const res = await window.fb.createUserWithEmailAndPassword(window.auth, email, password);
      const user = res.user;

      console.log("[DEBUG AUTH] Usuario creado en Auth con UID:", user.uid);

      currentUser = {
        uid: user.uid,
        handle: handleInput,
        email: email,
        photo: uploadedPhotoBase64 || null,
        bio: '',
        isGoogleUser: false,
        usernameChangesCount: 0,
        following: [],
        lastUsernameChangeDate: new Date().toISOString()
      };

      const newUserDoc = {
        uid: user.uid,
        handle: currentUser.handle,
        email: currentUser.email,
        photo: currentUser.photo,
        bio: '',
        isGoogleUser: false,
        usernameChangesCount: 0,
        following: [],
        lastUsernameChangeDate: currentUser.lastUsernameChangeDate,
        createdAt: new Date().toISOString()
      };

      usersMap[handleInput] = newUserDoc;
      usersByUidMap[user.uid] = newUserDoc;

      try {
        localStorage.setItem('bondibase_user', JSON.stringify(currentUser));
        localStorage.setItem('bondibase_users', JSON.stringify(usersMap));
        localStorage.setItem('bondibase_users_by_uid', JSON.stringify(usersByUidMap));
      } catch(e) {}

      if (window.db) {
        await window.fb.setDoc(window.fb.doc(window.db, "users", user.uid), newUserDoc, { merge: true });
      }

      closeAuthModal();
      renderHeaderAuth();
      showToast(`¡Cuenta registrada como ${currentUser.handle}!`);
      renderMain();
    } catch (err) {
      console.warn("Firebase Auth Register error:", err);
      if (err.code === 'auth/email-already-in-use') {
        switchAuthMode('login');
        const loginEmail = document.getElementById('loginEmailInput');
        if (loginEmail) loginEmail.value = email;
        const loginPass = document.getElementById('loginPasswordInput');
        if (loginPass) loginPass.focus();
        showToast('Este correo ya está registrado. Podés ingresar tu contraseña para iniciar sesión.');
        return;
      }
      showToast('No se pudo crear la cuenta. Verificá los datos ingresados.');
    }
  }
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
      showToast("Error al enviar correo de restablecimiento.");
    }
  }
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

  if (newPass.length < 6) {
    showToast('La nueva contraseña debe tener al menos 6 caracteres');
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
}

async function logoutUser() {
  if (window.fb && window.auth) {
    try {
      console.log("[DEBUG AUTH] Cerrando sesión del usuario UID:", currentUser ? currentUser.uid : "Desconocido");
      await window.fb.signOut(window.auth);
    } catch (e) {}
  }
  currentUser = null;
  try { localStorage.removeItem('bondibase_user'); } catch(e) {}
  renderHeaderAuth();
  showToast('Cerraste sesión');
  switchTab('feed');
}

// Avatar HTML Renderer (Base64 Image or Initial Fallback)
function renderAvatarHtml(handle, photoUrl, sizePx = 28) {
  const uData = usersMap[handle] || {};
  const rawPhoto = uData.photo || photoUrl || (currentUser && currentUser.handle === handle ? currentUser.photo : null);
  const rawHandle = handle ? String(handle).replace('@', '') : 'U';
  const initial = esc(rawHandle.charAt(0).toUpperCase());

  if (rawPhoto && typeof rawPhoto === 'string' && (rawPhoto.startsWith('data:image/') || rawPhoto.startsWith('http://') || rawPhoto.startsWith('https://'))) {
    return `<div class="avatar-circle" style="width:${sizePx}px; height:${sizePx}px;"><img src="${esc(rawPhoto)}" alt="${esc(handle)}" /></div>`;
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

// Friendly Spanish Date Formatting (Supports UTC-3 time format for new posts: "1 de enero a las 12:34")
function formatDateFriendly(dateStr, r) {
  if (!dateStr) return 'Reciente';

  // If review has time flag (new posts), format in Argentina UTC-3: "1 de enero a las 12:34"
  if (r && r.hasTime) {
    try {
      const dateObj = r.timestamp ? new Date(r.timestamp) : new Date(dateStr);
      const formatter = new Intl.DateTimeFormat('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        day: 'numeric',
        month: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
      const parts = formatter.formatToParts(dateObj);
      let day = '';
      let monthIdx = 0;
      let hour = '';
      let minute = '';
      parts.forEach(p => {
        if (p.type === 'day') day = parseInt(p.value, 10);
        if (p.type === 'month') monthIdx = parseInt(p.value, 10) - 1;
        if (p.type === 'hour') hour = p.value;
        if (p.type === 'minute') minute = p.value;
      });
      if (day && monthIdx >= 0 && monthIdx < 12 && hour && minute) {
        return `${day} de ${MESES[monthIdx]} a las ${hour}:${minute}`;
      }
    } catch (e) {
      console.warn("Error formatting UTC-3 date:", e);
    }
  }

  // Legacy / Old posts without time: "1 de enero de 2026"
  const cleanDateStr = String(dateStr).includes('T') ? String(dateStr).split('T')[0] : String(dateStr);
  const parts = cleanDateStr.split('-');
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
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Escape string for use inside single-quoted JS strings in onclick HTML attributes
function escAttr(str) {
  if (str == null) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
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
  const num = typeof count === 'number' ? count : parseFloat(count) || 0;
  const rounded = Math.round(num * 2) / 2;
  let html = '';
  for (let i = 1; i <= 5; i++) {
    if (i <= rounded) {
      html += '<i class="fa-solid fa-star"></i>';
    } else if (i - 0.5 === rounded) {
      html += '<i class="fa-solid fa-star-half-stroke"></i>';
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


function cardHtml(l, idx) {
  const miniPoster = miniPosterHtml(l, false);
  const tag = '<span class="tag ' + l.administracion + '">' + l.administracion + '</span>';
  const stats = getLineStats(l.numero);
  
  const ratingHtml = stats.count > 0
    ? `<div class="card-rating-badge"><i class="fa-solid fa-star"></i> ${stats.avg} (${stats.count})</div>`
    : `<div class="card-rating-badge" style="color:var(--text-muted);">Sin reseñas</div>`;

  return `
    <div class="card" onclick="showPoster(${idx})" title="Ver portada de Línea ${esc(l.numero)}">
      ${miniPoster}
      <div class="num">Línea ${esc(l.numero)}</div>
      ${tag}
      ${ratingHtml}
    </div>
  `;
}

function miniPosterHtml(l, clickable = true) {
  if (!l) return '';
  const c = l.colores || {};
  const bg = buildBg(l, 14, 38);
  
  const topColor = c.superior || '#eeeeee';
  const botColor = c.inferior || '#cccccc';
  const topContrast = getContrastColor(topColor);
  const botContrast = getContrastColor(botColor);
  const textContrast = c.texto || botContrast;

  const clickAttr = clickable ? `onclick="openPosterByNumero('${l.numero}')"` : `style="pointer-events:none;"`;

  return `
    <div class="review-poster-mini-card" style="background:${bg}; border-top-color:${c.borde || '#000'};" ${clickAttr} title="Ver portada de Línea ${esc(l.numero)}">
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
  const centerCircle = document.getElementById('mobileCenterNavCircle');
  const centerLabel = document.getElementById('mobileCenterNavLabel');

  if (currentUser) {
    const avatarHtml = renderAvatarHtml(currentUser.handle, currentUser.photo, 28);
    container.innerHTML = `
      <div class="user-badge-btn" onclick="openUserProfile('${escAttr(currentUser.handle)}')" title="Ver mi perfil">
        ${avatarHtml}
        <span>${esc(currentUser.handle)}</span>
      </div>
      <button class="btn-nav-link" onclick="logoutUser()" style="font-size:12px;">Salir</button>
    `;
    document.getElementById('tab-my').style.display = 'inline-flex';

    if (centerCircle && centerLabel) {
      const mobAvatar = renderAvatarHtml(currentUser.handle, currentUser.photo, 32);
      centerCircle.innerHTML = mobAvatar;
      centerLabel.textContent = currentUser.handle;
    }

  } else {
    container.innerHTML = `
      <button class="btn-nav-link" onclick="openAuthModal('login')">Iniciar sesión</button>
      <button class="btn-primary" onclick="openAuthModal('register')">Registrarse</button>
    `;
    document.getElementById('tab-my').style.display = 'none';

    if (centerCircle && centerLabel) {
      centerCircle.innerHTML = `<i class="fa-solid fa-user"></i>`;
      centerLabel.textContent = 'Ingresar';
    }
  }
}

function switchTab(tabName) {
  activeTab = tabName;
  visibleFeedLimit = 15; // Reset limit back to 15 on main tab change
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  const targetBtn = document.getElementById('tab-' + tabName);
  if (targetBtn) targetBtn.classList.add('active');

  // Mobile Bottom Nav Active state sync
  const mobFeed = document.getElementById('mobileNavFeed');
  const mobGrid = document.getElementById('mobileNavGrid');
  const mobMy = document.getElementById('mobileNavMy');

  if (mobFeed) mobFeed.classList.remove('active');
  if (mobGrid) mobGrid.classList.remove('active');
  if (mobMy) mobMy.classList.remove('active');

  if (tabName === 'feed' && mobFeed) mobFeed.classList.add('active');
  if (tabName === 'grid' && mobGrid) mobGrid.classList.add('active');
  if (tabName === 'my' && mobMy) mobMy.classList.add('active');

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
  renderServiceStatusNotice();
  renderMain(true);
}

function handleMobileCenterNavClick() {
  if (currentUser) {
    openUserProfile(currentUser.handle);
  } else {
    openAuthModal('login');
  }
}

function renderMain(animate = false) {
  const gridContainer = document.getElementById('gridContainer');
  const feedContainer = document.getElementById('feedContainer');
  const countIndicator = document.getElementById('countIndicator');
  const searchVal = document.getElementById('searchInput').value.trim();

  if (activeTab === 'grid') {
    gridContainer.style.display = 'grid';
    feedContainer.style.display = 'none';
    if (animate) triggerFadeIn(gridContainer);

    let filtered = getFilteredAndSortedLines();
    gridContainer.innerHTML = filtered.map(item => cardHtml(item.line, item.originalIdx)).join('');
    countIndicator.textContent = `Mostrando ${filtered.length} de ${LINEAS_DATA.length} líneas de colectivos del AMBA - Hacé clic en una portada para calificar y dejar reseña`;

  } else if (activeTab === 'feed') {
    gridContainer.style.display = 'none';
    feedContainer.style.display = 'flex';
    if (animate) triggerFadeIn(feedContainer);

    if (searchVal) {
      renderUserSearchResultFeed(feedContainer, countIndicator, searchVal);
    } else {
      renderCommunityFeed(feedContainer, countIndicator);
    }

  } else if (activeTab === 'my') {
    gridContainer.style.display = 'none';
    feedContainer.style.display = 'flex';
    if (animate) triggerFadeIn(feedContainer);

    renderUserFeed(feedContainer, countIndicator, currentUser ? currentUser.handle : null);
  }
}

let searchDebounceTimer = null;
function handleSearch(val) {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    renderMain(false);
  }, 120);
}

function applyFilters() {
  renderMain(false);
}

// User Search in Feed Tab
function renderUserSearchResultFeed(container, indicator, query) {
  const cleanQ = query.toLowerCase().replace(/^@/, '');

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
        <div class="review-card" style="align-items:center; justify-content:space-between; cursor:pointer;" onclick="openUserProfile('${escAttr(handle)}')">
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

// Twitter/X Feed Mode Switcher
function switchFeedMode(mode) {
  if (mode === 'siguiendo' && !currentUser) {
    showToast('Debés iniciar sesión para ver publicaciones de tus seguidos');
    openAuthModal('login');
    return;
  }

  activeFeedMode = mode;
  visibleFeedLimit = 15;
  renderFeedModeTabsUI();
  renderMain(false);
}

function renderFeedModeTabsUI() {
  const tabParaTi = document.getElementById('feedTabParaTi');
  const tabSiguiendo = document.getElementById('feedTabSiguiendo');
  const feedModeTabs = document.getElementById('feedModeTabs');
  const searchVal = document.getElementById('searchInput') ? document.getElementById('searchInput').value.trim() : '';

  if (!feedModeTabs) return;

  if (activeTab === 'feed' && !searchVal) {
    feedModeTabs.style.display = 'flex';
  } else {
    feedModeTabs.style.display = 'none';
  }

  if (tabParaTi && tabSiguiendo) {
    if (activeFeedMode === 'siguiendo') {
      tabParaTi.classList.remove('active');
      tabSiguiendo.classList.add('active');
    } else {
      tabSiguiendo.classList.remove('active');
      tabParaTi.classList.add('active');
    }
  }
}

function loadMoreFeedReviews() {
  visibleFeedLimit += 15;
  renderMain(false);
}

// Render Community Feed (Reverse Chronological Order with Dual Modes & Pagination)
function renderCommunityFeed(container, indicator) {
  const myHandle = currentUser ? currentUser.handle : null;
  const rawFollows = myHandle ? (followsData[myHandle] || (currentUser && Array.isArray(currentUser.following) ? currentUser.following : [])) : [];
  const myFollows = Array.isArray(rawFollows) ? rawFollows.filter(h => !isBlacklistedUser(h)) : [];

  renderFeedModeTabsUI();

  const validRevs = reviewsData.filter(r => !isBlacklistedReview(r));
  validRevs.sort((a, b) => getReviewTimestamp(b) - getReviewTimestamp(a));

  let targetRevs = validRevs; // "Para ti" ALWAYS shows ALL reviews from everyone in the community

  if (activeFeedMode === 'siguiendo') {
    // "Siguiendo" mode ONLY shows reviews from followed users and current user (case-insensitive)
    const followsSet = new Set(myFollows.map(h => String(h).toLowerCase()));
    if (myHandle) followsSet.add(String(myHandle).toLowerCase());

    targetRevs = validRevs.filter(r => {
      if (!r || !r.userHandle) return false;
      return followsSet.has(String(r.userHandle).toLowerCase());
    });
  }

  let html = '';

  if (activeFeedMode === 'para-ti') {
    indicator.textContent = `Mostrando reseñas recientes de toda la comunidad (${targetRevs.length} en total)`;
    if (!currentUser || myFollows.length === 0) {
      html += `
        <div class="feed-recommendation-notice">
          <i class="fa-solid fa-compass" style="font-size:20px; color:var(--accent-blue);"></i>
          <div>
            <div style="font-weight:700; color:#fff;">Todavía no seguís a nadie en Bondibase</div>
            <div style="font-size:12.5px;">Te sugerimos algunas reseñas recientes de la comunidad para empezar a seguir a otros viajeros:</div>
          </div>
        </div>
      `;
    }
  } else {
    // "Siguiendo" mode
    indicator.textContent = `Mostrando publicaciones de tus seguidos (${targetRevs.length} en total)`;
    if (myFollows.length === 0) {
      html += `
        <div class="feed-recommendation-notice">
          <i class="fa-solid fa-compass" style="font-size:20px; color:var(--accent-blue);"></i>
          <div>
            <div style="font-weight:700; color:#fff;">Todavía no seguís a nadie en Bondibase</div>
            <div style="font-size:12.5px;">Acá verás las publicaciones de los viajeros que sigas. ¡Pasate a la solapa "Para ti" para descubrir a quién seguir!</div>
          </div>
        </div>
      `;
    }
  }

  if (targetRevs.length === 0) {
    html += `<div style="text-align:center; padding:40px; color:var(--text-muted);">No hay publicaciones para mostrar en esta sección.</div>`;
    container.innerHTML = html;
    return;
  }

  const visibleRevs = targetRevs.slice(0, visibleFeedLimit);
  html += visibleRevs.map(r => renderReviewCardItem(r)).join('');

  if (targetRevs.length > visibleFeedLimit) {
    const remaining = targetRevs.length - visibleFeedLimit;
    html += `
      <div style="text-align:center; margin:28px 0 16px 0;">
        <button class="btn-load-more" onclick="loadMoreFeedReviews()">
          <span>Cargar más reseñas (${remaining} más)</span>
          <i class="fa-solid fa-chevron-down" style="font-size:12px;"></i>
        </button>
        <div style="font-size:12px; color:var(--text-muted); margin-top:8px;">
          Mostrando ${visibleRevs.length} de ${targetRevs.length} publicaciones
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
}

// Render User Specific Feed
function renderUserFeed(container, indicator, handle) {
  if (!handle || isBlacklistedUser(handle)) return;
  const userRevs = reviewsData.filter(r => r.userHandle === handle && !isBlacklistedReview(r));
  userRevs.sort((a, b) => getReviewTimestamp(b) - getReviewTimestamp(a));
  indicator.textContent = `Portadas y reseñas calificadas por ${handle} (${userRevs.length} en total)`;

  if (userRevs.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">No has calificado ninguna línea aún. Explorá la pestaña Líneas para dejar tu primera opinión.</div>`;
    return;
  }

  container.innerHTML = userRevs.map(r => renderReviewCardItem(r)).join('');
}

// Single Review Item Card Renderer
function renderReviewCardItem(r) {
  if (isBlacklistedReview(r)) return '';

  const line = LINEAS_DATA.find(l => l.numero === r.lineaNumero);
  const isLiked = likesData.has(r.id);
  const friendlyDate = formatDateFriendly(r.date, r);
  const avatarHtml = renderAvatarHtml(r.userHandle, r.userPhoto, 24);

  const myHandle = currentUser ? currentUser.handle : null;
  const isMyOwn = myHandle === r.userHandle;
  const myFollows = myHandle ? (followsData[myHandle] || []) : [];
  const isFollowing = myFollows.includes(r.userHandle);
  const checkMutual = myHandle && isMutual(myHandle, r.userHandle);

  let followBtnHtml = '';
  if (!isMyOwn) {
    followBtnHtml = `
      <button class="btn-follow ${isFollowing ? 'following' : ''}" style="font-size:11px; padding:3px 10px; margin-left:6px;" onclick="event.stopPropagation(); toggleFollowReviewAuthor('${escAttr(r.userHandle)}')">
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
              <div class="review-user" onclick="openUserProfile('${escAttr(r.userHandle)}')">
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
          <div style="display:flex; align-items:center; gap:10px;">
            <button class="like-btn" onclick="captureReviewCard('${r.id}')" title="Compartir recorte de esta reseña">
              <i class="fa-solid fa-share-nodes"></i>
            </button>
            ${isMyOwn ? `<button class="btn-danger-sm" style="font-size:11px; padding:3px 8px; border-radius:12px;" onclick="deleteUserReview('${r.id}')" title="Borrar esta reseña para siempre"><i class="fa-solid fa-trash-can"></i> Borrar</button>` : ''}
            <button class="like-btn ${isLiked ? 'liked' : ''}" onclick="toggleLikeReview('${r.id}')">
              ${isLiked ? '<i class="fa-solid fa-heart" style="color:var(--accent-pink);"></i>' : '<i class="fa-regular fa-heart"></i>'}
              <span>${r.likes || 0}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function deleteUserReview(reviewId) {
  if (!currentUser) return;

  const idx = reviewsData.findIndex(r => r.id === reviewId);
  if (idx === -1) return;

  const targetRev = reviewsData[idx];
  const isReviewOwner = targetRev.userUid ? targetRev.userUid === currentUser.uid : targetRev.userHandle === currentUser.handle;
  if (!isReviewOwner) {
    showToast('No tenés permiso para borrar esta reseña');
    return;
  }

  if (!confirm('¿Estás seguro de que querés borrar esta reseña para siempre? Dejará de contar para la línea.')) {
    return;
  }

  reviewsData.splice(idx, 1);
  try { localStorage.setItem('bondibase_reviews', JSON.stringify(reviewsData)); } catch(e) {}

  if (window.db && window.fb) {
    try {
      await window.fb.deleteDoc(window.fb.doc(window.db, "reviews", reviewId));
    } catch (err) {
      console.warn("Firestore delete review:", err);
    }
  }

  showToast('Reseña eliminada para siempre');

  if (currentModalLine) {
    const stats = getLineStats(currentModalLine.numero);
    document.getElementById('pModalAvgStars').textContent = `${stats.avg} ★`;
    document.getElementById('pModalRatingStars').innerHTML = renderStarsHtml(Math.round(stats.avg));
    document.getElementById('pModalTotalReviewsCount').textContent = `${stats.count} reseña${stats.count === 1 ? '' : 's'} en Bondibase`;
    document.getElementById('reviewTextInput').value = '';
    document.getElementById('formTitle').textContent = 'Dejar tu reseña';
    setFormStars(5);
    renderLineReviewsList(currentModalLine.numero);
  }

  if (currentProfileHandle) {
    openUserProfile(currentProfileHandle);
  }

  renderMain();
}

async function toggleFollowReviewAuthor(targetHandle) {
  if (!currentUser) {
    showToast('Debés iniciar sesión para seguir usuarios');
    openAuthModal('login');
    return;
  }

  const myHandle = currentUser.handle;
  let myFollowing = [...(currentUser.following || [])];

  const idx = myFollowing.indexOf(targetHandle);
  if (idx !== -1) {
    myFollowing.splice(idx, 1);
    showToast(`Dejaste de seguir a ${targetHandle}`);
    if (window.db && window.fb) {
      await window.fb.updateDoc(window.fb.doc(window.db, "users", currentUser.uid), {
        following: window.fb.arrayRemove(targetHandle)
      }).catch(e => console.warn(e));
    }
  } else {
    myFollowing.push(targetHandle);
    showToast(`¡Ahora sigues a ${targetHandle}!`);
    if (window.db && window.fb) {
      await window.fb.updateDoc(window.fb.doc(window.db, "users", currentUser.uid), {
        following: window.fb.arrayUnion(targetHandle)
      }).catch(e => console.warn(e));
    }
  }

  currentUser.following = myFollowing;
  followsData[myHandle] = myFollowing;
  try {
    localStorage.setItem('bondibase_user', JSON.stringify(currentUser));
    localStorage.setItem('bondibase_follows', JSON.stringify(followsData));
  } catch(e) {}

  renderMain();
}

function getTransporteYaUrl(lineaNumero) {
  if (!lineaNumero) return null;
  const str = String(lineaNumero).trim();
  if (!/^[0-9]{1,3}$/.test(str)) {
    return null;
  }
  return `https://transporteya.com.ar/app/${str}`;
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

  // Transporte Ya Direct Integration Link
  const tyUrl = getTransporteYaUrl(l.numero);
  const tyContainer = document.getElementById('transporteYaArea');
  if (tyContainer) {
    if (tyUrl) {
      tyContainer.style.display = 'block';
      tyContainer.innerHTML = `
        <a href="${tyUrl}" target="_blank" rel="noopener" class="btn-transporte-ya" title="Abrir colectivo en vivo en Transporte Ya!">
          <i class="fa-solid fa-location-dot"></i> Ver donde esta la Linea ${esc(stripLoc(l.numero))} en Transporte Ya <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:11px;"></i>
        </a>
      `;
    } else {
      tyContainer.style.display = 'none';
      tyContainer.innerHTML = '';
    }
  }

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

  // Populate Letterboxd-style Rating Distribution Histogram Chart
  const lineRevs = reviewsData.filter(r => r.lineaNumero === l.numero && !isBlacklistedUser(r.userHandle));
  const pHistContainer = document.getElementById('pModalHistogramArea');
  if (pHistContainer) {
    pHistContainer.innerHTML = renderRatingHistogramHtml(lineRevs, 'DISTRIBUCIÓN DE CALIFICACIONES DE LA LÍNEA');
  }

  // Fetch full reviews for this line on-demand in background
  fetchLineReviewsOnDemand(l.numero);

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

// Form Stars & Review Submission (Half-Star Precision System, Min 1.0)
function getStarValueFromEvent(e, starIndex) {
  const rect = e.currentTarget.getBoundingClientRect();
  const clientX = e.clientX != null ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : (rect.left + rect.width));
  const clickX = clientX - rect.left;
  const isLeftHalf = clickX < (rect.width / 2);
  let val = isLeftHalf ? (starIndex - 0.5) : starIndex;
  return Math.max(1.0, Math.min(5, val));
}

function handleStarClick(e, starIndex) {
  const val = getStarValueFromEvent(e, starIndex);
  setFormStars(val);
}

function handleStarHover(e, starIndex) {
  const val = getStarValueFromEvent(e, starIndex);
  renderStarSelectorState(val);
}

function resetStarHover() {
  renderStarSelectorState(selectedFormStars);
}

function renderStarSelectorState(val) {
  const safeVal = Math.max(1.0, Math.min(5, val));
  const displayEl = document.getElementById('starRatingValueDisplay');
  if (displayEl) {
    displayEl.textContent = `${safeVal.toFixed(1)} ★`;
  }

  const spans = document.querySelectorAll('#starSelector span');
  spans.forEach((span, i) => {
    const starNum = i + 1;
    if (starNum <= safeVal) {
      span.innerHTML = '<i class="fa-solid fa-star"></i>';
      span.style.color = 'var(--accent-yellow)';
      span.style.opacity = '1';
    } else if (starNum - 0.5 === safeVal) {
      span.innerHTML = '<i class="fa-solid fa-star-half-stroke"></i>';
      span.style.color = 'var(--accent-yellow)';
      span.style.opacity = '1';
    } else {
      span.innerHTML = '<i class="fa-regular fa-star"></i>';
      span.style.color = '#475569';
      span.style.opacity = '0.4';
    }
  });
}

function setFormStars(val) {
  selectedFormStars = Math.max(1.0, Math.min(5, val));
  renderStarSelectorState(selectedFormStars);
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
  if (checkTemporaryUserGuard()) return;

  // Rate-limiting: mínimo 5 segundos entre publicaciones
  const nowRL = Date.now();
  if (nowRL - lastReviewSubmitTime < 5000) {
    showToast('Esperá unos segundos antes de publicar otra reseña');
    return;
  }
  lastReviewSubmitTime = nowRL;

  const text = document.getElementById('reviewTextInput').value.trim();
  if (!text) {
    showToast('Por favor escribí un comentario breve sobre la línea');
    return;
  }

  const existing = reviewsData.find(r => r.lineaNumero === currentModalLine.numero && r.userHandle === currentUser.handle);
  const docId = existing ? existing.id : ('rev-' + Date.now());
  const oldLikes = existing ? (existing.likes || 0) : 0;
  const oldLikedBy = existing ? (existing.likedBy || []) : [];

  const nowTs = Date.now();
  const reviewDoc = {
    id: docId,
    userUid: currentUser.uid,
    lineaNumero: currentModalLine.numero,
    userHandle: currentUser.handle,
    userPhoto: currentUser.photo || null,
    stars: selectedFormStars,
    text: text,
    likes: oldLikes,
    likedBy: oldLikedBy,
    date: new Date().toISOString(),
    timestamp: nowTs,
    hasTime: true
  };

  const existingIdx = reviewsData.findIndex(r => r.id === docId);
  if (existingIdx !== -1) {
    reviewsData[existingIdx] = reviewDoc;
  } else {
    reviewsData.push(reviewDoc);
  }
  reviewsData.sort((a, b) => getReviewTimestamp(b) - getReviewTimestamp(a));

  try { localStorage.setItem('bondibase_reviews', JSON.stringify(reviewsData)); } catch(e) {}

  if (window.db && window.fb) {
    try {
      await window.fb.setDoc(window.fb.doc(window.db, "reviews", docId), reviewDoc);
    } catch (e) {
      console.warn("Firestore sync:", e);
    }
  }

  if (existing) {
    showToast('Reseña actualizada (se reemplazó tu publicación anterior)');
  } else {
    showToast('¡Reseña publicada con éxito en la comunidad!');
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
  lineRevs.sort((a, b) => getReviewTimestamp(b) - getReviewTimestamp(a));

  if (lineRevs.length === 0) {
    container.innerHTML = `<div style="font-size:13px; color:var(--text-muted); padding:10px 0;">Sé el primero en dejar una reseña sobre esta línea.</div>`;
    return;
  }

  container.innerHTML = lineRevs.map(r => renderReviewCardItem(r)).join('');
}

async function toggleLikeReview(reviewId) {
  if (!currentUser) {
    showToast('Debés iniciar sesión para dar me gusta');
    openAuthModal('login');
    return;
  }
  if (checkTemporaryUserGuard()) return;

  const rev = reviewsData.find(r => r.id === reviewId);
  if (!rev) return;

  const likedByArr = Array.isArray(rev.likedBy) ? [...rev.likedBy] : [];
  const myHandle = currentUser.handle;
  const isLiked = likedByArr.includes(myHandle);

  if (isLiked) {
    likesData.delete(reviewId);
    rev.likes = Math.max(0, (rev.likes || 1) - 1);
    rev.likedBy = likedByArr.filter(h => h !== myHandle);

    if (window.db && window.fb) {
      await window.fb.updateDoc(window.fb.doc(window.db, "reviews", reviewId), {
        likes: rev.likes,
        likedBy: window.fb.arrayRemove(myHandle)
      }).catch(e => console.warn(e));
    }
  } else {
    likesData.add(reviewId);
    rev.likes = (rev.likes || 0) + 1;
    rev.likedBy = [...likedByArr, myHandle];

    if (window.db && window.fb) {
      await window.fb.updateDoc(window.fb.doc(window.db, "reviews", reviewId), {
        likes: rev.likes,
        likedBy: window.fb.arrayUnion(myHandle)
      }).catch(e => console.warn(e));
    }
  }

  try {
    localStorage.setItem('bondibase_likes', JSON.stringify(Array.from(likesData)));
    localStorage.setItem('bondibase_reviews', JSON.stringify(reviewsData));
  } catch(e) {}

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
  avatarContainer.innerHTML = avatarHtml;

  const userRevs = reviewsData.filter(r => r.userHandle === handle && !isBlacklistedUser(r.userHandle));
  userRevs.sort((a, b) => getReviewTimestamp(b) - getReviewTimestamp(a));
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

  const profileShareBtn = document.getElementById('profileShareCardBtn');
  if (profileShareBtn) {
    if (userRevs.length >= 1) {
      profileShareBtn.style.display = 'inline-flex';
    } else {
      profileShareBtn.style.display = 'none';
    }
  }

  // Populate User Rating Histogram Distribution
  const uHistContainer = document.getElementById('userProfileHistogramArea');
  if (uHistContainer) {
    uHistContainer.innerHTML = renderRatingHistogramHtml(userRevs, `DISTRIBUCIÓN DE CALIFICACIONES DE ${handle.toUpperCase()}`);
  }

  const grid = document.getElementById('userReviewsGrid');
  if (userRevs.length === 0) {
    grid.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-muted);">Este usuario no ha calificado ninguna línea aún.</div>`;
  } else {
    grid.innerHTML = userRevs.map(r => renderReviewCardItem(r)).join('');
  }

  // Fetch updated user data and user-specific reviews on-demand in background
  fetchUserProfileOnDemand(handle);
  fetchUserReviewsOnDemand(handle);

  openModal('userProfileModal');
}

// Letterboxd-Style Rating Distribution Histogram Component Generator
function renderRatingHistogramHtml(revs, title = 'DISTRIBUCIÓN DE CALIFICACIONES') {
  if (!revs || revs.length === 0) {
    return '';
  }

  const RATING_STEPS = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
  const counts = { '1.0': 0, '1.5': 0, '2.0': 0, '2.5': 0, '3.0': 0, '3.5': 0, '4.0': 0, '4.5': 0, '5.0': 0 };

  revs.forEach(r => {
    const rawVal = typeof r.stars === 'number' ? r.stars : parseFloat(r.stars) || 5;
    const rounded = Math.round(rawVal * 2) / 2;
    const clamped = Math.max(1.0, Math.min(5.0, rounded));
    const key = clamped.toFixed(1);
    counts[key] = (counts[key] || 0) + 1;
  });

  const total = revs.length;
  const maxCount = Math.max(1, ...Object.values(counts));

  let barsHtml = '';
  let labelsHtml = '';

  RATING_STEPS.forEach(step => {
    const key = step.toFixed(1);
    const count = counts[key] || 0;
    
    // Direct percentage of maxCount (0 votes -> 4% flat line, >0 votes -> (count/maxCount)*100%)
    let heightPct = 4;
    if (count > 0 && maxCount > 0) {
      heightPct = Math.max(12, (count / maxCount) * 100);
    }

    const pctOfTotal = total > 0 ? ((count / total) * 100).toFixed(1) : '0';
    const titleText = `${key} ★: ${count} reseña${count === 1 ? '' : 's'} (${pctOfTotal}%)`;
    const labelStr = step % 1 === 0 ? step.toFixed(0) : '.5';

    barsHtml += `
      <div class="histogram-bar-col" title="${titleText}">
        <div class="histogram-bar-fill" style="height: ${heightPct.toFixed(1)}%;">
          ${count > 0 ? `<span class="bar-count-tooltip">${count}</span>` : ''}
        </div>
      </div>
    `;

    labelsHtml += `<span class="histogram-step-label">${labelStr}</span>`;
  });

  return `
    <div class="rating-histogram-card">
      <div class="histogram-header-row">
        <span class="histogram-title">${title}</span>
        <span class="histogram-count-badge">${total} reseña${total === 1 ? '' : 's'}</span>
      </div>
      
      <div class="histogram-chart-wrapper">
        <div class="histogram-star-edge left">★</div>
        
        <div class="histogram-main-body">
          <div class="histogram-bars-track">
            ${barsHtml}
          </div>
          <div class="histogram-labels-track">
            ${labelsHtml}
          </div>
        </div>

        <div class="histogram-star-edge right">★★★★★</div>
      </div>
    </div>
  `;
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

  if (usersMap[newHandle]) {
    showToast(`El usuario ${newHandle} ya existe. Elegí otro.`);
    return;
  }

  const uData = usersMap[oldHandle] || {};
  const currentCount = currentUser.usernameChangesCount || 0;
  
  const updatedUserDoc = {
    ...uData,
    uid: currentUser.uid,
    handle: newHandle,
    usernameChangesCount: currentCount + 1,
    lastUsernameChangeDate: new Date().toISOString()
  };

  currentUser.handle = newHandle;
  currentUser.usernameChangesCount = currentCount + 1;
  currentUser.lastUsernameChangeDate = updatedUserDoc.lastUsernameChangeDate;

  // Limpiar handle viejo del mapa local y registrar el nuevo
  delete usersMap[oldHandle];
  usersMap[newHandle] = updatedUserDoc;
  usersByUidMap[currentUser.uid] = updatedUserDoc;

  // Actualizar handle en reseñas locales
  reviewsData.forEach(r => {
    if (r.userHandle === oldHandle) r.userHandle = newHandle;
  });

  // Migrar followsData local al nuevo handle
  if (followsData[oldHandle]) {
    followsData[newHandle] = followsData[oldHandle];
    delete followsData[oldHandle];
  }
  Object.keys(followsData).forEach(h => {
    const list = followsData[h];
    if (Array.isArray(list)) {
      const idx = list.indexOf(oldHandle);
      if (idx !== -1) list[idx] = newHandle;
    }
  });

  try {
    localStorage.setItem('bondibase_user', JSON.stringify(currentUser));
    localStorage.setItem('bondibase_users', JSON.stringify(usersMap));
    localStorage.setItem('bondibase_reviews', JSON.stringify(reviewsData));
    localStorage.setItem('bondibase_follows', JSON.stringify(followsData));
  } catch(e) {}

  if (window.db && window.fb) {
    try {
      await window.fb.setDoc(window.fb.doc(window.db, "users", currentUser.uid), updatedUserDoc, { merge: true });

      const reviewUpdates = reviewsData
        .filter(r => r.userUid === currentUser.uid)
        .map(r => window.fb.updateDoc(window.fb.doc(window.db, "reviews", r.id), { userHandle: newHandle }));
      await Promise.all(reviewUpdates);
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

async function toggleFollowUser() {
  if (!currentUser) {
    showToast('Debés iniciar sesión para seguir usuarios');
    openAuthModal('login');
    return;
  }
  if (checkTemporaryUserGuard()) return;

  const myHandle = currentUser.handle;
  let myFollowing = [...(currentUser.following || [])];

  const idx = myFollowing.indexOf(currentProfileHandle);
  if (idx !== -1) {
    myFollowing.splice(idx, 1);
    showToast(`Dejaste de seguir a ${currentProfileHandle}`);
    if (window.db && window.fb) {
      await window.fb.updateDoc(window.fb.doc(window.db, "users", currentUser.uid), {
        following: window.fb.arrayRemove(currentProfileHandle)
      }).catch(e => console.warn(e));
    }
  } else {
    myFollowing.push(currentProfileHandle);
    showToast(`¡Ahora sigues a ${currentProfileHandle}!`);
    if (window.db && window.fb) {
      await window.fb.updateDoc(window.fb.doc(window.db, "users", currentUser.uid), {
        following: window.fb.arrayUnion(currentProfileHandle)
      }).catch(e => console.warn(e));
    }
  }

  currentUser.following = myFollowing;
  followsData[myHandle] = myFollowing;
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
        actionBtn = `<button class="btn-danger-sm" onclick="unfollowTargetUser('${escAttr(handle)}')"><i class="fa-solid fa-user-minus"></i> Dejar de seguir</button>`;
      } else if (activeUserListTab === 'followers') {
        actionBtn = `<button class="btn-danger-sm" onclick="removeFollowerUser('${escAttr(handle)}')"><i class="fa-solid fa-user-xmark"></i> Eliminar seguidor</button>`;
      }
    } else {
      if (currentUser && currentUser.handle !== handle) {
        actionBtn = `<button class="btn-follow ${iFollowThem ? 'following' : ''}" onclick="toggleFollowOtherUser('${escAttr(handle)}')">
          ${iFollowThem ? 'Siguiendo' : '+ Seguir'}
        </button>`;
      }
    }

    return `
      <div class="review-card" style="align-items:center; justify-content:space-between; padding:12px 14px;">
        <div style="display:flex; align-items:center; gap:12px; cursor:pointer;" onclick="openUserProfile('${escAttr(handle)}')">
          ${avatarHtml}
          <div>
            <div style="font-weight:700; font-size:14px; color:#fff;">${esc(handle)}</div>
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          ${actionBtn}
          <button class="btn-nav-link" style="font-size:12px; padding:4px 8px;" onclick="openUserProfile('${escAttr(handle)}')">Ver perfil</button>
        </div>
      </div>
    `;
  }).join('');
}

async function unfollowTargetUser(targetHandle) {
  if (!currentUser) return;
  const myHandle = currentUser.handle;

  let myFollowing = [...(currentUser.following || [])];
  const idx = myFollowing.indexOf(targetHandle);
  if (idx !== -1) {
    myFollowing.splice(idx, 1);
    currentUser.following = myFollowing;
    followsData[myHandle] = myFollowing;

    if (window.db && window.fb) {
      await window.fb.updateDoc(window.fb.doc(window.db, "users", currentUser.uid), {
        following: window.fb.arrayRemove(targetHandle)
      }).catch(e => console.warn(e));
    }

    showToast(`Dejaste de seguir a ${targetHandle}`);
    openUserProfile(currentUser.handle);
    openUserListModal('following');
  }
}

async function removeFollowerUser(targetHandle) {
  if (!currentUser) return;
  const myHandle = currentUser.handle;

  const followerUserDoc = Object.values(usersMap).find(u => u.handle === targetHandle);
  if (followerUserDoc && followerUserDoc.uid && window.db && window.fb) {
    await window.fb.updateDoc(window.fb.doc(window.db, "users", followerUserDoc.uid), {
      following: window.fb.arrayRemove(myHandle)
    }).catch(e => console.warn(e));
  }

  showToast(`Eliminaste a ${targetHandle} de tus seguidores`);
  openUserProfile(currentUser.handle);
  openUserListModal('followers');
}

async function toggleFollowOtherUser(targetHandle) {
  if (!currentUser) {
    showToast('Debés iniciar sesión para seguir usuarios');
    openAuthModal('login');
    return;
  }

  const myHandle = currentUser.handle;
  let myFollowing = [...(currentUser.following || [])];

  const idx = myFollowing.indexOf(targetHandle);
  if (idx !== -1) {
    myFollowing.splice(idx, 1);
    showToast(`Dejaste de seguir a ${targetHandle}`);
    if (window.db && window.fb) {
      await window.fb.updateDoc(window.fb.doc(window.db, "users", currentUser.uid), {
        following: window.fb.arrayRemove(targetHandle)
      }).catch(e => console.warn(e));
    }
  } else {
    myFollowing.push(targetHandle);
    showToast(`¡Ahora sigues a ${targetHandle}!`);
    if (window.db && window.fb) {
      await window.fb.updateDoc(window.fb.doc(window.db, "users", currentUser.uid), {
        following: window.fb.arrayUnion(targetHandle)
      }).catch(e => console.warn(e));
    }
  }

  currentUser.following = myFollowing;
  followsData[myHandle] = myFollowing;
  renderUserListItems();
}

// Toast Notification
function showToast(msg) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast-notice';
  toast.innerHTML = `<i class="fa-solid fa-bus-simple" style="color:var(--accent-blue);"></i> <span>${esc(msg)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Viral / Open Source Notice Modal Manager
function checkViralNoticeModal() {
  try {
    const hideNotice = localStorage.getItem('bondibase_hide_opensource_v1');
    if (hideNotice !== 'true') {
      setTimeout(() => {
        openModal('viralNoticeModal');
      }, 500);
    }
  } catch (e) {}
}

function closeViralNoticeModal() {
  const checkbox = document.getElementById('dontShowNoticeCheckbox');
  if (checkbox && checkbox.checked) {
    try {
      localStorage.setItem('bondibase_hide_opensource_v1', 'true');
    } catch (e) {}
  }
  closeModal('viralNoticeModal');
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
    closeViralNoticeModal();
  }
});

// ----------------------------------------------------
// CANVAS IMAGE GENERATORS & NATIVE SHARE SYSTEM
// ----------------------------------------------------
async function shareOrDownloadImage(blob, filename, title, text) {
  if (!blob) {
    showToast('Error al generar la imagen');
    return;
  }
  const file = new File([blob], filename, { type: 'image/png' });
  
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        title: title || 'Bondibase AMBA',
        text: text || 'Mirá esta bitácora en Bondibase',
        files: [file]
      });
      showToast('¡Imagen compartida con éxito!');
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn("Navigator share cancelado o no disponible, descargando imagen...", err);
    }
  }

  // Instant PNG Download Fallback
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('¡Imagen descargada con éxito!');
}

function drawCanvasTextWrapped(ctx, text, x, y, maxWidth, lineHeight, maxLines = 5) {
  const words = text.split(' ');
  let line = '';
  let currentY = y;
  let linesCount = 0;

  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && n > 0) {
      linesCount++;
      if (linesCount >= maxLines) {
        ctx.fillText(line.trim() + '...', x, currentY);
        return currentY + lineHeight;
      }
      ctx.fillText(line.trim(), x, currentY);
      line = words[n] + ' ';
      currentY += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line.trim(), x, currentY);
  return currentY + lineHeight;
}

// CAPTURE USER PROFILE CARD GENERATOR
async function captureUserProfileCard(handle) {
  if (!handle) return;
  const userRevs = reviewsData.filter(r => r.userHandle === handle && !isBlacklistedUser(r.userHandle));
  if (userRevs.length < 1) {
    showToast('El usuario debe tener al menos 1 reseña para capturar su perfil');
    return;
  }
  userRevs.sort((a, b) => getReviewTimestamp(b) - getReviewTimestamp(a));

  showToast('Generando imagen de perfil...');

  const uData = usersMap[handle] || {};
  const cols = Math.min(4, Math.max(2, userRevs.length));
  const cardW = 150;
  const cardH = 140;
  const gap = 16;
  const padding = 28;

  const rows = Math.ceil(userRevs.length / cols);
  const canvasW = (padding * 2) + (cols * cardW) + ((cols - 1) * gap);
  const headerH = 140;
  const footerH = 50;
  const canvasH = headerH + (rows * (cardH + gap)) + footerH + padding;

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');

  // Background Gradient
  const bgGrad = ctx.createLinearGradient(0, 0, canvasW, canvasH);
  bgGrad.addColorStop(0, '#0f172a');
  bgGrad.addColorStop(1, '#1e293b');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Outer Border Accent Line
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 10, canvasW - 20, canvasH - 20);

  // Brand Logo Top Right
  ctx.font = '900 20px "Stack Sans Text", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'right';
  ctx.fillText('bondibase • AMBA', canvasW - padding, 45);

  // User Header Left
  ctx.textAlign = 'left';
  ctx.font = '800 22px "Stack Sans Text", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(handle, padding, 45);

  ctx.font = '500 13px "Stack Sans Text", sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`${userRevs.length} línea${userRevs.length === 1 ? '' : 's'} calificada${userRevs.length === 1 ? '' : 's'} en la comunidad`, padding, 68);

  if (uData.bio) {
    ctx.font = 'italic 12px "Stack Sans Text", sans-serif';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(`"${uData.bio.substring(0, 60)}${uData.bio.length > 60 ? '...' : ''}"`, padding, 88);
  }

  // Divider Line
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.beginPath();
  ctx.moveTo(padding, headerH - 20);
  ctx.lineTo(canvasW - padding, headerH - 20);
  ctx.stroke();

  // Draw Grid of Mini Posters
  let index = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (index >= userRevs.length) break;
      const rev = userRevs[index];
      const line = LINEAS_DATA.find(l => l.numero === rev.lineaNumero);

      const x = padding + (c * (cardW + gap));
      const y = headerH + (r * (cardH + gap));

      const colores = (line && line.colores) || {};
      const topCol = colores.superior || '#3b82f6';
      const botCol = colores.inferior || '#1d4ed8';

      const posterGrad = ctx.createLinearGradient(x, y, x, y + 90);
      posterGrad.addColorStop(0, topCol);
      posterGrad.addColorStop(0.4, topCol);
      posterGrad.addColorStop(0.401, botCol);
      posterGrad.addColorStop(1, botCol);

      ctx.fillStyle = posterGrad;
      ctx.beginPath();
      ctx.roundRect(x, y, cardW, 90, [10, 10, 4, 4]);
      ctx.fill();

      // Border top
      ctx.strokeStyle = colores.borde || '#000000';
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, cardW, 3);

      // Line Number
      const textCol = colores.texto || getContrastColor(botCol);
      ctx.fillStyle = textCol;
      ctx.font = '900 26px "Stack Sans Text", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(stripLoc(rev.lineaNumero), x + (cardW / 2), y + 54);

      // Admin Tag Top
      ctx.font = '700 9px "Stack Sans Text", sans-serif';
      ctx.fillStyle = getContrastColor(topCol);
      ctx.fillText(line ? line.administracion : 'Línea', x + (cardW / 2), y + 16);

      // Operator Bottom
      ctx.font = '500 8px "Stack Sans Text", sans-serif';
      ctx.fillStyle = textCol;
      ctx.fillText(line && line.operadora ? line.operadora.substring(0, 18) : '', x + (cardW / 2), y + 80);

      // Rating Stars Pill Below
      ctx.fillStyle = 'rgba(245, 158, 11, 0.15)';
      ctx.beginPath();
      ctx.roundRect(x + 10, y + 100, cardW - 20, 26, 13);
      ctx.fill();

      ctx.fillStyle = '#fbbf24';
      ctx.font = '800 13px "Stack Sans Text", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`★ ${rev.stars.toFixed(1)}`, x + (cardW / 2), y + 117);

      index++;
    }
  }

  // Footer Watermark
  ctx.fillStyle = '#64748b';
  ctx.font = '600 11px "Stack Sans Text", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('bondibase.vercel.app • Tu bitácora de colectivos del AMBA', canvasW / 2, canvasH - 18);

  canvas.toBlob(blob => {
    shareOrDownloadImage(blob, `bondibase-perfil-${handle.replace('@','')}.png`, `Bitácora de ${handle} en Bondibase`, `¡Mirá mis líneas calificadas en Bondibase!`);
  }, 'image/png');
}

// CAPTURE INDIVIDUAL REVIEW CARD GENERATOR
async function captureReviewCard(reviewId) {
  const rev = reviewsData.find(r => r.id === reviewId);
  if (!rev) return;

  showToast('Generando recorte de reseña...');

  const line = LINEAS_DATA.find(l => l.numero === rev.lineaNumero);
  const canvasW = 760;
  const canvasH = 380;

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');

  // Background Gradient
  const bgGrad = ctx.createLinearGradient(0, 0, canvasW, canvasH);
  bgGrad.addColorStop(0, '#0f172a');
  bgGrad.addColorStop(1, '#1e293b');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Border Accent Line
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 10, canvasW - 20, canvasH - 20);

  // Left Column: Mini Poster Card
  const posterW = 180;
  const posterH = 270;
  const posterX = 36;
  const posterY = 40;

  const colores = (line && line.colores) || {};
  const topCol = colores.superior || '#3b82f6';
  const botCol = colores.inferior || '#1d4ed8';

  const posterGrad = ctx.createLinearGradient(posterX, posterY, posterX, posterY + posterH);
  posterGrad.addColorStop(0, topCol);
  posterGrad.addColorStop(0.38, topCol);
  posterGrad.addColorStop(0.381, botCol);
  posterGrad.addColorStop(1, botCol);

  ctx.fillStyle = posterGrad;
  ctx.beginPath();
  ctx.roundRect(posterX, posterY, posterW, posterH, [16, 16, 16, 16]);
  ctx.fill();

  ctx.strokeStyle = colores.borde || '#000000';
  ctx.lineWidth = 4;
  ctx.strokeRect(posterX, posterY, posterW, 4);

  // Poster Tag Top
  ctx.textAlign = 'center';
  ctx.font = '800 13px "Stack Sans Text", sans-serif';
  ctx.fillStyle = getContrastColor(topCol);
  ctx.fillText(line ? line.administracion : 'Línea', posterX + (posterW / 2), posterY + 36);

  // Poster Line Number
  const textCol = colores.texto || getContrastColor(botCol);
  ctx.font = '900 52px "Stack Sans Text", sans-serif';
  ctx.fillStyle = textCol;
  ctx.fillText(stripLoc(rev.lineaNumero), posterX + (posterW / 2), posterY + 160);

  // Poster Operator
  ctx.font = '600 11px "Stack Sans Text", sans-serif';
  ctx.fillStyle = textCol;
  ctx.fillText(line && line.operadora ? line.operadora.substring(0, 24) : '', posterX + (posterW / 2), posterY + 245);

  // Right Column: Author, Line Title, Comment, Rating
  const rightX = posterX + posterW + 36;
  const rightW = canvasW - rightX - 36;

  // Author handle & Date
  ctx.textAlign = 'left';
  ctx.font = '800 20px "Stack Sans Text", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(rev.userHandle, rightX, posterY + 24);

  ctx.font = '500 12px "Stack Sans Text", sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(formatDateFriendly(rev.date), rightX, posterY + 44);

  // Rating Badge Right
  ctx.fillStyle = 'rgba(245, 158, 11, 0.15)';
  ctx.beginPath();
  ctx.roundRect(canvasW - 130, posterY + 8, 94, 32, 16);
  ctx.fill();

  ctx.fillStyle = '#fbbf24';
  ctx.font = '800 15px "Stack Sans Text", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`★ ${rev.stars.toFixed(1)}`, canvasW - 83, posterY + 30);

  // Line Title
  ctx.textAlign = 'left';
  ctx.font = '700 15px "Stack Sans Text", sans-serif';
  ctx.fillStyle = '#60a5fa';
  ctx.fillText(`Línea ${rev.lineaNumero} ${line ? '- ' + line.operadora : ''}`, rightX, posterY + 84);

  // Review Comment Text
  ctx.font = '400 15px "Stack Sans Text", sans-serif';
  ctx.fillStyle = '#f8fafc';
  drawCanvasTextWrapped(ctx, `"${rev.text}"`, rightX, posterY + 118, rightW, 22, 5);

  // Footer Watermark
  ctx.fillStyle = '#64748b';
  ctx.font = '600 12px "Stack Sans Text", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('bondibase.vercel.app • Reseñas de colectivos del AMBA', canvasW / 2, canvasH - 20);

  canvas.toBlob(blob => {
    shareOrDownloadImage(blob, `bondibase-resena-linea-${rev.lineaNumero}.png`, `Reseña de Línea ${rev.lineaNumero} por ${rev.userHandle}`, `"${rev.text.substring(0,60)}..." en Bondibase`);
  }, 'image/png');
}

// Run application on DOM loaded
document.addEventListener('DOMContentLoaded', initApp);
