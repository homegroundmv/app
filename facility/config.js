// Home Ground Facility app — settings.
// BACKEND_URL is the Web app URL from the Facility Log's Apps Script
// (Deploy > Manage deployments > Web app URL, ends in /exec). Not the Office Registry's.
window.HG_CONFIG = {
  // Push notifications: the same Firebase project and Web Push key as the hunter and landowner apps.
  FIREBASE: {
    apiKey: 'AIzaSyBPIsgYnG1eYvR5awv--JIiTWKwMHq-Zs8',
    authDomain: 'home-ground-87902.firebaseapp.com',
    projectId: 'home-ground-87902',
    storageBucket: 'home-ground-87902.firebasestorage.app',
    messagingSenderId: '370205411039',
    appId: '1:370205411039:web:48de69c3c00927057c4b6a'
  },
  VAPID_KEY: 'BN3wID84La3Qfs-JzMtkIyTmj6a54tqkB6E5Jdgg4gzE-aQqFKua07CtoR0eC_XVPegfPU3ijWBkwokZhW7oJwY',
  BACKEND_URL: 'https://script.google.com/macros/s/AKfycbwJbxYLDa5uAXwuHI_kF7vD_Panq2ZxNNV2EFofWqJAZkQRWy0j9Ns7ceKQ4-8zwUo3/exec',
  OFFICE_PHONE: '508-208-4871'
};
